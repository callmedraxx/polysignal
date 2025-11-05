import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { AppDataSource } from "../config/database.js";
import { CopyTradePosition } from "../entities/CopyTradePosition.js";
import { CopyTradeWallet } from "../entities/CopyTradeWallet.js";
import path from "path";
import fs from "fs";

interface SpreadsheetConfig {
  freeSpreadsheetId?: string;
  paidSpreadsheetId?: string;
  freeAggregateSpreadsheetId?: string;
  paidAggregateSpreadsheetId?: string;
  folderId?: string; // Google Drive folder ID where spreadsheets will be created
}

interface PositionData {
  walletAddress: string;
  traderName?: string;
  subscriptionType: string;
  outcomeChosen?: string;
  marketName?: string; // Market name from trade
  realizedOutcome?: string;
  entryDateTime: Date;
  entryPrice: string | number;
  simulatedInvestment: number;
  traderUsdValue?: number; // Actual USD value the trader invested
  sharesBought: string | number;
  exitDate?: Date;
  exitPrice?: string | number;
  sharesSold?: string | number;
  realizedPnl?: string | number;
  percentPnl?: number;
  finalValue?: number;
  status: string;
  hoursHeld?: number;
  positionId?: string; // For tracking row updates
  conditionId?: string; // For generating position group ID
  outcomeIndex?: number; // For generating position group ID
}

interface QueuedPosition {
  data: PositionData;
  positionGroupId: string;
  sheetName: string;
  spreadsheetId: string;
}

class GoogleSheetsService {
  private auth: any = null;
  private sheets: any = null;
  private drive: any = null;
  private isInitialized: boolean = false;
  private config: SpreadsheetConfig = {};
  private lastApiCallTime: number = 0;
  private readonly rateLimitDelayMs: number = 100; // 100ms delay between API calls (100 requests per 10 seconds max)
  private verifiedSpreadsheets: Set<string> = new Set(); // Cache for verified spreadsheets
  private traderSheetCache: Map<string, boolean> = new Map(); // Cache for existing trader sheets
  
  // Batching system for reducing API calls
  private positionQueue: QueuedPosition[] = [];
  private batchFlushTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE: number = 10; // Flush when queue reaches this size
  private readonly BATCH_TIMEOUT_MS: number = 5000; // Flush every 5 seconds
  private isFlushing: boolean = false;

  /**
   * Initialize Google Sheets API client
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const enabled = process.env.GOOGLE_SHEETS_ENABLED === "true";
    if (!enabled) {
      console.log("📊 Google Sheets integration is disabled (GOOGLE_SHEETS_ENABLED is not 'true')");
      console.log(`   Current value: "${process.env.GOOGLE_SHEETS_ENABLED}"`);
      return;
    }

    try {
      const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || "./google-service-account.json";
      const absolutePath = path.resolve(process.cwd(), serviceAccountPath);

      console.log(`📊 Checking for Google Service Account file at: ${absolutePath}`);

      if (!fs.existsSync(absolutePath)) {
        console.warn(`⚠️  Google Service Account file not found at ${absolutePath}`);
        console.warn("   Google Sheets integration will be disabled");
        console.warn("   Please ensure the service account JSON file exists or set GOOGLE_SERVICE_ACCOUNT_PATH");
        return;
      }

      console.log(`✅ Found Google Service Account file at ${absolutePath}`);

      const serviceAccount = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
      
      // Log service account email for debugging
      const serviceAccountEmail = serviceAccount.client_email;
      console.log(`📧 Service Account Email: ${serviceAccountEmail}`);
      console.log(`   ⚠️  Make sure this email has access to create spreadsheets or use existing spreadsheet IDs`);

      this.auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: [
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/drive",
        ],
      });

      const authClient = await this.auth.getClient();
      this.sheets = google.sheets({ version: "v4", auth: authClient });
      this.drive = google.drive({ version: "v3", auth: authClient });

      // Load configuration
      this.config = {
        freeSpreadsheetId: process.env.GOOGLE_SHEETS_FREE_SPREADSHEET_ID,
        paidSpreadsheetId: process.env.GOOGLE_SHEETS_PAID_SPREADSHEET_ID,
        freeAggregateSpreadsheetId: process.env.GOOGLE_SHEETS_FREE_AGGREGATE_SPREADSHEET_ID,
        paidAggregateSpreadsheetId: process.env.GOOGLE_SHEETS_PAID_AGGREGATE_SPREADSHEET_ID,
        folderId: process.env.GOOGLE_SHEETS_FOLDER_ID, // Optional: folder where spreadsheets will be created
      };

      if (this.config.folderId) {
        console.log(`📁 Spreadsheets will be created in folder ID: ${this.config.folderId}`);
        console.log(`   Make sure this folder is shared with the service account (${serviceAccountEmail}) with Editor access`);
      }

      // Ensure spreadsheets exist or create them
      try {
        await this.ensureSpreadsheetsExist();
      } catch (ensureError: any) {
        // Handle quota exceeded or other errors gracefully
        if (ensureError?.code === 403 && ensureError?.message?.includes("quota")) {
          console.warn("⚠️  Google Drive storage quota exceeded. Spreadsheets will not be auto-created.");
          console.warn("   Please provide existing spreadsheet IDs via environment variables:");
          console.warn("   - GOOGLE_SHEETS_FREE_SPREADSHEET_ID");
          console.warn("   - GOOGLE_SHEETS_PAID_SPREADSHEET_ID");
          console.warn("   Or free up space in Google Drive and restart the service.");
          
          // If spreadsheet IDs are provided, we can still use them
          if (this.config.freeSpreadsheetId || this.config.paidSpreadsheetId) {
            console.log("✅ Using existing spreadsheet IDs from environment variables");
            this.isInitialized = true;
            console.log("✅ Google Sheets service initialized (using existing spreadsheets)");
            return;
          } else {
            console.warn("⚠️  No spreadsheet IDs provided. Google Sheets integration will be limited.");
            // Don't initialize - appendPosition will handle this gracefully
            return;
          }
        } else {
          // Re-throw other errors
          throw ensureError;
        }
      }

      this.isInitialized = true;
      console.log("✅ Google Sheets service initialized");
      
      // Setup graceful shutdown to flush pending writes
      process.on('SIGTERM', async () => {
        await this.flushAllBatches();
        process.exit(0);
      });
      process.on('SIGINT', async () => {
        await this.flushAllBatches();
        process.exit(0);
      });
    } catch (error) {
      console.error("❌ Failed to initialize Google Sheets service:", error);
      // Don't throw - allow server to continue without Google Sheets
      console.warn("⚠️  Server will continue without Google Sheets integration");
      this.isInitialized = false;
    }
  }

  /**
   * Ensure spreadsheets exist, create if they don't
   */
  private async ensureSpreadsheetsExist(): Promise<void> {
    const mainSheetName = process.env.GOOGLE_SHEETS_MAIN_SHEET_NAME || "CopyTrade Positions";
    const aggregateSheetName = process.env.GOOGLE_SHEETS_AGGREGATE_SHEET_NAME || "Summary";

    // Free signals spreadsheet
    if (!this.config.freeSpreadsheetId) {
      console.log("📊 Creating free signals spreadsheet...");
      this.config.freeSpreadsheetId = await this.createSpreadsheet("PolySignal CopyTrade - Free Signals");
      console.log(`   Created free spreadsheet: ${this.config.freeSpreadsheetId}`);
    } else {
      console.log(`   ✅ Using existing free spreadsheet: ${this.config.freeSpreadsheetId}`);
    }

    // Paid signals spreadsheet
    if (!this.config.paidSpreadsheetId) {
      console.log("📊 Creating paid signals spreadsheet...");
      this.config.paidSpreadsheetId = await this.createSpreadsheet("PolySignal CopyTrade - Paid Signals");
      console.log(`   Created paid spreadsheet: ${this.config.paidSpreadsheetId}`);
    } else {
      console.log(`   ✅ Using existing paid spreadsheet: ${this.config.paidSpreadsheetId}`);
    }

    // Note: Individual trader sheets will be created on-demand when positions are added
    console.log(`   📊 Trader sheets will be created automatically when positions are added`);

    // Free aggregate spreadsheet (optional)
    if (this.config.freeAggregateSpreadsheetId) {
      await this.ensureAggregateSheetsExist(this.config.freeAggregateSpreadsheetId, aggregateSheetName);
    }

    // Paid aggregate spreadsheet (optional)
    if (this.config.paidAggregateSpreadsheetId) {
      await this.ensureAggregateSheetsExist(this.config.paidAggregateSpreadsheetId, aggregateSheetName);
    }
  }

  /**
   * Create a new spreadsheet
   * If folderId is configured, creates the spreadsheet inside that folder
   */
  private async createSpreadsheet(title: string): Promise<string> {
    try {
      const requestBody: any = {
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
      };

      // If folder ID is provided, create spreadsheet inside that folder
      // This uses the user's quota instead of service account quota
      if (this.config.folderId) {
        requestBody.parents = [this.config.folderId];
        console.log(`   📁 Creating spreadsheet "${title}" in folder ${this.config.folderId}...`);
      } else {
        console.log(`   📊 Creating spreadsheet "${title}" in root Drive...`);
      }

      const response = await this.drive.files.create({
        requestBody,
      });

      if (!response.data.id) {
        throw new Error("Failed to create spreadsheet: No ID returned");
      }

      const spreadsheetId = response.data.id;
      const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
      
      if (this.config.folderId) {
        console.log(`   ✅ Created spreadsheet in folder: ${spreadsheetUrl}`);
      } else {
        console.log(`   ✅ Created spreadsheet: ${spreadsheetUrl}`);
      }

      return spreadsheetId;
    } catch (error: any) {
      console.error(`❌ Failed to create spreadsheet "${title}":`, error);
      
      // Provide helpful error messages for common issues
      if (error?.code === 403) {
        const errorMessage = error?.message || error?.cause?.message || "";
        const errorDetails = error?.response?.data?.error?.message || errorMessage;
        
        if (errorMessage.includes("quota") || errorDetails.includes("quota")) {
          console.error(`   📊 Quota Error Details: ${errorDetails}`);
          console.error(`   💡 Possible causes:`);
          console.error(`      - Service account has reached its storage quota`);
          console.error(`      - Organization/workspace has quota limits`);
          console.error(`      - API quota exceeded (requests per day/minute)`);
          console.error(`   💡 Solutions:`);
          console.error(`      1. Use existing spreadsheet IDs (set GOOGLE_SHEETS_FREE_SPREADSHEET_ID and GOOGLE_SHEETS_PAID_SPREADSHEET_ID)`);
          console.error(`      2. Check service account quota in Google Cloud Console`);
          console.error(`      3. Share existing spreadsheets with service account email`);
          
          const quotaError = new Error(
            `Google Drive quota error: ${errorDetails}. ` +
            `This may be a service account quota limit, not your personal account storage. ` +
            `Try using existing spreadsheet IDs instead.`
          );
          (quotaError as any).code = 403;
          throw quotaError;
        } else if (errorMessage.includes("permission") || errorDetails.includes("permission")) {
          console.error(`   📊 Permission Error Details: ${errorDetails}`);
          console.error(`   💡 Make sure the service account has permission to create files in Google Drive`);
          throw new Error(`Permission denied: ${errorDetails}. Service account may not have access to create spreadsheets.`);
        } else {
          // Generic 403 error
          console.error(`   📊 403 Forbidden Error Details: ${errorDetails}`);
          console.error(`   💡 This could be quota, permission, or API limit issue`);
          throw new Error(`Google Drive API error (403): ${errorDetails}`);
        }
      }
      
      throw error;
    }
  }

  /**
   * Sanitize trader name for use as sheet name
   * Google Sheets sheet names have restrictions:
   * - Max 100 characters
   * - Cannot contain: / \ ? * [ ]
   * - Cannot be empty
   */
  private sanitizeSheetName(traderName?: string, walletAddress?: string): string {
    // Use trader name if available, otherwise use wallet address
    const name = traderName || walletAddress || "Unknown Trader";
    
    // Remove invalid characters
    let sanitized = name.replace(/[\/\\\?\*\[\]]/g, "");
    
    // Truncate to 100 characters (Google Sheets limit)
    if (sanitized.length > 100) {
      sanitized = sanitized.substring(0, 100);
    }
    
    // Ensure it's not empty
    if (!sanitized.trim()) {
      sanitized = walletAddress ? walletAddress.substring(0, 100) : "Unknown Trader";
    }
    
    return sanitized.trim();
  }

  /**
   * Setup trader sheet with headers and formatting
   * Only overwrites headers if they don't match expected format
   */
  private async setupTraderSheet(spreadsheetId: string, sheetName: string): Promise<void> {
    try {
      // Check if sheet already exists
      const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
      const sheetExists = spreadsheet.data.sheets?.some((s: any) => s.properties.title === sheetName);
      
      if (!sheetExists) {
        // Create sheet if it doesn't exist
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: sheetName,
                    gridProperties: {
                      rowCount: 1000,
                      columnCount: 21, // Includes Market, Trader USD Value, and Position Group columns
                    },
                  },
                },
              },
            ],
          },
        });
      }

      // Expected headers (including Market and Trader USD Value, and Position Group for filtering related trades)
      const expectedHeaders = [
        "Wallet Address",
        "Trader Name",
        "Subscription Type",
        "Outcome Chosen",
        "Market", // Market name
        "Realized Outcome",
        "Entry Date/Time",
        "Entry Price",
        "Simulated Investment",
        "Trader USD Value", // Actual USD value the trader invested
        "Shares Bought",
        "Exit Date",
        "Exit Price",
        "Shares Sold",
        "Realized PnL",
        "Percent PnL",
        "Final Value",
        "ROI",
        "Status",
        "Hours Held",
        "Position Group", // Links related trades together (e.g., "open" + "added" trades) for easy filtering
      ];

      // Check if headers already exist and match
      let headersMatch = false;
      if (sheetExists) {
        try {
          const existingData = await this.sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A1:U1`, // Includes Market, Trader USD Value, and Position Group columns
          });

          const existingHeaders = existingData.data.values?.[0] || [];
          
          // Compare headers (case-insensitive, trim whitespace)
          const normalizedExisting = existingHeaders.map((h: any) => String(h || "").trim().toLowerCase());
          const normalizedExpected = expectedHeaders.map(h => h.trim().toLowerCase());
          
          headersMatch = normalizedExisting.length === normalizedExpected.length &&
                         normalizedExisting.every((h: string, i: number) => h === normalizedExpected[i]);

          if (headersMatch) {
            console.log(`   ✅ Sheet "${sheetName}" already has correct headers - skipping overwrite`);
          } else {
            console.log(`   📊 Sheet "${sheetName}" headers don't match - updating headers and formatting...`);
          }
        } catch (error: any) {
          // If we can't read headers, assume they don't exist and need to be set
          console.log(`   📊 Could not read existing headers for "${sheetName}" - setting headers...`);
          headersMatch = false;
        }
      }

      // Only set/overwrite headers if they don't match or don't exist
      if (!headersMatch) {
        await this.rateLimitApiCall();
        await this.sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A1:U1`, // Includes Market, Trader USD Value, and Position Group columns
          valueInputOption: "RAW",
          requestBody: {
            values: [expectedHeaders],
          },
        });
      }

      // Always apply formatting to ensure consistency (even if headers match)
      const sheetId = await this.getSheetId(spreadsheetId, sheetName);
      await this.rateLimitApiCall();
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: 21, // Includes Market, Trader USD Value, and Position Group columns
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 0.4, green: 0.49, blue: 0.92 }, // #667eea
                    textFormat: {
                      foregroundColor: { red: 1, green: 1, blue: 1 }, // White
                      bold: true,
                      fontSize: 11,
                    },
                    horizontalAlignment: "CENTER",
                  },
                },
                fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
              },
            },
              {
                updateSheetProperties: {
                  properties: {
                    sheetId: sheetId,
                    gridProperties: {
                      frozenRowCount: 1,
                    },
                  },
                  fields: "gridProperties.frozenRowCount",
                },
              },
          ],
        },
      });

      console.log(`   ✅ Setup trader sheet "${sheetName}" in spreadsheet ${spreadsheetId}`);
    } catch (error: any) {
      // If sheet already exists, that's okay
      if (error.message && error.message.includes("already exists")) {
        console.log(`   Sheet "${sheetName}" already exists, skipping creation`);
      } else {
        console.error(`   ❌ Failed to setup sheet "${sheetName}":`, error);
        throw error;
      }
    }
  }

  /**
   * Get sheet ID by name
   */
  private async getSheetId(spreadsheetId: string, sheetName: string): Promise<number> {
    const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets?.find((s: any) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found`);
    }
    return sheet.properties.sheetId;
  }

  /**
   * Ensure trader sheet exists in a spreadsheet
   * Creates the sheet if it doesn't exist and sets up headers
   */
  private async ensureTraderSheetExists(spreadsheetId: string, sheetName: string): Promise<void> {
    try {
      // Verify spreadsheet exists and is accessible
      const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
      
      if (!spreadsheet.data) {
        throw new Error(`Spreadsheet ${spreadsheetId} not found or not accessible`);
      }
      
      // Setup trader sheet - it will check if sheet exists and set up headers if needed
      await this.setupTraderSheet(spreadsheetId, sheetName);
    } catch (error: any) {
      if (error.code === 404 || error.message?.includes('not found')) {
        console.error(`❌ Spreadsheet ${spreadsheetId} not found. Please verify the spreadsheet ID and ensure it's shared with the service account.`);
        throw new Error(`Spreadsheet ${spreadsheetId} not found or not accessible. Check spreadsheet ID and sharing permissions.`);
      }
      console.error(`❌ Failed to check/create trader sheet "${sheetName}":`, error);
      throw error;
    }
  }

  /**
   * Rate limit API calls to prevent quota errors
   * Adds a delay between API calls to stay within Google's rate limits
   */
  private async rateLimitApiCall(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCallTime;
    
    if (timeSinceLastCall < this.rateLimitDelayMs) {
      const delayNeeded = this.rateLimitDelayMs - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, delayNeeded));
    }
    
    this.lastApiCallTime = Date.now();
  }

  /**
   * Verify spreadsheet access with caching
   * Checks if spreadsheet exists and is accessible
   */
  private async verifySpreadsheetAccess(spreadsheetId: string): Promise<void> {
    // Check cache first
    if (this.verifiedSpreadsheets.has(spreadsheetId)) {
      return;
    }

    try {
      await this.rateLimitApiCall();
      const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
      
      if (!spreadsheet.data) {
        throw new Error(`Spreadsheet ${spreadsheetId} not found or not accessible`);
      }
      
      // Cache successful verification
      this.verifiedSpreadsheets.add(spreadsheetId);
    } catch (error: any) {
      if (error.code === 404) {
        throw new Error(`Spreadsheet ${spreadsheetId} not found`);
      }
      if (error.code === 429) {
        throw error; // Rate limit error - propagate up
      }
      throw error;
    }
  }

  /**
   * Ensure trader sheet exists with caching
   * Uses cache to avoid redundant API calls
   */
  private async ensureTraderSheetExistsCached(spreadsheetId: string, sheetName: string): Promise<void> {
    const cacheKey = `${spreadsheetId}:${sheetName}`;
    
    // Check cache first
    if (this.traderSheetCache.has(cacheKey)) {
      return;
    }

    try {
      await this.ensureTraderSheetExists(spreadsheetId, sheetName);
      // Cache successful creation
      this.traderSheetCache.set(cacheKey, true);
    } catch (error: any) {
      // Don't cache errors - allow retry
      throw error;
    }
  }

  /**
   * Setup aggregate sheets
   */
  private async ensureAggregateSheetsExist(spreadsheetId: string, aggregateSheetName: string): Promise<void> {
    // Implementation for aggregate sheets (Summary, Per-Wallet, Per-Market)
    // This can be expanded later
    console.log(`   📊 Aggregate sheets for ${spreadsheetId} will be setup if needed`);
  }

  /**
   * Get spreadsheet ID based on subscription type
   */
  private getSpreadsheetId(subscriptionType: string): string {
    const spreadsheetId = subscriptionType === "paid" 
      ? this.config.paidSpreadsheetId 
      : this.config.freeSpreadsheetId;
    
    if (!spreadsheetId) {
      throw new Error(
        `No spreadsheet ID configured for subscription type "${subscriptionType}". ` +
        `Please set GOOGLE_SHEETS_${subscriptionType.toUpperCase()}_SPREADSHEET_ID in .env or let the system auto-create it.`
      );
    }
    
    return spreadsheetId;
  }

  /**
   * Schedule batch flush timer
   */
  private scheduleFlush(): void {
    if (this.batchFlushTimer) {
      return; // Timer already scheduled
    }
    
    this.batchFlushTimer = setTimeout(() => {
      this.batchFlushTimer = null;
      this.flushAllBatches().catch(err => {
        console.error("❌ Error flushing batches:", err);
      });
    }, this.BATCH_TIMEOUT_MS);
  }

  /**
   * Queue a position for batch writing
   */
  private async queuePosition(data: PositionData): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.isInitialized) {
      console.warn("⚠️  Google Sheets not initialized, skipping queue");
      return;
    }

    try {
      const spreadsheetId = this.getSpreadsheetId(data.subscriptionType);
      
      // Get trader label
      let traderLabel = data.traderName;
      if (!traderLabel) {
        try {
          const walletRepository = AppDataSource.getRepository(CopyTradeWallet);
          const wallet = await walletRepository.findOne({
            where: { walletAddress: data.walletAddress }
          });
          if (wallet?.label) {
            traderLabel = wallet.label;
          }
        } catch (dbError) {
          // Ignore - will use wallet address
        }
      }
      
      const sheetName = this.sanitizeSheetName(traderLabel, data.walletAddress);
      
      // Generate position group ID
      let positionGroupId = "";
      if (data.conditionId && data.outcomeIndex !== undefined) {
        try {
          const positionRepository = AppDataSource.getRepository(CopyTradePosition);
          const originalPosition = await positionRepository.findOne({
            where: {
              copyTradeWallet: { walletAddress: data.walletAddress },
              conditionId: data.conditionId,
              outcomeIndex: data.outcomeIndex,
              status: "open",
            },
            relations: ["copyTradeWallet"],
            order: { entryDate: "ASC" },
          });
          
          if (originalPosition) {
            positionGroupId = `${data.conditionId}-${data.outcomeIndex}-${originalPosition.entryDate.toISOString()}`;
          } else {
            positionGroupId = `${data.conditionId}-${data.outcomeIndex}-${data.entryDateTime.toISOString()}`;
          }
        } catch (dbError) {
          // If DB lookup fails, use current trade's entry date
          positionGroupId = `${data.conditionId}-${data.outcomeIndex}-${data.entryDateTime.toISOString()}`;
        }
      }

      // Queue the position
      this.positionQueue.push({
        data,
        positionGroupId,
        sheetName,
        spreadsheetId,
      });

      // Flush if batch size reached
      if (this.positionQueue.length >= this.BATCH_SIZE) {
        await this.flushAllBatches();
      } else {
        // Schedule timer-based flush
        this.scheduleFlush();
      }
    } catch (error) {
      console.error("❌ Failed to queue position:", error);
    }
  }

  /**
   * Flush all queued positions to Google Sheets in batches
   */
  private async flushAllBatches(): Promise<void> {
    if (this.isFlushing || this.positionQueue.length === 0) {
      return;
    }

    this.isFlushing = true;
    
    try {
      // Clear the timer since we're flushing now
      if (this.batchFlushTimer) {
        clearTimeout(this.batchFlushTimer);
        this.batchFlushTimer = null;
      }

      // Group positions by spreadsheet + sheet
      const groupedPositions = new Map<string, QueuedPosition[]>();
      
      for (const position of this.positionQueue) {
        const key = `${position.spreadsheetId}:${position.sheetName}`;
        if (!groupedPositions.has(key)) {
          groupedPositions.set(key, []);
        }
        groupedPositions.get(key)!.push(position);
      }

      // Clear the queue
      this.positionQueue = [];

      // Process each group
      for (const [key, positions] of groupedPositions) {
        if (positions.length === 0) continue;
        
        const firstPosition = positions[0];
        if (!firstPosition) continue;
        
        const spreadsheetId = firstPosition.spreadsheetId;
        const sheetName = firstPosition.sheetName;

        try {
          // Verify spreadsheet access
          await this.verifySpreadsheetAccess(spreadsheetId);
          
          // Ensure sheet exists
          await this.ensureTraderSheetExistsCached(spreadsheetId, sheetName);

          // Prepare all rows
          const rows = positions.map(pos => {
            const data = pos.data;
            const sharesBought = data.sharesBought || 
              (parseFloat(data.simulatedInvestment.toString()) / parseFloat(data.entryPrice.toString()));

            return [
              data.walletAddress,
              data.traderName || "",
              data.subscriptionType,
              data.outcomeChosen || "",
              data.marketName || "",
              data.realizedOutcome || "",
              this.formatDateTime(data.entryDateTime),
              parseFloat(data.entryPrice.toString()).toFixed(4),
              parseFloat(data.simulatedInvestment.toString()).toFixed(2),
              data.traderUsdValue ? parseFloat(data.traderUsdValue.toString()).toFixed(2) : "",
              parseFloat(sharesBought.toString()).toFixed(2),
              data.exitDate ? this.formatDateTime(data.exitDate) : "",
              data.exitPrice ? parseFloat(data.exitPrice.toString()).toFixed(4) : "",
              data.sharesSold ? parseFloat(data.sharesSold.toString()).toFixed(2) : "",
              data.realizedPnl ? parseFloat(data.realizedPnl.toString()).toFixed(2) : "",
              data.percentPnl !== undefined ? `${data.percentPnl.toFixed(2)}%` : "",
              data.finalValue ? parseFloat(data.finalValue.toString()).toFixed(2) : "",
              data.percentPnl !== undefined ? `${data.percentPnl.toFixed(2)}%` : "",
              data.status,
              data.hoursHeld ? data.hoursHeld.toFixed(2) : "",
              pos.positionGroupId,
            ];
          });

          // Batch append all rows at once
          await this.rateLimitApiCall();
          const appendResponse = await this.sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:U`,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: {
              values: rows,
            },
          });

          // Get the starting row for formulas (first row inserted)
          const updatedRange = appendResponse.data.updates?.updatedRange;
          let startRow = 2; // Default to row 2 if we can't parse
          if (updatedRange) {
            const match = updatedRange.match(/(\d+):/);
            if (match) {
              startRow = parseInt(match[1], 10);
            }
          }

          // Get sheet ID for formula updates
          const sheetId = await this.getSheetId(spreadsheetId, sheetName);

          // Batch update formulas for all rows using batchUpdate
          // Column mapping: A=Wallet, B=Trader, C=SubType, D=Outcome, E=Market, F=RealizedOutcome,
          // G=EntryDate, H=EntryPrice, I=SimInvestment, J=TraderUSD, K=SharesBought,
          // L=ExitDate, M=ExitPrice, N=SharesSold, O=RealizedPnL, P=PercentPnL,
          // Q=FinalValue, R=ROI, S=Status, T=HoursHeld, U=PositionGroup
          const formulaRequests = [];
          for (let i = 0; i < positions.length; i++) {
            const row = startRow + i;
            
            // Shares Bought formula (Column K) = Simulated Investment (I) / Entry Price (H)
            formulaRequests.push({
              range: `${sheetName}!K${row}`,
              values: [[`=IF(ISBLANK(H${row}), "", I${row} / H${row})`]],
            });

            // Realized PnL formula (Column O) = (Exit Price (M) - Entry Price (H)) * Shares Sold (N)
            formulaRequests.push({
              range: `${sheetName}!O${row}`,
              values: [[`=IF(OR(ISBLANK(M${row}), ISBLANK(H${row}), ISBLANK(N${row})), "", (M${row} - H${row}) * N${row})`]],
            });

            // Percent PnL formula (Column P) = (Realized PnL (O) / Simulated Investment (I)) * 100
            formulaRequests.push({
              range: `${sheetName}!P${row}`,
              values: [[`=IF(OR(ISBLANK(O${row}), ISBLANK(I${row})), "", (O${row} / I${row}) * 100)`]],
            });

            // Final Value formula (Column Q) = Simulated Investment (I) + Realized PnL (O)
            formulaRequests.push({
              range: `${sheetName}!Q${row}`,
              values: [[`=IF(ISBLANK(O${row}), I${row}, I${row} + O${row})`]],
            });

            // ROI formula (Column R) = Same as Percent PnL (P)
            formulaRequests.push({
              range: `${sheetName}!R${row}`,
              values: [[`=IF(ISBLANK(P${row}), "", P${row})`]],
            });

            // Hours Held formula (Column T) = (Exit Date (L) - Entry Date (G)) * 24
            formulaRequests.push({
              range: `${sheetName}!T${row}`,
              values: [[`=IF(ISBLANK(L${row}), "", (L${row} - G${row}) * 24)`]],
            });
          }

          // Batch update all formulas at once
          if (formulaRequests.length > 0) {
            await this.rateLimitApiCall();
            await this.sheets.spreadsheets.values.batchUpdate({
              spreadsheetId,
              requestBody: {
                valueInputOption: "USER_ENTERED",
                data: formulaRequests,
              },
            });
          }

          // Apply conditional formatting for all rows (batch)
          for (let i = 0; i < positions.length; i++) {
            const row = startRow + i;
            await this.applyConditionalFormatting(spreadsheetId, sheetId, row);
          }

          console.log(`   ✅ Batched ${positions.length} position(s) to Google Sheets (${firstPosition.data.subscriptionType}): ${sheetName}`);
        } catch (error: any) {
          console.error(`❌ Failed to batch write to ${sheetName}:`, error);
          // Don't throw - allow other batches to continue
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Append a new position to the spreadsheet (per-trader sheet)
   * Now uses batching to reduce API calls
   */
  async appendPosition(data: PositionData): Promise<void> {
    // Queue for batch writing instead of writing immediately
    await this.queuePosition(data);
  }
  
  /**
   * Force flush all pending positions (for immediate writes when needed)
   */
  async flushPendingPositions(): Promise<void> {
    await this.flushAllBatches();
  }

  /**
   * Update an existing position in the spreadsheet
   */
  async updatePosition(positionId: string, data: Partial<PositionData>): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.isInitialized) {
      console.warn("⚠️  Google Sheets not initialized, skipping update");
      return;
    }

    try {
      // Find position in database to get subscription type
      const positionRepository = AppDataSource.getRepository(CopyTradePosition);
      const position = await positionRepository.findOne({
        where: { id: positionId },
        relations: ["copyTradeWallet"],
      });

      if (!position) {
        console.warn(`⚠️  Position ${positionId} not found in database`);
        return;
      }

      const subscriptionType = position.copyTradeWallet.subscriptionType;
      const spreadsheetId = this.getSpreadsheetId(subscriptionType);
      
      // Use trader label as sheet name (sanitized for Google Sheets)
      const sheetName = this.sanitizeSheetName(
        position.copyTradeWallet.label,
        position.copyTradeWallet.walletAddress
      );
      
      // Ensure trader sheet exists (create if needed)
      await this.ensureTraderSheetExists(spreadsheetId, sheetName);

      // Find row by matching position ID (stored in metadata or via wallet address + entry date)
      const rowIndex = await this.findRowByPositionId(spreadsheetId, sheetName, positionId, position.copyTradeWallet.walletAddress, position.entryDate);

      if (rowIndex === -1) {
        console.warn(`⚠️  Could not find row for position ${positionId} in spreadsheet`);
        return;
      }

      // Update specific cells
      const updates: any[] = [];

      if (data.exitDate !== undefined) {
        updates.push({
          range: `${sheetName}!J${rowIndex}`,
          values: [[this.formatDateTime(data.exitDate)]],
        });
      }

      if (data.exitPrice !== undefined) {
        updates.push({
          range: `${sheetName}!K${rowIndex}`,
          values: [[parseFloat(data.exitPrice.toString()).toFixed(4)]],
        });
      }

      if (data.sharesSold !== undefined) {
        updates.push({
          range: `${sheetName}!L${rowIndex}`,
          values: [[parseFloat(data.sharesSold.toString()).toFixed(2)]],
        });
      }

      if (data.realizedPnl !== undefined) {
        updates.push({
          range: `${sheetName}!M${rowIndex}`,
          values: [[parseFloat(data.realizedPnl.toString()).toFixed(2)]],
        });
      }

      if (data.percentPnl !== undefined) {
        updates.push({
          range: `${sheetName}!N${rowIndex}`,
          values: [[`${data.percentPnl.toFixed(2)}%`]],
        });
        // Also update ROI (Column P)
        updates.push({
          range: `${sheetName}!P${rowIndex}`,
          values: [[`${data.percentPnl.toFixed(2)}%`]],
        });
      }

      if (data.finalValue !== undefined) {
        updates.push({
          range: `${sheetName}!O${rowIndex}`,
          values: [[parseFloat(data.finalValue.toString()).toFixed(2)]],
        });
      }

      if (data.status !== undefined) {
        updates.push({
          range: `${sheetName}!Q${rowIndex}`,
          values: [[data.status]],
        });
      }

      if (data.realizedOutcome !== undefined) {
        updates.push({
          range: `${sheetName}!E${rowIndex}`,
          values: [[data.realizedOutcome]],
        });
      }

      // Batch update
      if (updates.length > 0) {
        await this.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: updates,
          },
        });

        // Re-apply formulas (they will auto-update)
        const sheetId = await this.getSheetId(spreadsheetId, sheetName);
        await this.setCellFormula(spreadsheetId, sheetId, `M${rowIndex}`, `=IF(OR(ISBLANK(K${rowIndex}), ISBLANK(G${rowIndex}), ISBLANK(L${rowIndex})), "", (K${rowIndex} - G${rowIndex}) * L${rowIndex})`);
        await this.setCellFormula(spreadsheetId, sheetId, `N${rowIndex}`, `=IF(OR(ISBLANK(M${rowIndex}), ISBLANK(H${rowIndex})), "", (M${rowIndex} / H${rowIndex}) * 100)`);
        await this.setCellFormula(spreadsheetId, sheetId, `O${rowIndex}`, `=IF(ISBLANK(M${rowIndex}), H${rowIndex}, H${rowIndex} + M${rowIndex})`);
        await this.setCellFormula(spreadsheetId, sheetId, `P${rowIndex}`, `=IF(ISBLANK(N${rowIndex}), "", N${rowIndex})`);
        await this.setCellFormula(spreadsheetId, sheetId, `R${rowIndex}`, `=IF(ISBLANK(J${rowIndex}), "", (J${rowIndex} - F${rowIndex}) * 24)`);

        // Update conditional formatting
        await this.applyConditionalFormatting(spreadsheetId, sheetId, rowIndex);

        console.log(`   ✅ Updated position in Google Sheets (${subscriptionType}): ${positionId}`);
      }
    } catch (error) {
      console.error("❌ Failed to update position in Google Sheets:", error);
      // Don't throw - allow system to continue even if Sheets fails
    }
  }

  /**
   * Find row index by position ID or wallet + entry date
   */
  private async findRowByPositionId(
    spreadsheetId: string,
    sheetName: string,
    positionId: string,
    walletAddress: string,
    entryDate: Date
  ): Promise<number> {
    try {
      // Get all rows
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:F`, // Get columns A-F (wallet, name, sub, outcome, realized, entry date)
      });

      const rows = response.data.values || [];
      const entryDateTime = this.formatDateTime(entryDate);

      // Find matching row (skip header row)
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row[0] === walletAddress && row[5] === entryDateTime) {
          return i + 1; // Return 1-based row index
        }
      }

      return -1;
    } catch (error) {
      console.error("Error finding row:", error);
      return -1;
    }
  }

  /**
   * Get last row number in sheet
   */
  private async getLastRow(spreadsheetId: string, sheetName: string): Promise<number> {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:A`,
      });

      return (response.data.values?.length || 1) + 1; // +1 for next row
    } catch (error) {
      console.error("Error getting last row:", error);
      return 2; // Default to row 2 (after header)
    }
  }

  /**
   * Set cell formula
   */
  private async setCellFormula(spreadsheetId: string, sheetId: number, cell: string, formula: string): Promise<void> {
    try {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range: cell,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[formula]],
        },
      });
    } catch (error) {
      console.error(`Error setting formula for ${cell}:`, error);
    }
  }

  /**
   * Apply conditional formatting to row
   */
  private async applyConditionalFormatting(spreadsheetId: string, sheetId: number, rowIndex: number): Promise<void> {
    try {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            // Green background if PnL > 0 (Column M)
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId,
                      startRowIndex: rowIndex - 1,
                      endRowIndex: rowIndex,
                      startColumnIndex: 12, // Column M (0-based)
                      endColumnIndex: 13,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: "NUMBER_GREATER",
                      values: [{ userEnteredValue: "0" }],
                    },
                    format: {
                      backgroundColor: { red: 0.85, green: 0.97, blue: 0.85 }, // Light green
                    },
                  },
                },
                index: 0,
              },
            },
            // Red background if PnL < 0
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId,
                      startRowIndex: rowIndex - 1,
                      endRowIndex: rowIndex,
                      startColumnIndex: 12,
                      endColumnIndex: 13,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: "NUMBER_LESS",
                      values: [{ userEnteredValue: "0" }],
                    },
                    format: {
                      backgroundColor: { red: 0.97, green: 0.85, blue: 0.85 }, // Light red
                    },
                  },
                },
                index: 1,
              },
            },
            // Yellow background if status = "open" (Column Q)
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId,
                      startRowIndex: rowIndex - 1,
                      endRowIndex: rowIndex,
                      startColumnIndex: 16, // Column Q
                      endColumnIndex: 17,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: "TEXT_EQ",
                      values: [{ userEnteredValue: "open" }],
                    },
                    format: {
                      backgroundColor: { red: 1, green: 0.95, blue: 0.8 }, // Light yellow
                    },
                  },
                },
                index: 2,
              },
            },
          ],
        },
      });
    } catch (error) {
      // Conditional formatting might fail if rule already exists, that's okay
      console.debug(`Conditional formatting for row ${rowIndex} (may already exist)`);
    }
  }

  /**
   * Format date/time for Google Sheets
   */
  private formatDateTime(date: Date): string {
    // Format as: YYYY-MM-DD HH:MM:SS (Google Sheets will recognize this)
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Refresh aggregate sheets (optional)
   */
  async refreshAggregateSheets(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    // Implementation for refreshing summary/aggregate sheets
    // This can be expanded based on requirements
    console.log("📊 Aggregate sheets refresh (to be implemented)");
  }

  /**
   * Get spreadsheet URLs (for admin display)
   */
  getSpreadsheetUrls(): { free: string | null; paid: string | null } {
    return {
      free: this.config.freeSpreadsheetId ? `https://docs.google.com/spreadsheets/d/${this.config.freeSpreadsheetId}` : null,
      paid: this.config.paidSpreadsheetId ? `https://docs.google.com/spreadsheets/d/${this.config.paidSpreadsheetId}` : null,
    };
  }

  /**
   * Get spreadsheet IDs (for admin display)
   */
  getSpreadsheetIds(): SpreadsheetConfig {
    return { ...this.config };
  }
}

export const googleSheetsService = new GoogleSheetsService();

