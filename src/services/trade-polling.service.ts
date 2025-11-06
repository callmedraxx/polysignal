import { AppDataSource } from "../config/database.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";
import { CopyTradePosition } from "../entities/CopyTradePosition.js";
import { CopyTradeWallet } from "../entities/CopyTradeWallet.js";
import { WhaleFrequencyTracking } from "../entities/WhaleFrequencyTracking.js";
import { polymarketService, type PolymarketTrade } from "./polymarket.service.js";
import { discordService } from "./discord.service.js";
import { googleSheetsService } from "./google-sheets.service.js";
import { detectCategory } from "../utils/category-detector.js";
import { inferCategoryFromTags } from "../utils/category-from-tags.js";
import { IsNull, In } from "typeorm";

interface WhaleFrequencyTracker {
  whaleId: string;
  frequency: number;
  resetTime: Date;
}

class TradePollingService {
  private pollingInterval: NodeJS.Timeout | null = null;
  private positionPollingInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private frequencyResetInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds (between 5-10 as requested)
  private readonly POSITION_POLL_INTERVAL_MS = 10000; // 10 seconds for position checks
  private readonly CLEANUP_INTERVAL_MS = 3600000; // 1 hour cleanup interval
  
  // Configurable USD value thresholds from environment variables
  private readonly MAX_PRICE_FOR_STORAGE = 0.95; // Maximum price to store in database
  private readonly MIN_USD_VALUE_FOR_DISCORD = 500; // Minimum USD value to send/update Discord messages
  private readonly ALLOWED_MIN_USD_VALUES = [500, 1000, 2000, 3000, 4000, 5000]; // Fixed allowed values
  
  // Frequency tracking: stores frequency counter per whale per reset period
  private whaleFrequencyMap: Map<string, WhaleFrequencyTracker> = new Map();
  
  // Lock mechanism for frequency operations to prevent race conditions
  // Each whale has a queue of operations that must execute sequentially
  private whaleFrequencyLocks: Map<string, Promise<void>> = new Map();
  
  // Frequency reset interval in hours (default 24, configurable via env)
  private readonly FREQUENCY_RESET_HOURS = parseInt(process.env.WHALE_FREQUENCY_RESET_HOURS || "24", 10);
  
  /**
   * Acquire a lock for frequency operations on a whale
   * Ensures all frequency checks and decrements are atomic
   */
  private async acquireFrequencyLock(whaleId: string): Promise<() => void> {
    const currentLock = this.whaleFrequencyLocks.get(whaleId) || Promise.resolve();
    
    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    
    // Wait for current lock to complete before proceeding
    await currentLock;
    
    // Set this as the new current lock
    this.whaleFrequencyLocks.set(whaleId, newLock);
    
    // Return release function
    return () => {
      releaseLock();
      // Clean up if this is the current lock
      const current = this.whaleFrequencyLocks.get(whaleId);
      if (current === newLock) {
        this.whaleFrequencyLocks.delete(whaleId);
      }
    };
  }
  
  // Repositories
  private readonly copytradePositionRepository = AppDataSource.getRepository(CopyTradePosition);
  private readonly copytradeWalletRepository = AppDataSource.getRepository(CopyTradeWallet);
  private readonly frequencyTrackingRepository = AppDataSource.getRepository(WhaleFrequencyTracking);

  constructor() {
    // Log configuration
    console.log(`💰 Trade storage thresholds: Using per-trader minUsdValue from database`);
    console.log(`   - Allowed values: $${this.ALLOWED_MIN_USD_VALUES.join(", $")}`);
    console.log(`   - Default for new traders: $500`);
    console.log(`📊 Frequency tracking: Reset interval ${this.FREQUENCY_RESET_HOURS} hours`);
    console.log(`   - Free subscription: 1 initial buy trade per period`);
    console.log(`   - Paid subscription: 3 initial buy trades per period`);
  }

  /**
   * Get the minimum USD value threshold for storage from trader's database record
   * Falls back to 500 if not set or invalid
   */
  private getMinUsdValueForStorage(whale: TrackedWhale): number {
    const minUsdValue = whale.minUsdValue || 500;
    // Convert to number for comparison (handles decimal values from database like 4000.00)
    const numericValue = Number(minUsdValue);
    // Validate that the value is in the allowed list, fallback to 500 if not
    if (this.ALLOWED_MIN_USD_VALUES.includes(numericValue)) {
      return numericValue;
    }
    console.warn(`⚠️  Invalid minUsdValue ${minUsdValue} for trader ${whale.label || whale.walletAddress}, using default $500`);
    return 500;
  }

  /**
   * Get default frequency based on subscription type
   * Free: 1, Paid: 3
   */
  private getDefaultFrequency(subscriptionType: string): number {
    return subscriptionType === "paid" ? 3 : 1;
  }

  /**
   * Get frequency for a whale (custom from database or default based on subscription type)
   */
  private getWhaleFrequencyLimit(whale: TrackedWhale): number {
    // If whale has a custom frequency set, use it
    if (whale.frequency !== null && whale.frequency !== undefined) {
      return whale.frequency;
    }
    // Otherwise use default based on subscription type
    return this.getDefaultFrequency(whale.subscriptionType);
  }

  /**
   * Load frequency tracking data from database for a whale
   * Returns frequency from database or null if not found
   */
  private async loadFrequencyFromDatabase(whaleId: string): Promise<WhaleFrequencyTracking | null> {
    try {
      return await this.frequencyTrackingRepository.findOne({
        where: { whaleId },
      });
    } catch (error) {
      console.error(`❌ Error loading frequency from database for whale ${whaleId}:`, error);
      return null;
    }
  }

  /**
   * Persist frequency tracking data to database
   */
  private async persistFrequencyToDatabase(
    whaleId: string,
    remainingFrequency: number,
    resetTime: Date
  ): Promise<void> {
    try {
      const existing = await this.frequencyTrackingRepository.findOne({
        where: { whaleId },
      });

      if (existing) {
        existing.remainingFrequency = remainingFrequency;
        existing.resetTime = resetTime;
        await this.frequencyTrackingRepository.save(existing);
      } else {
        const tracking = this.frequencyTrackingRepository.create({
          whaleId,
          remainingFrequency,
          resetTime,
        });
        await this.frequencyTrackingRepository.save(tracking);
      }
    } catch (error) {
      console.error(`❌ Error persisting frequency to database for whale ${whaleId}:`, error);
    }
  }

  /**
   * Get or initialize frequency tracker for a whale
   * Loads from database first, then uses memory cache
   * Returns current frequency count, initializing if needed or resetting if period expired
   */
  private async getWhaleFrequency(whale: TrackedWhale): Promise<number> {
    const tracker = this.whaleFrequencyMap.get(whale.id);
    const now = new Date();

    // If no tracker in memory, try to load from database
    if (!tracker) {
      const dbTracking = await this.loadFrequencyFromDatabase(whale.id);
      
      if (dbTracking) {
        // Check if reset time has passed
        if (now >= dbTracking.resetTime) {
          // Reset period expired, initialize with full limit
          const frequencyLimit = this.getWhaleFrequencyLimit(whale);
          const resetTime = new Date(now.getTime() + this.FREQUENCY_RESET_HOURS * 60 * 60 * 1000);
          
          const newTracker: WhaleFrequencyTracker = {
            whaleId: whale.id,
            frequency: frequencyLimit,
            resetTime: resetTime,
          };
          
          this.whaleFrequencyMap.set(whale.id, newTracker);
          await this.persistFrequencyToDatabase(whale.id, frequencyLimit, resetTime);

          const frequencySource = whale.frequency !== null && whale.frequency !== undefined 
            ? `custom (${whale.frequency})` 
            : `default (${whale.subscriptionType})`;

          console.log(
            `🔄 Reset frequency for ${whale.label || whale.walletAddress} (period expired) ` +
            `(${frequencySource}): ${frequencyLimit} trades per ${this.FREQUENCY_RESET_HOURS} hours`
          );

          return frequencyLimit;
        } else {
          // Load from database
          const dbTracker: WhaleFrequencyTracker = {
            whaleId: whale.id,
            frequency: dbTracking.remainingFrequency,
            resetTime: dbTracking.resetTime,
          };
          
          this.whaleFrequencyMap.set(whale.id, dbTracker);
          
          const frequencySource = whale.frequency !== null && whale.frequency !== undefined 
            ? `custom (${whale.frequency})` 
            : `default (${whale.subscriptionType})`;

          console.log(
            `📊 Loaded frequency from database for ${whale.label || whale.walletAddress} ` +
            `(${frequencySource}): ${dbTracking.remainingFrequency} remaining (resets ${dbTracking.resetTime.toISOString()})`
          );

          return dbTracking.remainingFrequency;
        }
      } else {
        // No database entry, initialize with full limit
        const frequencyLimit = this.getWhaleFrequencyLimit(whale);
        const resetTime = new Date(now.getTime() + this.FREQUENCY_RESET_HOURS * 60 * 60 * 1000);
        
        const newTracker: WhaleFrequencyTracker = {
          whaleId: whale.id,
          frequency: frequencyLimit,
          resetTime: resetTime,
        };
        
        this.whaleFrequencyMap.set(whale.id, newTracker);
        await this.persistFrequencyToDatabase(whale.id, frequencyLimit, resetTime);

        const frequencySource = whale.frequency !== null && whale.frequency !== undefined 
          ? `custom (${whale.frequency})` 
          : `default (${whale.subscriptionType})`;

        console.log(
          `📊 Initialized frequency tracker for ${whale.label || whale.walletAddress} ` +
          `(${frequencySource}): ${frequencyLimit} trades per ${this.FREQUENCY_RESET_HOURS} hours`
        );

        return frequencyLimit;
      }
    }

    // Tracker exists in memory, check if reset time has passed
    if (now >= tracker.resetTime) {
      const frequencyLimit = this.getWhaleFrequencyLimit(whale);
      const resetTime = new Date(now.getTime() + this.FREQUENCY_RESET_HOURS * 60 * 60 * 1000);
      
      tracker.frequency = frequencyLimit;
      tracker.resetTime = resetTime;
      
      await this.persistFrequencyToDatabase(whale.id, frequencyLimit, resetTime);

      const frequencySource = whale.frequency !== null && whale.frequency !== undefined 
        ? `custom (${whale.frequency})` 
        : `default (${whale.subscriptionType})`;

      console.log(
        `🔄 Reset frequency for ${whale.label || whale.walletAddress} (period expired) ` +
        `(${frequencySource}): ${frequencyLimit} trades per ${this.FREQUENCY_RESET_HOURS} hours`
      );

      return frequencyLimit;
    }

    return tracker.frequency;
  }

  /**
   * Atomically check frequency limit and decrement for initial buy trades (status = "open")
   * Returns true if frequency is available and was decremented, false otherwise
   * This method is thread-safe and prevents race conditions
   */
  private async checkAndDecrementFrequency(whale: TrackedWhale): Promise<boolean> {
    const releaseLock = await this.acquireFrequencyLock(whale.id);
    
    try {
      // Check frequency with lock held (atomic operation)
      const currentFrequency = await this.getWhaleFrequency(whale);
      
      if (currentFrequency <= 0) {
        return false;
      }
      
      // Decrement frequency (atomic operation - lock ensures no other trade can interfere)
      await this.decrementWhaleFrequency(whale);
      return true;
    } finally {
      releaseLock();
    }
  }

  /**
   * Decrement frequency for a whale (called when storing an initial buy trade)
   * NOTE: This method should only be called while holding the frequency lock
   * Use checkAndDecrementFrequency() for thread-safe operations
   */
  private async decrementWhaleFrequency(whale: TrackedWhale): Promise<void> {
    const tracker = this.whaleFrequencyMap.get(whale.id);
    if (!tracker) {
      // Should not happen, but initialize if it does
      await this.getWhaleFrequency(whale);
      const updatedTracker = this.whaleFrequencyMap.get(whale.id);
      if (!updatedTracker) {
        console.error(`❌ Failed to get frequency tracker after initialization for whale ${whale.id}`);
        return;
      }
      // Decrement the initialized frequency
      updatedTracker.frequency = Math.max(0, updatedTracker.frequency - 1);
      await this.persistFrequencyToDatabase(
        whale.id,
        updatedTracker.frequency,
        updatedTracker.resetTime
      );
      console.log(
        `📊 Frequency updated for ${whale.label || whale.walletAddress}: ` +
        `${updatedTracker.frequency} remaining (${whale.subscriptionType} subscription)`
      );
      return;
    }

    const now = new Date();
    // If reset time has passed, reset first (but continue to decrement)
    if (now >= tracker.resetTime) {
      await this.getWhaleFrequency(whale);
      // Get the tracker again after reset
      const resetTracker = this.whaleFrequencyMap.get(whale.id);
      if (!resetTracker) {
        console.error(`❌ Failed to get frequency tracker after reset for whale ${whale.id}`);
        return;
      }
      // Decrement the reset frequency
      resetTracker.frequency = Math.max(0, resetTracker.frequency - 1);
      await this.persistFrequencyToDatabase(
        whale.id,
        resetTracker.frequency,
        resetTracker.resetTime
      );
      console.log(
        `📊 Frequency updated for ${whale.label || whale.walletAddress} (after reset): ` +
        `${resetTracker.frequency} remaining (${whale.subscriptionType} subscription)`
      );
      return;
    }

    // Decrement frequency (ensure it doesn't go below 0)
    tracker.frequency = Math.max(0, tracker.frequency - 1);
    
    // Persist to database
    await this.persistFrequencyToDatabase(whale.id, tracker.frequency, tracker.resetTime);
    
    console.log(
      `📊 Frequency updated for ${whale.label || whale.walletAddress}: ` +
      `${tracker.frequency} remaining (${whale.subscriptionType} subscription)`
    );
  }

  /**
   * Reset frequencies for all whales (called periodically)
   */
  private async resetAllWhaleFrequencies(): Promise<void> {
    console.log(`🔄 Resetting frequencies for all whales...`);
    try {
      const whales = await this.whaleRepository.find({ where: { isActive: true } });
      
      await Promise.all(
        whales.map(whale => this.getWhaleFrequency(whale)) // This will reset if needed and persist
      );
      
      console.log(`✅ Frequency reset complete for ${whales.length} active whales`);
    } catch (error) {
      console.error(`❌ Error resetting frequencies:`, error);
    }
  }

  /**
   * Load all frequency tracking data from database on startup
   */
  private async loadAllFrequenciesFromDatabase(): Promise<void> {
    try {
      console.log(`📊 Loading frequency tracking data from database...`);
      
      const allTracking = await this.frequencyTrackingRepository.find({
        relations: ["whale"],
      });

      const now = new Date();
      let loadedCount = 0;
      let resetCount = 0;

      for (const tracking of allTracking) {
        // Check if reset time has passed
        if (now >= tracking.resetTime) {
          // Will be reset when first accessed
          resetCount++;
          continue;
        }

        // Load into memory cache
        const tracker: WhaleFrequencyTracker = {
          whaleId: tracking.whaleId,
          frequency: tracking.remainingFrequency,
          resetTime: tracking.resetTime,
        };
        
        this.whaleFrequencyMap.set(tracking.whaleId, tracker);
        loadedCount++;
      }

      console.log(
        `✅ Loaded ${loadedCount} frequency trackers from database ` +
        `(${resetCount} will reset on next access)`
      );
    } catch (error) {
      console.error(`❌ Error loading frequencies from database:`, error);
    }
  }

  /**
   * Get frequency status for a whale (public method for API access)
   * Returns current remaining frequency, frequency limit, and reset time
   */
  async getWhaleFrequencyStatus(whaleId: string): Promise<{
    whaleId: string;
    remainingFrequency: number;
    frequencyLimit: number;
    resetTime: Date;
    isCustom: boolean;
  } | null> {
    try {
      const whale = await this.whaleRepository.findOne({
        where: { id: whaleId },
      });

      if (!whale) {
        return null;
      }

      // Get frequency (will load from database if needed)
      const remainingFrequency = await this.getWhaleFrequency(whale);
      const tracker = this.whaleFrequencyMap.get(whaleId);

      if (!tracker) {
        console.error(`❌ Tracker not found after getWhaleFrequency for whale ${whaleId}`);
        return null;
      }

      const frequencyLimit = this.getWhaleFrequencyLimit(whale);
      const isCustom = whale.frequency !== null && whale.frequency !== undefined;

      return {
        whaleId,
        remainingFrequency: tracker.frequency,
        frequencyLimit: frequencyLimit,
        resetTime: tracker.resetTime,
        isCustom,
      };
    } catch (error) {
      console.error(`❌ Error getting frequency status for whale ${whaleId}:`, error);
      return null;
    }
  }

  /**
   * Get frequency status for all active whales
   */
  async getAllWhalesFrequencyStatus(): Promise<Array<{
    whaleId: string;
    remainingFrequency: number;
    frequencyLimit: number;
    resetTime: Date;
    isCustom: boolean;
  }>> {
    try {
      const whales = await this.whaleRepository.find({
        where: { isActive: true },
      });

      const statuses = await Promise.all(
        whales.map(whale => this.getWhaleFrequencyStatus(whale.id))
      );

      return statuses.filter((status): status is NonNullable<typeof status> => status !== null);
    } catch (error) {
      console.error(`❌ Error getting frequency status for all whales:`, error);
      return [];
    }
  }

  /**
   * Send gainz alert for closed positions with high PnL
   */
  private async sendGainzAlertForActivity(
    activity: WhaleActivity,
    whale: TrackedWhale,
    metadata: Record<string, any>
  ): Promise<void> {
    try {
      // Only send for closed positions with percentPnl
      // The threshold check is done inside sendGainzAlert
      if (activity.status !== "closed" || !activity.percentPnl) {
        return;
      }
      
      // Skip gainz alerts for losses (negative percentPnl)
      if (activity.percentPnl < 0) {
        console.log(`   ⏭️  Skipping gainz alert (loss detected: ${activity.percentPnl.toFixed(2)}%) | Activity: ${activity.id}`);
        return;
      }
      
      // Double-check: Ensure we haven't already sent this alert (additional safety check)
      // This prevents duplicates on server restart
      const activityMetadata = activity.metadata || {};
      if (activityMetadata.gainzAlertSent === true) {
        console.log(`   ⏭️  Skipping gainz alert - already sent for activity ${activity.id}`);
        return;
      }

      const profileUrl = `https://polymarket.com/profile/${whale.walletAddress}`;
      const marketLink = metadata.slug
        ? `https://polymarket.com/market/${metadata.slug}`
        : undefined;

      await discordService.sendGainzAlert({
        walletAddress: whale.walletAddress,
        traderName: whale.label,
        profileUrl,
        thumbnailUrl: metadata.icon,
        marketLink,
        marketName: metadata.market,
        percentPnl: activity.percentPnl,
        realizedPnl: activity.realizedPnl,
        usdValue: metadata.usdValue,
        activityTimestamp: activity.activityTimestamp,
        whaleCategory: whale.category || "regular",
        tradeCategory: activity.category,
        entryPrice: metadata.price, // Entry price from original buy
        exitPrice: metadata.exitPrice, // Exit price from closed position
        outcome: metadata.realizedOutcome, // Realized outcome (actual game result)
      });
    } catch (error) {
      console.warn(`⚠️  Failed to send gainz alert for activity ${activity.id}:`, error);
    }
  }
  private isPolling = false;
  private isCheckingPositions = false;
  private isCleaning = false;
  private whaleRepository = AppDataSource.getRepository(TrackedWhale);
  private activityRepository = AppDataSource.getRepository(WhaleActivity);

  /**
   * Calculate FIFO-based PnL for a partial sale
   * This uses the buy prices from stored BUY trades to calculate more accurate PnL per sale
   * @param currentPositionSize - The current position size from the API to validate against tracked BUYs
   */
  private async calculateFifoPnlForPartialSale(
    whaleId: string,
    conditionId: string,
    outcomeIndex: number,
    sharesSold: number,
    sellPrice: number,
    currentSellTimestamp: Date,
    currentPositionSize?: number
  ): Promise<number | undefined> {
    try {
      // Fetch all BUY trades for this position, ordered by timestamp (oldest first)
      const buyTrades = await this.activityRepository.find({
        where: {
          whaleId,
          activityType: 'POLYMARKET_BUY',
          status: 'open',
        },
        order: {
          activityTimestamp: 'ASC',
        },
      });

      // Filter by conditionId and outcomeIndex
      const relevantBuys = buyTrades.filter(
        trade => trade.metadata?.conditionId === conditionId && 
                 trade.metadata?.outcomeIndex === outcomeIndex
      );

      if (relevantBuys.length === 0) {
        return undefined;
      }

      // Track which buys have been "consumed" by previous SELLs
      // We need to find all SELL trades that occurred BEFORE this one
      const allSellTrades = await this.activityRepository.find({
        where: {
          whaleId,
          activityType: 'POLYMARKET_SELL',
          status: 'partially_closed',
        },
        order: {
          activityTimestamp: 'ASC',
        },
      });

      const previousSells = allSellTrades.filter(
        sell => sell.metadata?.conditionId === conditionId && 
                sell.metadata?.outcomeIndex === outcomeIndex &&
                sell.activityTimestamp && 
                new Date(sell.activityTimestamp).getTime() < new Date(currentSellTimestamp).getTime()
      );

      // Track remaining shares from each buy that haven't been sold yet
      const buyInventories: Array<{ shares: number; price: number }> = [];
      
      for (const buy of relevantBuys) {
        const buyAmount = parseFloat(buy.amount || "0");
        const buyPrice = buy.metadata?.price ? parseFloat(buy.metadata.price) : 0;
        if (buyAmount > 0 && buyPrice > 0) {
          buyInventories.push({ shares: buyAmount, price: buyPrice });
        }
      }

      // If no valid BUY inventories with prices, FIFO can't work
      if (buyInventories.length === 0) {
        console.log(`⚠️  FIFO PnL skipped: No BUY trades with valid prices found for conditionId=${conditionId}, outcomeIndex=${outcomeIndex}`);
        return undefined;
      }

      // Subtract shares already sold in previous partial sales to get remaining tracked shares
      for (const sell of previousSells) {
        const sellAmount = parseFloat(sell.amount || "0");
        let remainingToDeduct = sellAmount;
        
        // FIFO: deduct from oldest buys first
        for (const inv of buyInventories) {
          if (remainingToDeduct <= 0) break;
          if (inv.shares > 0) {
            const deduction = Math.min(inv.shares, remainingToDeduct);
            inv.shares -= deduction;
            remainingToDeduct -= deduction;
          }
        }
      }

      // Calculate remaining tracked shares AFTER previous SELLs
      const remainingTrackedShares = buyInventories.reduce((sum, inv) => sum + inv.shares, 0);

      // If we have current position size, validate against our tracked BUYs
      // If there's a large discrepancy (>50 shares), FIFO isn't reliable - use avgPrice instead
      if (currentPositionSize !== undefined) {
        const discrepancy = Math.abs(remainingTrackedShares - currentPositionSize);
        
        // If discrepancy is too large (>50 shares), FIFO isn't reliable
        if (discrepancy > 50) {
          console.log(`⚠️  FIFO PnL skipped: Large share discrepancy detected (tracked remaining: ${remainingTrackedShares.toFixed(2)}, actual position: ${currentPositionSize.toFixed(2)}, diff: ${discrepancy.toFixed(2)}). Using avgPrice instead.`);
          return undefined;
        } else if (discrepancy > 0) {
          console.log(`ℹ️  FIFO PnL proceeding with small discrepancy: tracked=${remainingTrackedShares.toFixed(2)}, actual=${currentPositionSize.toFixed(2)}, diff=${discrepancy.toFixed(2)}`);
        }
      }

      // Calculate weighted average cost for this specific sale using FIFO
      let remainingToMatch = sharesSold;
      let totalCost = 0;
      
      for (const inv of buyInventories) {
        if (remainingToMatch <= 0) break;
        if (inv.shares > 0) {
          const sharesToTake = Math.min(inv.shares, remainingToMatch);
          totalCost += sharesToTake * inv.price;
          remainingToMatch -= sharesToTake;
        }
      }

      if (remainingToMatch > 0) {
        // Not enough shares in our BUY history - fall back to avgPrice
        // This happens when initial BUYs were below threshold and not tracked
        console.log(`⚠️  FIFO PnL incomplete: ${remainingToMatch.toFixed(2)} of ${sharesSold.toFixed(2)} shares unmatched (likely bought below storage threshold)`);
        return undefined;
      }

      // Calculate PnL
      const proceeds = sharesSold * sellPrice;
      const costBasis = totalCost;
      const profit = proceeds - costBasis;
      const percentPnl = costBasis > 0 ? (profit / costBasis) * 100 : undefined;

      return percentPnl;
    } catch (error) {
      console.warn('⚠️  Error calculating FIFO PnL:', error);
      return undefined;
    }
  }

  /**
   * Start polling for trades and positions
   */
  start(): void {
    if (this.pollingInterval) {
      console.log("⚠️  Trade polling is already running");
      return;
    }

    console.log(`🔄 Starting trade polling service (every ${this.POLL_INTERVAL_MS / 1000}s)`);
    
    // Run immediately on start
    this.pollAllWhales().catch((error) => {
      console.error("❌ Error in initial polling:", error);
    });

    // Then set up interval
    this.pollingInterval = setInterval(() => {
      this.pollAllWhales().catch((error) => {
        console.error("❌ Error in polling interval:", error);
      });
    }, this.POLL_INTERVAL_MS);

    // Start position checking service
    console.log(`🔄 Starting position checking service (every ${this.POSITION_POLL_INTERVAL_MS / 1000}s)`);
    
    // Run position check immediately
    this.checkAllWhalePositions().catch((error) => {
      console.error("❌ Error in initial position check:", error);
    });

    // Set up position checking interval
    this.positionPollingInterval = setInterval(() => {
      this.checkAllWhalePositions().catch((error) => {
        console.error("❌ Error in position check interval:", error);
      });
    }, this.POSITION_POLL_INTERVAL_MS);

    // Start cleanup service
    console.log(`🧹 Starting cleanup service (every ${this.CLEANUP_INTERVAL_MS / 1000 / 60} minutes)`);
    
    // Run cleanup immediately on start
    this.cleanupDatabase().catch((error) => {
      console.error("❌ Error in initial cleanup:", error);
    });

    // Set up cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupDatabase().catch((error) => {
        console.error("❌ Error in cleanup interval:", error);
      });
    }, this.CLEANUP_INTERVAL_MS);

    // Load frequency tracking data from database on startup
    this.loadAllFrequenciesFromDatabase().catch((error) => {
      console.error("❌ Error loading frequencies from database:", error);
    });

    // Start frequency reset service
    const frequencyResetIntervalMs = this.FREQUENCY_RESET_HOURS * 60 * 60 * 1000;
    console.log(`🔄 Starting frequency reset service (every ${this.FREQUENCY_RESET_HOURS} hours)`);
    
    // Run frequency reset after loading (will only reset expired trackers)
    this.resetAllWhaleFrequencies().catch((error) => {
      console.error("❌ Error in initial frequency reset:", error);
    });

    // Set up frequency reset interval
    this.frequencyResetInterval = setInterval(() => {
      this.resetAllWhaleFrequencies().catch((error) => {
        console.error("❌ Error in frequency reset interval:", error);
      });
    }, frequencyResetIntervalMs);
  }

  /**
   * Stop polling for trades and positions
   */
  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      console.log("🛑 Trade polling service stopped");
    }
    
    if (this.positionPollingInterval) {
      clearInterval(this.positionPollingInterval);
      this.positionPollingInterval = null;
      console.log("🛑 Position checking service stopped");
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.log("🛑 Cleanup service stopped");
    }

    if (this.frequencyResetInterval) {
      clearInterval(this.frequencyResetInterval);
      this.frequencyResetInterval = null;
      console.log("🛑 Frequency reset service stopped");
    }
  }

  /**
   * Poll trades for all active tracked whales and copytrade-only wallets
   */
  private async pollAllWhales(): Promise<void> {
    if (this.isPolling) {
      console.log("⏭️  Skipping poll - previous poll still in progress");
      return;
    }

    this.isPolling = true;

    try {
      // Fetch all active tracked whales
      const activeWhales = await this.whaleRepository.find({
        where: { isActive: true },
      });

      // Fetch all active copytrade-only wallets (not linked to tracked whales)
      const activeCopytradeWallets = await this.copytradeWalletRepository.find({
        where: { isActive: true, trackedWhaleId: IsNull() },
      });

      const totalToPoll = activeWhales.length + activeCopytradeWallets.length;

      if (totalToPoll === 0) {
        console.log("ℹ️  No active whales or copytrade wallets to track");
        return;
      }

      const copytradeWhales = activeWhales.filter(w => w.isCopytrade).length;
      console.log(
        `🐋 Polling trades for ${activeWhales.length} whale(s) (${copytradeWhales} in copytrade) ` +
        `and ${activeCopytradeWallets.length} copytrade-only wallet(s)...`
      );

      // Process tracked whales
      const whaleResults = await Promise.allSettled(
        activeWhales.map((whale) => this.pollWhaleTradesAndStore(whale))
      );

      // Process copytrade-only wallets (convert to TrackedWhale-like structure for polling)
      const copytradeResults = await Promise.allSettled(
        activeCopytradeWallets.map((wallet) => this.pollCopytradeWalletTrades(wallet))
      );

      // Log results
      const successful = whaleResults.filter((r) => r.status === "fulfilled").length + 
                        copytradeResults.filter((r) => r.status === "fulfilled").length;
      const failed = whaleResults.filter((r) => r.status === "rejected").length + 
                    copytradeResults.filter((r) => r.status === "rejected").length;

      console.log(`✅ Polling complete: ${successful} successful, ${failed} failed`);
    } catch (error) {
      console.error("❌ Error polling whales:", error);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll trades for a copytrade-only wallet (not a tracked whale)
   */
  private async pollCopytradeWalletTrades(wallet: CopyTradeWallet): Promise<void> {
    try {
      // Fetch recent trades from Polymarket
      const trades = await polymarketService.getUserTrades(
        wallet.walletAddress,
        { 
          limit: 10,
          takerOnly: false
        }
      );

      if (trades.length === 0) {
        return;
      }

      // Check which trades are new (by transaction hash)
      // NOTE: For copytrade-only wallets, we check CopyTradePosition entries, not WhaleActivity
      // This ensures copytrade-only wallets never create WhaleActivity entries that could trigger Discord alerts
      const transactionHashes = trades.map(t => t.transactionHash);
      const existingPositions = transactionHashes.length > 0
        ? await this.copytradePositionRepository.find({
            where: {
              entryTransactionHash: In(transactionHashes),
            },
            select: ["entryTransactionHash"],
          })
        : [];
      const existingHashSet = new Set(existingPositions.map(p => p.entryTransactionHash));
      const newTrades = trades.filter(t => !existingHashSet.has(t.transactionHash));

      if (newTrades.length === 0) {
        return;
      }

      // Sort trades by timestamp (oldest first)
      newTrades.sort((a, b) => a.timestamp - b.timestamp);

      console.log(
        `📊 Found ${newTrades.length} new trade(s) for copytrade wallet ${wallet.label || wallet.walletAddress} (NO Discord alerts will be sent)`
      );

      // Store new trades and create copytrade positions
      for (const trade of newTrades) {
        // Only process BUY trades that meet storage criteria
        if (trade.side === "BUY") {
          const usdValue = trade.size * trade.price;
          const price = trade.price;
          
          // Apply same filtering as tracked whales
          if (price > this.MAX_PRICE_FOR_STORAGE) {
            continue;
          }
          
          // Create copytrade position for every stored BUY trade
          await this.createCopytradePositionForWallet(wallet, trade);
        }
      }
    } catch (error) {
      console.error(
        `❌ Error polling trades for copytrade wallet ${wallet.label || wallet.walletAddress}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Poll trades for a specific whale and store new ones
   */
  private async pollWhaleTradesAndStore(whale: TrackedWhale): Promise<void> {
    try {
      // Fetch recent trades from Polymarket
      const trades = await polymarketService.getUserTrades(
        whale.walletAddress,
        { 
          limit: 10, // Fetch last 10 trades
          takerOnly: false // Include maker trades too
        }
      );

      if (trades.length === 0) {
        return;
      }

      // Check which trades are new
      const newTrades = await this.filterNewTrades(whale.id, trades);

      if (newTrades.length === 0) {
        return;
      }

      // Sort trades by timestamp (oldest first) to ensure correct status assignment
      // The oldest qualifying trade becomes "open", subsequent ones become "added"
      newTrades.sort((a, b) => a.timestamp - b.timestamp);

      const copytradeStatus = whale.isCopytrade ? " (CopyTrade Enabled)" : "";
      console.log(
        `📊 Found ${newTrades.length} new trade(s) for ${whale.label || whale.walletAddress}${copytradeStatus}`
      );

      // Store new trades in database (only those meeting criteria)
      const savedActivities: WhaleActivity[] = [];
      for (const trade of newTrades) {
        const savedActivity = await this.storeTrade(whale, trade);
        if (savedActivity) {
          savedActivities.push(savedActivity);
        }
      }

      // Sort activities by activityTimestamp (oldest first, so newest appears last in Discord)
      savedActivities.sort((a, b) => {
        const timeA = a.activityTimestamp ? new Date(a.activityTimestamp).getTime() : 0;
        const timeB = b.activityTimestamp ? new Date(b.activityTimestamp).getTime() : 0;
        return timeA - timeB;
      });

      // Send Discord notifications in chronological order (oldest to newest)
      // Apply filtering: SELL and added BUY trades skip filters, initial BUY trades apply filters
      for (const activity of savedActivities) {
        const metadata = activity.metadata || {};
        const usdValue = metadata.usdValue ? parseFloat(metadata.usdValue) : 0;
        const price = metadata.price ? parseFloat(metadata.price) : null;
        const conditionId = metadata.conditionId as string | undefined;
        const isSell = activity.activityType === 'POLYMARKET_SELL';
        const isBuy = activity.activityType === 'POLYMARKET_BUY';
        const isAddedBuy = activity.status === 'added';
        
        // Skip Discord notification if USD value is below threshold
        // Exception: SELL trades and added BUY trades skip this filter
        if (!isSell && !isAddedBuy && usdValue < this.MIN_USD_VALUE_FOR_DISCORD) {
          console.log(
            `⏭️  Skipping Discord notification (USD value $${usdValue.toFixed(2)} < $${this.MIN_USD_VALUE_FOR_DISCORD}) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
          );
          continue;
        }
        
        // Skip Discord notification if price is above $0.95
        // Exception: SELL trades and added BUY trades skip this filter
        if (!isSell && !isAddedBuy && (price === null || price > 0.95)) {
          console.log(
            `⏭️  Skipping Discord notification (price $${price !== null ? price.toFixed(2) : 'N/A'} > $0.95) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
          );
          continue;
        }
        
        const profileUrl = `https://polymarket.com/profile/${whale.walletAddress}`;
        const marketLink = metadata.slug
          ? `https://polymarket.com/market/${metadata.slug}`
          : undefined;

        const activityType = activity.activityType.replace('POLYMARKET_', '');

        // Fetch position data for PnL and total shares
        let positionData: {
          totalShares?: number;
          percentPnl?: number;
          totalBought?: number;
        } = {};

        if (conditionId && (activity.status === "open" || activity.status === "added" || activity.status === "partially_closed" || activity.status === "closed")) {
          try {
            // For all trades, query current positions first
              const positions = await polymarketService.getUserPositions(
                whale.walletAddress,
                [conditionId]
              );
            const currentOutcomeIndex = metadata.outcomeIndex;
            const position = positions.find(p => p.conditionId === conditionId && p.outcomeIndex === currentOutcomeIndex);
            
              if (position) {
              // Position found in current positions - always fetch total shares from API for accuracy
                positionData.totalShares = position.size;
              
              // For SELL trades (partial or closed), calculate custom percentage PnL for this specific sale
              if (isSell && activity.status === "partially_closed") {
                const sharesSold = parseFloat(activity.amount || "0");
                const sellPrice = metadata.price ? parseFloat(metadata.price) : 0;
                
                // Try FIFO calculation first for more accurate PnL per sale
                if (sharesSold > 0 && sellPrice > 0 && activity.activityTimestamp) {
                  const fifoPnl = await this.calculateFifoPnlForPartialSale(
                    whale.id,
                    conditionId,
                    currentOutcomeIndex,
                    sharesSold,
                    sellPrice,
                    activity.activityTimestamp,
                    position.size // Current position size for validation
                  );
                  
                  if (fifoPnl !== undefined) {
                    positionData.percentPnl = fifoPnl;
                  } else {
                    // Fall back to avgPrice calculation if FIFO fails
                    const avgBuyPrice = position.avgPrice;
                    if (avgBuyPrice > 0) {
                      const costBasis = sharesSold * avgBuyPrice;
                      const proceeds = sharesSold * sellPrice;
                      const profit = proceeds - costBasis;
                      positionData.percentPnl = (profit / costBasis) * 100;
                    }
                  }
                }
              } else if (isSell && activity.status === "closed" && position.percentRealizedPnl !== undefined) {
                // For fully closed trades, use percentRealizedPnl
                positionData.percentPnl = position.percentRealizedPnl;
              } else {
                // For BUY trades (open or added), use percentPnl
                positionData.percentPnl = position.percentPnl;
              }
            } else {
              // Position not found in current positions - check if it's a closed sell
              if (isSell && activity.status === "closed") {
                positionData.totalShares = 0;
            
                // Try to get PnL from closed positions
              const closedPositions = await polymarketService.getUserClosedPositions(
                whale.walletAddress,
                [conditionId]
              );
                const closedPosition = closedPositions.find(p => p.conditionId === conditionId && p.outcomeIndex === currentOutcomeIndex);
              if (closedPosition) {
                positionData.totalBought = closedPosition.totalBought;
                // Calculate percentage PnL: (realizedPnl / initialValue) * 100
                const initialValue = closedPosition.totalBought * closedPosition.avgPrice;
                if (initialValue > 0 && closedPosition.realizedPnl !== undefined) {
                  positionData.percentPnl = (closedPosition.realizedPnl / initialValue) * 100;
                }
              }
              }
            }
          } catch (error) {
            console.warn(`⚠️  Failed to fetch position data for conditionId ${conditionId}:`, error);
          }
        }

        // Check if we should reply to an existing message
        let matchingActivity: WhaleActivity | null = null;
        
        if ((isSell || isBuy) && conditionId) {
          // For SELL trades, find the first BUY trade with same conditionId AND outcomeIndex
          // For BUY trades, find an existing open BUY trade with same conditionId AND outcomeIndex
          const matchingActivities = await this.activityRepository.find({
            where: {
              whaleId: whale.id,
              activityType: 'POLYMARKET_BUY',
              status: 'open',
            },
            order: {
              activityTimestamp: 'ASC',
            },
          });

          // Filter by conditionId AND outcomeIndex from metadata (TypeORM doesn't easily support JSONB filtering in where clause)
          const currentOutcomeIndex = metadata.outcomeIndex;
          matchingActivity = matchingActivities.find(
            a => a.metadata?.conditionId === conditionId && a.metadata?.outcomeIndex === currentOutcomeIndex
          ) || null;
        }

        // Build alert data
        const alertData = {
          walletAddress: whale.walletAddress,
          traderName: whale.label,
          profileUrl,
          thumbnailUrl: metadata.icon,
          marketLink,
          marketName: metadata.market,
          activityType,
          shares: activity.amount,
          totalShares: positionData.totalShares, // Total shares from position
          totalBought: positionData.totalBought, // Total bought for closed positions
          usdValue: metadata.usdValue,
          activityTimestamp: activity.activityTimestamp,
          transactionHash: activity.transactionHash,
          blockchain: "Polygon",
          additionalInfo: `Outcome: ${metadata.outcome}\nPrice: $${parseFloat(metadata.price).toFixed(2)}`,
          status: activity.status,
          percentPnl: positionData.percentPnl, // PnL percentage
          whaleCategory: whale.category || "regular", // Pass whale category
          tradeCategory: activity.category || undefined, // Pass trade/market category
          subscriptionType: whale.subscriptionType || "free", // Pass subscription type
        };

        // Check if alert should be sent for this status before sending or replying
        const whaleCategory = whale.category || "regular";
        const shouldSend = discordService.shouldSendAlertForStatus(whaleCategory, activity.status);
        
        if (!shouldSend) {
          console.log(
            `⏭️  Skipping Discord notification (status "${activity.status}" disabled for ${whaleCategory} traders) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
          );
          continue;
        }
        
        // Additional check: "added" and "partially_closed" trades should ONLY be sent for whale category whales
        // Regular whales should not receive these status alerts
        if ((activity.status === "added" || activity.status === "partially_closed") && whaleCategory !== "whale") {
          console.log(
            `⏭️  Skipping Discord notification (${activity.status} status only allowed for whale category, not ${whaleCategory}) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
          );
          continue;
        }
        
        // Skip Discord notifications for closed trades with losses (negative percentPnl)
        if (activity.status === "closed" && positionData.percentPnl !== undefined && positionData.percentPnl < 0) {
          console.log(
            `⏭️  Skipping Discord notification (loss detected: ${positionData.percentPnl.toFixed(2)}%) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
          );
          continue;
        }
        
        // Check frequency limit ONLY for initial BUY trades (status = "open") before sending Discord notification
        // Note: This check does NOT apply to:
        // - Closed positions (status = "closed") - always allowed
        // - Partially closed positions (status = "partially_closed") - always allowed
        // - Added BUY trades (status = "added") - always allowed
        // - SELL trades - always allowed
        // Trade is already stored (copytraded), we're only checking if we should send Discord notification
        if (activity.activityType === "POLYMARKET_BUY" && activity.status === "open") {
          const canSend = await this.checkAndDecrementFrequency(whale);
          if (!canSend) {
            console.log(
              `⏭️  Skipping Discord notification for initial BUY trade (frequency limit reached) | ` +
              `Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id} | Trade was still stored for copytrade`
            );
            continue;
          }
          // Frequency has been decremented atomically, Discord notification can proceed
        }
        
        // If we found a matching trade, reply to it; otherwise send new message
        let messageId: string | null = null;
        if (matchingActivity && matchingActivity.discordMessageId) {
          // Reply to existing message
          const embed = discordService.buildWhaleAlertEmbed(alertData, whale.category || "regular");
          messageId = await discordService.replyToMessage(
            matchingActivity.discordMessageId, 
            embed,
            whale.category || "regular",
            activity.category || undefined,
            whale.subscriptionType || "free"
          );
          
          if (messageId) {
            console.log(
              `💬 Replied to existing message | Whale: ${whale.label || whale.walletAddress} | Original: ${matchingActivity.id} | New: ${activity.id}`
            );
          }
        } else {
          // Send new alert
          messageId = await discordService.sendWhaleAlert(alertData);
          
          if (messageId) {
            console.log(
              `📢 Sent new Discord alert | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
            );
          }
        }

        // Store Discord message ID in activity
        if (messageId) {
          activity.discordMessageId = messageId;
          await this.activityRepository.save(activity);
        }
      }

      // Now check positions and update status if needed
      await this.checkAndUpdatePositions(whale, savedActivities);
    } catch (error) {
      console.error(
        `❌ Error polling trades for whale ${whale.label || whale.walletAddress}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Filter out trades that already exist in the database
   */
  private async filterNewTrades(
    whaleId: string,
    trades: PolymarketTrade[]
  ): Promise<PolymarketTrade[]> {
    // Get transaction hashes that already exist
    const transactionHashes = trades
      .map((t) => t.transactionHash)
      .filter((hash) => hash); // Filter out undefined/null

    if (transactionHashes.length === 0) {
      return trades;
    }

    const existingActivities = await this.activityRepository
      .createQueryBuilder("activity")
      .where("activity.whaleId = :whaleId", { whaleId })
      .andWhere("activity.transactionHash IN (:...hashes)", {
        hashes: transactionHashes,
      })
      .select(["activity.transactionHash"])
      .getMany();

    const existingHashes = new Set(
      existingActivities.map((a) => a.transactionHash)
    );

    return trades.filter((trade) => !existingHashes.has(trade.transactionHash));
  }

  /**
   * Check if a market is still open by checking if there are open positions for the specific outcome
   */
  private async isMarketOpen(
    whale: TrackedWhale,
    conditionId: string,
    outcomeIndex: number
  ): Promise<boolean> {
    try {
      const positions = await polymarketService.getUserPositions(
        whale.walletAddress,
        [conditionId]
      );
      // Check if there's an open position for this specific outcome
      return positions.some(p => p.conditionId === conditionId && p.outcomeIndex === outcomeIndex);
    } catch (error) {
      console.error(`❌ Error checking if market is open for conditionId ${conditionId}, outcome ${outcomeIndex}:`, error);
      // Default to false if we can't determine
      return false;
    }
  }

  /**
   * Check if a SELL activity has a matching BUY trade for the same market
   */
  private async hasMatchingBuyTrade(
    activity: WhaleActivity,
    whale: TrackedWhale
  ): Promise<boolean> {
    if (activity.activityType !== "POLYMARKET_SELL") {
      return false;
    }

    const conditionId = activity.metadata?.conditionId;
    if (!conditionId) {
      return false;
    }

    try {
      // Find existing BUY trades for the same conditionId and whale
      const existingBuyTrades = await this.activityRepository.find({
        where: {
          whaleId: whale.id,
          activityType: "POLYMARKET_BUY",
        },
      });

      // Filter by conditionId from metadata
      const matchingBuyTrade = existingBuyTrades.find(
        (a) => a.metadata?.conditionId === conditionId
      );

      return !!matchingBuyTrade;
    } catch (error) {
      console.error(
        `❌ Error checking for matching BUY trade: ${error instanceof Error ? error.message : error}`
      );
      return false;
    }
  }

  /**
   * Check if a BUY trade has an existing BUY trade for the same market AND outcome
   */
  private async hasExistingBuyTrade(
    conditionId: string,
    whaleId: string,
    outcomeIndex: number,
    excludeActivityId?: string
  ): Promise<boolean> {
    try {
      const existingBuyTrades = await this.activityRepository.find({
        where: {
          whaleId,
          activityType: "POLYMARKET_BUY",
        },
      });

      const matchingBuyTrade = existingBuyTrades.find(
        (a) => a.metadata?.conditionId === conditionId && 
               a.metadata?.outcomeIndex === outcomeIndex && 
               a.id !== excludeActivityId
      );

      return !!matchingBuyTrade;
    } catch (error) {
      console.error(
        `❌ Error checking for existing BUY trade: ${error instanceof Error ? error.message : error}`
      );
      return false;
    }
  }

  /**
   * Check if there's an existing BUY trade with "open" status for the same market AND outcome
   */
  private async hasOpenBuyTrade(
    conditionId: string,
    whaleId: string,
    outcomeIndex: number
  ): Promise<boolean> {
    try {
        const existingBuyTrades = await this.activityRepository.find({
          where: {
          whaleId,
            activityType: "POLYMARKET_BUY",
          status: "open",
          },
        });
        
      const matchingOpenBuyTrade = existingBuyTrades.find(
        (a) => a.metadata?.conditionId === conditionId && 
               a.metadata?.outcomeIndex === outcomeIndex
      );

      return !!matchingOpenBuyTrade;
      } catch (error) {
        console.error(
        `❌ Error checking for open BUY trade: ${error instanceof Error ? error.message : error}`
      );
      return false;
    }
  }

  /**
   * Check if a trade meets storage criteria
   * - SELL trades: no filtering (always allow added, partially_closed, closed)
   * - Added BUY trades (with existing buy): no filtering
   * - Initial BUY trades: filtering based on whale category, price <= $0.95
   *   Note: Frequency limit is checked at Discord notification time, not storage time
   */
  private async shouldStoreTrade(
    trade: PolymarketTrade,
    whale: TrackedWhale
  ): Promise<boolean> {
    const usdValue = trade.size * trade.price;
    const price = trade.price;
    
    // SELL trades: no filtering (always allow added, partially_closed, closed statuses)
    if (trade.side === "SELL") {
      return true;
    }
    
    // BUY trades: check if there's an open BUY trade for the same market
    // If there's an open buy, this will be an "added" trade, so no frequency check needed
    if (trade.side === "BUY" && trade.conditionId) {
      const hasOpenParent = await this.hasOpenBuyTrade(trade.conditionId, whale.id, trade.outcomeIndex);
      
      // Added BUY trade (has open buy): no filtering (always allow)
      if (hasOpenParent) {
        return true;
      }
    }
    
    // Initial BUY trade: apply filtering based on whale category and price (frequency is checked at Discord notification time)
    const minUsdValue = this.getMinUsdValueForStorage(whale);
    
    // Check USD value threshold
    if (usdValue < minUsdValue) {
      return false;
    }
    
    // Check price threshold
    if (price > this.MAX_PRICE_FOR_STORAGE) {
      return false;
    }
    
    // Note: Frequency limit check is now done at Discord notification time, not storage time
    // This allows all initial buys to be stored (copytraded) regardless of frequency limits
    
    return true;
  }

  /**
   * Store a trade as a WhaleActivity in the database
   * Only stores trades that meet criteria
   * Determines status (open/added/partially_closed/closed) before saving
   */
  private async storeTrade(
    whale: TrackedWhale,
    trade: PolymarketTrade
  ): Promise<WhaleActivity | null> {
    try {
      // Check if trade meets storage criteria
      if (!(await this.shouldStoreTrade(trade, whale))) {
        const usdValue = trade.size * trade.price;
        const minUsdValue = this.getMinUsdValueForStorage(whale);
        const reason = usdValue < minUsdValue 
          ? `USD value $${usdValue.toFixed(2)} < $${minUsdValue}`
          : `price $${trade.price.toFixed(2)} > $${this.MAX_PRICE_FOR_STORAGE}`;
        // console.log(
        //   `⏭️  Skipping trade storage (${reason}) | Whale: ${whale.label || whale.walletAddress} | Trade: ${trade.transactionHash}`
        // );
        return null;
      }

      // Calculate USD value (size * price)
      const usdValue = (trade.size * trade.price).toFixed(6);

      // Determine status based on trade side and market state
      let status: string | undefined;
      let hasOpenParent = false;
      
      if (trade.side === "BUY") {
        // Check if this is an added buy (duplicate buy on same market with open parent)
        if (trade.conditionId) {
          hasOpenParent = await this.hasOpenBuyTrade(trade.conditionId, whale.id, trade.outcomeIndex);
          if (hasOpenParent) {
            // Added buy trade - there's an open buy for this market
            status = "added";
          } else {
            // Initial buy trade
        status = "open";
          }
        } else {
          // No condition ID, treat as open
          status = "open";
        }
      } else if (trade.side === "SELL") {
        // For SELL trades, check if market is still open for this specific outcome
        const marketIsOpen = await this.isMarketOpen(whale, trade.conditionId, trade.outcomeIndex);
        status = marketIsOpen ? "partially_closed" : "closed";
      }

      // Ensure status is defined before proceeding
      if (!status) {
        console.log(
          `⏭️  Skipping trade with undefined status | Whale: ${whale.label || whale.walletAddress} | Trade: ${trade.side}`
        );
        return null;
      }

      // Note: Frequency limit check is now done at Discord notification time, not storage time
      // This allows all initial buys to be stored (copytraded) regardless of frequency limits

      // Validate that required parent trades exist for non-initial trades
      if (status === "added" || status === "partially_closed" || status === "closed") {
        if (trade.conditionId) {
          // For BUY with "added" status, we already checked hasOpenParent above
          if (trade.side === "SELL") {
            hasOpenParent = await this.hasOpenBuyTrade(trade.conditionId, whale.id, trade.outcomeIndex);
          }
          
          if (!hasOpenParent) {
            // No open buy trade found - skip this trade
            console.log(
              `⏭️  Skipping ${status} ${trade.side} trade (no open BUY trade exists) | Whale: ${whale.label || whale.walletAddress} | Market: ${trade.title}`
            );
            return null;
          }
        } else {
          // No condition ID but status requires parent - skip
          console.log(
            `⏭️  Skipping ${status} ${trade.side} trade (no condition ID) | Whale: ${whale.label || whale.walletAddress} | Trade: ${trade.transactionHash}`
          );
          return null;
        }
      }

      // Detect category from market tags using Polymarket API
      let category: string | undefined;
      
      if (trade.slug) {
        try {
          // Fetch market by slug with tags
          const marketData = await polymarketService.getMarketBySlug(trade.slug, true);
          
          if (marketData?.tags && marketData.tags.length > 0) {
            category = inferCategoryFromTags(marketData.tags);
            console.log(
              `📁 Category inferred from tags for ${whale.label || whale.walletAddress}: "${category}" (market: ${trade.title}, tags: ${marketData.tags.map(t => t.slug).join(", ")})`
            );
          } else {
            // Fallback to keyword-based detection if no tags found
            category = detectCategory(trade.title, trade.slug || trade.eventSlug) || undefined;
            if (category) {
              console.log(
                `📁 Category detected via fallback for ${whale.label || whale.walletAddress}: "${category}" (market: ${trade.title})`
              );
            }
          }
        } catch (error) {
          console.warn(
            `⚠️  Error fetching market tags for slug "${trade.slug}", falling back to keyword detection:`,
            error instanceof Error ? error.message : error
          );
          // Fallback to keyword-based detection on error
          category = detectCategory(trade.title, trade.slug || trade.eventSlug) || undefined;
          if (category) {
            console.log(
              `📁 Category detected via fallback for ${whale.label || whale.walletAddress}: "${category}" (market: ${trade.title})`
            );
          }
        }
      } else {
        // Fallback to keyword-based detection if no slug
        category = detectCategory(trade.title, trade.eventSlug) || undefined;
        if (category) {
          console.log(
            `📁 Category detected via fallback for ${whale.label || whale.walletAddress}: "${category}" (market: ${trade.title})`
          );
        }
      }

      // Create activity record
      const activity = this.activityRepository.create({
        whaleId: whale.id,
        activityType: `POLYMARKET_${trade.side}`,
        transactionHash: trade.transactionHash,
        amount: trade.size.toString(),
        tokenSymbol: "SHARES", // Polymarket trades are always for outcome shares
        fromAddress: trade.side === "SELL" ? trade.proxyWallet : undefined,
        toAddress: trade.side === "BUY" ? trade.proxyWallet : undefined,
        blockchain: "POLYGON",
        category: category || undefined,
        metadata: {
          market: trade.title,
          slug: trade.slug,
          outcome: trade.outcome,
          outcomeIndex: trade.outcomeIndex,
          price: trade.price,
          usdValue,
          eventSlug: trade.eventSlug,
          conditionId: trade.conditionId,
          asset: trade.asset, // Store the full asset/token ID here
          icon: trade.icon,
        },
        activityTimestamp: new Date(trade.timestamp * 1000), // Convert Unix timestamp to Date
        status,
      });

      const savedActivity = await this.activityRepository.save(activity);

      console.log(
        `✅ Stored ${trade.side} trade for ${whale.label || whale.walletAddress}: $${usdValue} | Status: ${status || 'N/A'}`
      );

      // Note: Frequency limit check for initial BUY trades (status = "open") is now done
      // at Discord notification time, not storage time. This allows all initial buys to be
      // stored (copytraded) regardless of frequency limits.

      // Create copytrade position if whale is in copytrade and this is an initial BUY trade (status = "open")
      // Skip "added" buys - they don't create separate positions
      // Skip "partially_closed" SELL trades - only copy trade fully closed positions
      if (whale.isCopytrade) {
        if (trade.side === "BUY" && status === "open") {
          console.log(
            `📊 CopyTrade: Processing initial BUY trade for ${whale.label || whale.walletAddress} | ` +
            `Market: ${trade.title} | Price: $${trade.price}`
          );
          await this.createCopytradePosition(whale, savedActivity, trade, status);
        } else if (trade.side === "SELL" && status === "closed") {
          // Only process fully closed SELL trades, skip partially_closed
          console.log(
            `📊 CopyTrade: Processing SELL trade for ${whale.label || whale.walletAddress} | ` +
            `Status: ${status} | Market: ${trade.title} | Price: $${trade.price}`
          );
          await this.handleCopytradeSell(whale, savedActivity, trade, status);
        }
      }

      return savedActivity;
    } catch (error) {
      console.error("❌ Error storing trade:", error);
      throw error;
    }
  }

  /**
   * Check positions and update activity status
   */
  private async checkAndUpdatePositions(
    whale: TrackedWhale,
    activities: WhaleActivity[]
  ): Promise<void> {
    try {
      // Collect unique conditionIds from activities
      const conditionIds = activities
        .map(a => a.metadata?.conditionId)
        .filter((id): id is string => !!id);

      if (conditionIds.length === 0) {
        return;
      }

      // Fetch current positions
      const positions = await polymarketService.getUserPositions(
        whale.walletAddress,
        conditionIds
      );

      // Fetch closed positions
      const closedPositions = await polymarketService.getUserClosedPositions(
        whale.walletAddress,
        conditionIds
      );

      // Create maps for quick lookup using composite key conditionId:outcomeIndex
      const openPositionMap = new Map<string, any>(
        positions.map(p => [`${p.conditionId}:${p.outcomeIndex}`, p])
      );
      const closedPositionMap = new Map<string, any>(
        closedPositions.map(p => [`${p.conditionId}:${p.outcomeIndex}`, p])
      );

      // Update activities based on position status
      for (const activity of activities) {
        const conditionId = activity.metadata?.conditionId;
        if (!conditionId) continue;

        const metadata = activity.metadata || {};
        const outcomeIndex = metadata.outcomeIndex;
        const positionKey = `${conditionId}:${outcomeIndex}`;
        let updated = false;
        const isSellTrade = activity.activityType === 'POLYMARKET_SELL';
        const oldStatus = activity.status; // Capture old status before updating

        // Check if position is open
        if (openPositionMap.has(positionKey)) {
          const position = openPositionMap.get(positionKey);
          // For SELL trades with open positions, status should be "partially_closed"
          if (isSellTrade && activity.status !== "partially_closed") {
            activity.status = "partially_closed";
            // Calculate custom percentage PnL for this specific partial sale
            const sharesSold = parseFloat(activity.amount || "0");
            const sellPrice = metadata.price ? parseFloat(metadata.price) : 0;
            
            // Try FIFO calculation first for more accurate PnL per sale
            if (sharesSold > 0 && sellPrice > 0 && activity.activityTimestamp) {
              const fifoPnl = await this.calculateFifoPnlForPartialSale(
                whale.id,
                conditionId,
                outcomeIndex,
                sharesSold,
                sellPrice,
                activity.activityTimestamp
              );
              
              if (fifoPnl !== undefined) {
                activity.percentPnl = fifoPnl;
              } else {
                // Fall back to avgPrice calculation if FIFO fails
                const avgBuyPrice = position.avgPrice;
                if (avgBuyPrice > 0) {
                  const costBasis = sharesSold * avgBuyPrice;
                  const proceeds = sharesSold * sellPrice;
                  const profit = proceeds - costBasis;
                  activity.percentPnl = (profit / costBasis) * 100;
                }
              }
            }
            updated = true;
          }
          // For BUY trades, don't change status if it's already "open" or "added"
          // Both are valid states for BUY trades
        }
        // Check if position is closed
        else if (closedPositionMap.has(positionKey)) {
          const closedPosition = closedPositionMap.get(positionKey);
          // Calculate percentage PnL from closed position
          const initialValue = closedPosition.totalBought * closedPosition.avgPrice;
          const percentPnl = initialValue > 0 && closedPosition.realizedPnl !== undefined
            ? (closedPosition.realizedPnl / initialValue) * 100
            : undefined;
          
          const wasNotClosed = activity.status !== "closed";
          
          // Check if this activity was already processed by checkFullyClosedPositions BEFORE we update metadata
          // This prevents duplicate alerts for the same closed position
          const activityMetadata = activity.metadata || {};
          // Check both exitPrice and gainzAlertSent flag to prevent duplicates
          const wasHandledByFullyClosedCheck = activityMetadata.exitPrice !== undefined || activityMetadata.gainzAlertSent === true;
          
          // Calculate exit price using formula: Average Exit Price = (Total Cost + Realized PnL) / Total Bought
          const totalCost = closedPosition.totalBought * closedPosition.avgPrice;
          const calculatedExitPrice = closedPosition.totalBought > 0 && closedPosition.realizedPnl !== undefined
            ? (totalCost + closedPosition.realizedPnl) / closedPosition.totalBought
            : closedPosition.curPrice; // Fallback to curPrice if calculation not possible
          
          // Determine realized outcome based on PNL sign
          // If PNL is positive, trader won (use closedPosition.outcome)
          // If PNL is negative, trader lost (use closedPosition.oppositeOutcome)
          let realizedOutcome: string | undefined;
          if (closedPosition.realizedPnl !== undefined) {
            if (closedPosition.realizedPnl >= 0) {
              realizedOutcome = closedPosition.outcome;
            } else {
              realizedOutcome = closedPosition.oppositeOutcome;
            }
          }
          
          // Update metadata with exit price and realized outcome (only if not already set)
          if (!metadata.exitPrice) {
            metadata.exitPrice = calculatedExitPrice;
          }
          if (!metadata.realizedOutcome && realizedOutcome) {
            metadata.realizedOutcome = realizedOutcome;
          }
          
          // Update activity metadata (only if not already set)
          if (!activity.metadata) {
            activity.metadata = {};
          }
          if (!activity.metadata.exitPrice) {
            activity.metadata.exitPrice = calculatedExitPrice;
          }
          if (!activity.metadata.realizedOutcome && realizedOutcome) {
            activity.metadata.realizedOutcome = realizedOutcome;
          }
          
          if (activity.status !== "closed" || activity.realizedPnl !== closedPosition.realizedPnl?.toString()) {
            activity.status = "closed";
            activity.realizedPnl = closedPosition.realizedPnl?.toString();
            activity.percentPnl = percentPnl ?? undefined;
            updated = true;
          }
          
          // Note: Gainz alerts are sent from checkFullyClosedPositions to avoid duplicates
          // Only send gainz alert here if this activity wasn't handled by checkFullyClosedPositions
          // (i.e., if it was already closed before checkFullyClosedPositions ran)
          // This prevents duplicate alerts for the same closed position
          // Only send for positive PnL (losses are skipped)
          if (wasNotClosed && percentPnl !== undefined && percentPnl >= 0 && !wasHandledByFullyClosedCheck) {
            // Use updated metadata with exitPrice and realizedOutcome
            await this.sendGainzAlertForActivity(activity, whale, metadata);
            // Mark that we sent the alert to prevent duplicates
            if (!activity.metadata) {
              activity.metadata = {};
            }
            activity.metadata.gainzAlertSent = true;
          }
        }

        // If activity was updated, save and update Discord
        if (updated) {
          await this.activityRepository.save(activity);
          console.log(
            `📝 Activity status updated | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id} | Status: ${activity.status}${activity.realizedPnl ? ` | PnL: $${activity.realizedPnl}` : ""}`
          );

          // Update Discord message if message ID exists
          // Apply filtering: SELL and added BUY trades skip filters, initial BUY trades apply filters
          const usdValue = metadata.usdValue ? parseFloat(metadata.usdValue) : 0;
          const price = metadata.price ? parseFloat(metadata.price) : null;
          const isSell = activity.activityType === 'POLYMARKET_SELL';
          const isAddedBuy = activity.status === 'added';
          const shouldUpdate = activity.discordMessageId && 
            ((isSell || isAddedBuy) || (usdValue >= this.MIN_USD_VALUE_FOR_DISCORD && price !== null && price <= 0.95));
          
          if (shouldUpdate) {
            const profileUrl = `https://polymarket.com/profile/${whale.walletAddress}`;
            const marketLink = metadata.slug
              ? `https://polymarket.com/market/${metadata.slug}`
              : undefined;

            // Fetch position data for PnL and total shares
            let positionData: {
              totalShares?: number;
              percentPnl?: number;
              totalBought?: number;
            } = {};

            try {
              // Get position from open positions first using composite key
              const position = openPositionMap.get(positionKey);
              
                if (position) {
                // Position found in open positions
                  positionData.totalShares = position.size;
                
                // For SELL trades, calculate custom percentage PnL for this specific partial sale
                if (isSell && activity.status === "partially_closed") {
                  const sharesSold = parseFloat(activity.amount || "0");
                  const sellPrice = metadata.price ? parseFloat(metadata.price) : 0;
                  const avgBuyPrice = position.avgPrice;
                  
                  if (sharesSold > 0 && sellPrice > 0 && avgBuyPrice > 0) {
                    const costBasis = sharesSold * avgBuyPrice;
                    const proceeds = sharesSold * sellPrice;
                    const profit = proceeds - costBasis;
                    positionData.percentPnl = (profit / costBasis) * 100;
                  }
                } else if (isSell && activity.status === "closed" && position.percentRealizedPnl !== undefined) {
                  // For fully closed trades, use percentRealizedPnl
                  positionData.percentPnl = position.percentRealizedPnl;
                } else {
                  // For BUY trades, use percentPnl
                  positionData.percentPnl = position.percentPnl;
                }
              } else {
                // Position not in open positions - check closed positions using composite key
                const closedPosition = closedPositionMap.get(positionKey);
                if (closedPosition) {
                  positionData.totalBought = closedPosition.totalBought;
                  positionData.totalShares = 0; // For fully closed positions, remaining shares is 0
                  // Calculate percentage PnL: (realizedPnl / initialValue) * 100
                  const initialValue = closedPosition.totalBought * closedPosition.avgPrice;
                  if (initialValue > 0 && closedPosition.realizedPnl !== undefined) {
                    positionData.percentPnl = (closedPosition.realizedPnl / initialValue) * 100;
                  }
                } else if (activity.status === "closed") {
                  // Fully closed but not in closed positions yet
                  positionData.totalShares = 0;
                }
              }
            } catch (error) {
              console.warn(`⚠️  Failed to fetch position data for update:`, error);
            }

            // Check if transitioning from partially_closed to closed - need to reply instead of edit
            const isTransitionToClosed = oldStatus === "partially_closed" && activity.status === "closed";

            if (isTransitionToClosed && isSell) {
              // Find the parent "open" BUY trade message to reply to
              const matchingActivities = await this.activityRepository.find({
                where: {
                  whaleId: whale.id,
                  activityType: 'POLYMARKET_BUY',
                  status: 'open',
                },
                order: {
                  activityTimestamp: 'ASC',
                },
              });

              const matchingActivity = matchingActivities.find(
                a => a.metadata?.conditionId === conditionId && a.metadata?.outcomeIndex === outcomeIndex
              );

              if (matchingActivity && matchingActivity.discordMessageId) {
                console.log(
                  `💬 Transitioning to closed - replying to parent message | Whale: ${whale.label || whale.walletAddress} | Original: ${matchingActivity.id} | New: ${activity.id}`
                );

                const embed = discordService.buildWhaleAlertEmbed({
                  walletAddress: whale.walletAddress,
                  traderName: whale.label,
                  profileUrl,
                  thumbnailUrl: metadata.icon,
                  marketLink,
                  marketName: metadata.market,
                  activityType: activity.activityType.replace('POLYMARKET_', ''),
                  shares: activity.amount,
                  totalShares: positionData.totalShares,
                  totalBought: positionData.totalBought,
                  usdValue: metadata.usdValue,
                  activityTimestamp: activity.activityTimestamp,
                  transactionHash: activity.transactionHash,
                  blockchain: "Polygon",
                  additionalInfo: `Outcome: ${metadata.outcome}\nPrice: $${parseFloat(metadata.price).toFixed(2)}`,
                  status: activity.status,
                  realizedPnl: activity.realizedPnl,
                  percentPnl: positionData.percentPnl,
                  whaleCategory: whale.category || "regular",
                  tradeCategory: activity.category || undefined,
                  subscriptionType: whale.subscriptionType || "free",
                }, whale.category || "regular");

                // Check if alert should be sent for this status
                const whaleCategoryForCheck = whale.category || "regular";
                if (!discordService.shouldSendAlertForStatus(whaleCategoryForCheck, activity.status)) {
                  console.log(
                    `⏭️  Skipping Discord reply (status "${activity.status}" disabled for ${whaleCategoryForCheck} traders) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                  );
                } else {
                  // Additional check: "added" and "partially_closed" trades should ONLY be sent for whale category whales
                  if ((activity.status === "added" || activity.status === "partially_closed") && whaleCategoryForCheck !== "whale") {
                    console.log(
                      `⏭️  Skipping Discord reply (${activity.status} status only allowed for whale category, not ${whaleCategoryForCheck}) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                    );
                  } else {
                    const replyMessageId = await discordService.replyToMessage(
                      matchingActivity.discordMessageId, 
                      embed,
                      whale.category || "regular",
                      activity.category || undefined,
                      whale.subscriptionType || "free"
                    );
                    
                    if (replyMessageId) {
                      activity.discordMessageId = replyMessageId;
                      await this.activityRepository.save(activity);
                    }
                  }
                }
              } else {
                console.warn(
                  `⚠️  Cannot reply - no parent open BUY trade found | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                );
              }
            } else {
              // Normal update (not transitioning to closed)
            console.log(
              `🔄 Attempting to update Discord message | Whale: ${whale.label || whale.walletAddress} | Message ID: ${activity.discordMessageId} | Status: ${activity.status}`
            );

              // Skip Discord updates for closed trades with losses (negative percentPnl)
              if (activity.status === "closed" && positionData.percentPnl !== undefined && positionData.percentPnl < 0) {
                console.log(
                  `⏭️  Skipping Discord update (loss detected: ${positionData.percentPnl.toFixed(2)}%) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                );
              } else {
                // Additional check: "added" and "partially_closed" trades should ONLY be sent for whale category whales
                const whaleCategoryForUpdate = whale.category || "regular";
                if ((activity.status === "added" || activity.status === "partially_closed") && whaleCategoryForUpdate !== "whale") {
                  console.log(
                    `⏭️  Skipping Discord update (${activity.status} status only allowed for whale category, not ${whaleCategoryForUpdate}) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                  );
                } else {
                  // activity.discordMessageId is guaranteed to be defined by the if condition above
                  const updateSuccess = await discordService.updateWhaleAlert(activity.discordMessageId!, {
                walletAddress: whale.walletAddress,
                traderName: whale.label,
                profileUrl,
                thumbnailUrl: metadata.icon,
                marketLink,
                marketName: metadata.market,
                activityType: activity.activityType.replace('POLYMARKET_', ''),
                shares: activity.amount,
                totalShares: positionData.totalShares,
                totalBought: positionData.totalBought,
                usdValue: metadata.usdValue,
                activityTimestamp: activity.activityTimestamp,
                transactionHash: activity.transactionHash,
                blockchain: "Polygon",
                additionalInfo: `Outcome: ${metadata.outcome}\nPrice: $${parseFloat(metadata.price).toFixed(2)}`,
                status: activity.status,
                realizedPnl: activity.realizedPnl,
                percentPnl: positionData.percentPnl,
                whaleCategory: whale.category || "regular",
                tradeCategory: activity.category || undefined,
              });

                  if (!updateSuccess) {
                    console.warn(
                      `⚠️  Discord message update failed | Whale: ${whale.label || whale.walletAddress} | Message ID: ${activity.discordMessageId}`
                    );
                  }
                }
              }
            }
          } else if (activity.discordMessageId && !shouldUpdate) {
            const reason = usdValue < this.MIN_USD_VALUE_FOR_DISCORD 
              ? `USD value $${usdValue.toFixed(2)} < $${this.MIN_USD_VALUE_FOR_DISCORD}`
              : price === null 
                ? `price is null`
                : `price $${price.toFixed(2)} > $0.95`;
            console.log(
              `⏭️  Skipping Discord update (${reason}) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
            );
          } else {
            console.warn(
              `⚠️  No Discord message ID stored for activity | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
            );
          }
        }
      }
    } catch (error) {
      console.error("❌ Error checking positions:", error);
    }
  }

  /**
   * Check all whale positions for status updates
   */
  private async checkAllWhalePositions(): Promise<void> {
    if (this.isCheckingPositions) {
      console.log("⏭️  Skipping position check - previous check still in progress");
      return;
    }

    this.isCheckingPositions = true;

    try {
      // Fetch all active tracked whales
      const activeWhales = await this.whaleRepository.find({
        where: { isActive: true },
      });

      if (activeWhales.length === 0) {
        console.log("ℹ️  No active whales to check positions for");
        return;
      }

      console.log(`📊 Checking positions for ${activeWhales.length} whale(s)...`);

      // Process each whale
      const results = await Promise.allSettled(
        activeWhales.map((whale) => this.checkWhalePositions(whale))
      );

      // Log results
      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      console.log(`✅ Position check complete: ${successful} successful, ${failed} failed`);
    } catch (error) {
      console.error("❌ Error checking whale positions:", error);
    } finally {
      this.isCheckingPositions = false;
    }
  }

  /**
   * Check positions for a specific whale and update statuses
   */
  private async checkWhalePositions(whale: TrackedWhale): Promise<void> {
    try {
      // First, check for fully closed positions by comparing open BUY trades with closed positions
      // This is the NEW logic for detecting fully closed trades
      await this.checkFullyClosedPositions(whale);

      // Then, continue with the existing logic for partially closed and other status updates
      // Fetch activities without status or with "open" or "partially_closed" status
      // Need to check partially_closed activities because they might have become fully closed
      const activitiesToCheck = await this.activityRepository.find({
        where: [
          { whaleId: whale.id, status: IsNull() },
          { whaleId: whale.id, status: "open" },
          { whaleId: whale.id, status: "partially_closed" }
        ],
        order: { activityTimestamp: "DESC" },
      });

      if (activitiesToCheck.length === 0) {
        return;
      }

      console.log(
        `📋 Checking ${activitiesToCheck.length} activities for ${whale.label || whale.walletAddress}`
      );

      // Collect unique conditionIds from all activities to check
      const conditionIds = Array.from(
        new Set(
          activitiesToCheck
            .map(a => a.metadata?.conditionId)
            .filter((id): id is string => !!id)
        )
      );

      if (conditionIds.length === 0) {
        return;
      }

      // Fetch current positions
      const positions = await polymarketService.getUserPositions(
        whale.walletAddress,
        conditionIds
      );

      // Fetch closed positions (for partially_closed detection, not fully closed)
      const closedPositions = await polymarketService.getUserClosedPositions(
        whale.walletAddress,
        conditionIds
      );

      // Create maps for quick lookup using composite key conditionId:outcomeIndex
      const openPositionMap = new Map<string, any>(
        positions.map(p => [`${p.conditionId}:${p.outcomeIndex}`, p])
      );
      const closedPositionMap = new Map<string, any>(
        closedPositions.map(p => [`${p.conditionId}:${p.outcomeIndex}`, p])
      );

      // Update activities based on position status
      for (const activity of activitiesToCheck) {
        const conditionId = activity.metadata?.conditionId;
        if (!conditionId) continue;

        const metadata = activity.metadata || {};
        const outcomeIndex = metadata.outcomeIndex;
        const positionKey = `${conditionId}:${outcomeIndex}`;
        let updated = false;
        const isSellTrade = activity.activityType === 'POLYMARKET_SELL';
        const oldStatus = activity.status; // Capture old status before updating

        // Check if position is open
        if (openPositionMap.has(positionKey)) {
          const position = openPositionMap.get(positionKey);
          // For SELL trades with open positions, status should be "partially_closed"
          if (isSellTrade && activity.status !== "partially_closed") {
            activity.status = "partially_closed";
            // Calculate custom percentage PnL for this specific partial sale
            const sharesSold = parseFloat(activity.amount || "0");
            const sellPrice = metadata.price ? parseFloat(metadata.price) : 0;
            
            // Try FIFO calculation first for more accurate PnL per sale
            if (sharesSold > 0 && sellPrice > 0 && activity.activityTimestamp) {
              const fifoPnl = await this.calculateFifoPnlForPartialSale(
                whale.id,
                conditionId,
                outcomeIndex,
                sharesSold,
                sellPrice,
                activity.activityTimestamp
              );
              
              if (fifoPnl !== undefined) {
                activity.percentPnl = fifoPnl;
              } else {
                // Fall back to avgPrice calculation if FIFO fails
                const avgBuyPrice = position.avgPrice;
                if (avgBuyPrice > 0) {
                  const costBasis = sharesSold * avgBuyPrice;
                  const proceeds = sharesSold * sellPrice;
                  const profit = proceeds - costBasis;
                  activity.percentPnl = (profit / costBasis) * 100;
                }
              }
            }
            updated = true;
          }
          // For BUY trades, don't change status if it's already "open" or "added"
          // Both are valid states for BUY trades
        }
        // Check if position is closed
        else if (closedPositionMap.has(positionKey)) {
          const closedPosition = closedPositionMap.get(positionKey);
          // Calculate percentage PnL from closed position
          const initialValue = closedPosition.totalBought * closedPosition.avgPrice;
          const percentPnl = initialValue > 0 && closedPosition.realizedPnl !== undefined
            ? (closedPosition.realizedPnl / initialValue) * 100
            : undefined;
          
          const wasNotClosed = activity.status !== "closed";
          
          // Check if this activity was already processed by checkFullyClosedPositions BEFORE we update metadata
          // This prevents duplicate alerts for the same closed position
          const activityMetadata = activity.metadata || {};
          // Check both exitPrice and gainzAlertSent flag to prevent duplicates
          const wasHandledByFullyClosedCheck = activityMetadata.exitPrice !== undefined || activityMetadata.gainzAlertSent === true;
          
          // Calculate exit price using formula: Average Exit Price = (Total Cost + Realized PnL) / Total Bought
          const totalCost = closedPosition.totalBought * closedPosition.avgPrice;
          const calculatedExitPrice = closedPosition.totalBought > 0 && closedPosition.realizedPnl !== undefined
            ? (totalCost + closedPosition.realizedPnl) / closedPosition.totalBought
            : closedPosition.curPrice; // Fallback to curPrice if calculation not possible
          
          // Determine realized outcome based on PNL sign
          // If PNL is positive, trader won (use closedPosition.outcome)
          // If PNL is negative, trader lost (use closedPosition.oppositeOutcome)
          let realizedOutcome: string | undefined;
          if (closedPosition.realizedPnl !== undefined) {
            if (closedPosition.realizedPnl >= 0) {
              realizedOutcome = closedPosition.outcome;
            } else {
              realizedOutcome = closedPosition.oppositeOutcome;
            }
          }
          
          // Update metadata with exit price and realized outcome (only if not already set)
          if (!metadata.exitPrice) {
            metadata.exitPrice = calculatedExitPrice;
          }
          if (!metadata.realizedOutcome && realizedOutcome) {
            metadata.realizedOutcome = realizedOutcome;
          }
          
          // Update activity metadata (only if not already set)
          if (!activity.metadata) {
            activity.metadata = {};
          }
          if (!activity.metadata.exitPrice) {
            activity.metadata.exitPrice = calculatedExitPrice;
          }
          if (!activity.metadata.realizedOutcome && realizedOutcome) {
            activity.metadata.realizedOutcome = realizedOutcome;
          }
          
          if (activity.status !== "closed" || activity.realizedPnl !== closedPosition.realizedPnl?.toString()) {
            activity.status = "closed";
            activity.realizedPnl = closedPosition.realizedPnl?.toString();
            activity.percentPnl = percentPnl ?? undefined;
            updated = true;
          }
          
          // Note: Gainz alerts are sent from checkFullyClosedPositions to avoid duplicates
          // Only send gainz alert here if this activity wasn't handled by checkFullyClosedPositions
          // (i.e., if it was already closed before checkFullyClosedPositions ran)
          // This prevents duplicate alerts for the same closed position
          // Only send for positive PnL (losses are skipped)
          if (wasNotClosed && percentPnl !== undefined && percentPnl >= 0 && !wasHandledByFullyClosedCheck) {
            // Use updated metadata with exitPrice and realizedOutcome
            await this.sendGainzAlertForActivity(activity, whale, metadata);
            // Mark that we sent the alert to prevent duplicates
            if (!activity.metadata) {
              activity.metadata = {};
            }
            activity.metadata.gainzAlertSent = true;
          }
        }

        // If activity was updated, save and update Discord
        if (updated) {
          await this.activityRepository.save(activity);
          console.log(
            `📝 Activity status updated | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id} | Status: ${activity.status}${activity.realizedPnl ? ` | PnL: $${activity.realizedPnl}` : ""}`
          );

          // Update Discord message if message ID exists
          // Apply filtering: SELL and added BUY trades skip filters, initial BUY trades apply filters
          const usdValue = metadata.usdValue ? parseFloat(metadata.usdValue) : 0;
          const price = metadata.price ? parseFloat(metadata.price) : null;
          const isSell = activity.activityType === 'POLYMARKET_SELL';
          const isAddedBuy = activity.status === 'added';
          const shouldUpdate = activity.discordMessageId && 
            ((isSell || isAddedBuy) || (usdValue >= this.MIN_USD_VALUE_FOR_DISCORD && price !== null && price <= 0.95));
          
          if (shouldUpdate) {
            const profileUrl = `https://polymarket.com/profile/${whale.walletAddress}`;
            const marketLink = metadata.slug
              ? `https://polymarket.com/market/${metadata.slug}`
              : undefined;

            // Fetch position data for PnL and total shares
            let positionData: {
              totalShares?: number;
              percentPnl?: number;
              totalBought?: number;
            } = {};

            try {
              // Get position from open positions first using composite key
              const position = openPositionMap.get(positionKey);
              
                if (position) {
                // Position found in open positions
                  positionData.totalShares = position.size;
                
                // For SELL trades, calculate custom percentage PnL for this specific partial sale
                if (isSell && activity.status === "partially_closed") {
                  const sharesSold = parseFloat(activity.amount || "0");
                  const sellPrice = metadata.price ? parseFloat(metadata.price) : 0;
                  const avgBuyPrice = position.avgPrice;
                  
                  if (sharesSold > 0 && sellPrice > 0 && avgBuyPrice > 0) {
                    const costBasis = sharesSold * avgBuyPrice;
                    const proceeds = sharesSold * sellPrice;
                    const profit = proceeds - costBasis;
                    positionData.percentPnl = (profit / costBasis) * 100;
                  }
                } else if (isSell && activity.status === "closed" && position.percentRealizedPnl !== undefined) {
                  // For fully closed trades, use percentRealizedPnl
                  positionData.percentPnl = position.percentRealizedPnl;
                } else {
                  // For BUY trades, use percentPnl
                  positionData.percentPnl = position.percentPnl;
                }
              } else {
                // Position not in open positions - check closed positions using composite key
                const closedPosition = closedPositionMap.get(positionKey);
                if (closedPosition) {
                  positionData.totalBought = closedPosition.totalBought;
                  positionData.totalShares = 0; // For fully closed positions, remaining shares is 0
                  // Calculate percentage PnL: (realizedPnl / initialValue) * 100
                  const initialValue = closedPosition.totalBought * closedPosition.avgPrice;
                  if (initialValue > 0 && closedPosition.realizedPnl !== undefined) {
                    positionData.percentPnl = (closedPosition.realizedPnl / initialValue) * 100;
                  }
                } else if (activity.status === "closed") {
                  // Fully closed but not in closed positions yet
                  positionData.totalShares = 0;
                }
              }
            } catch (error) {
              console.warn(`⚠️  Failed to fetch position data for update:`, error);
            }

            // Check if transitioning from partially_closed to closed - need to reply instead of edit
            const isTransitionToClosed = oldStatus === "partially_closed" && activity.status === "closed";

            if (isTransitionToClosed && isSell) {
              // Find the parent "open" BUY trade message to reply to
              const matchingActivities = await this.activityRepository.find({
                where: {
                  whaleId: whale.id,
                  activityType: 'POLYMARKET_BUY',
                  status: 'open',
                },
                order: {
                  activityTimestamp: 'ASC',
                },
              });

              const matchingActivity = matchingActivities.find(
                a => a.metadata?.conditionId === conditionId && a.metadata?.outcomeIndex === outcomeIndex
              );

              if (matchingActivity && matchingActivity.discordMessageId) {
                console.log(
                  `💬 Transitioning to closed - replying to parent message | Whale: ${whale.label || whale.walletAddress} | Original: ${matchingActivity.id} | New: ${activity.id}`
                );

                const embed = discordService.buildWhaleAlertEmbed({
                  walletAddress: whale.walletAddress,
                  traderName: whale.label,
                  profileUrl,
                  thumbnailUrl: metadata.icon,
                  marketLink,
                  marketName: metadata.market,
                  activityType: activity.activityType.replace('POLYMARKET_', ''),
                  shares: activity.amount,
                  totalShares: positionData.totalShares,
                  totalBought: positionData.totalBought,
                  usdValue: metadata.usdValue,
                  activityTimestamp: activity.activityTimestamp,
                  transactionHash: activity.transactionHash,
                  blockchain: "Polygon",
                  additionalInfo: `Outcome: ${metadata.outcome}\nPrice: $${parseFloat(metadata.price).toFixed(2)}`,
                  status: activity.status,
                  realizedPnl: activity.realizedPnl,
                  percentPnl: positionData.percentPnl,
                  whaleCategory: whale.category || "regular",
                  tradeCategory: activity.category || undefined,
                  subscriptionType: whale.subscriptionType || "free",
                }, whale.category || "regular");

                // Check if alert should be sent for this status
                const whaleCategoryForCheck = whale.category || "regular";
                if (!discordService.shouldSendAlertForStatus(whaleCategoryForCheck, activity.status)) {
                  console.log(
                    `⏭️  Skipping Discord reply (status "${activity.status}" disabled for ${whaleCategoryForCheck} traders) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                  );
                } else {
                  // Additional check: "added" and "partially_closed" trades should ONLY be sent for whale category whales
                  if ((activity.status === "added" || activity.status === "partially_closed") && whaleCategoryForCheck !== "whale") {
                    console.log(
                      `⏭️  Skipping Discord reply (${activity.status} status only allowed for whale category, not ${whaleCategoryForCheck}) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                    );
                  } else {
                    const replyMessageId = await discordService.replyToMessage(
                      matchingActivity.discordMessageId, 
                      embed,
                      whale.category || "regular",
                      activity.category || undefined,
                      whale.subscriptionType || "free"
                    );
                    
                    if (replyMessageId) {
                      activity.discordMessageId = replyMessageId;
                      await this.activityRepository.save(activity);
                    }
                  }
                }
              } else {
                console.warn(
                  `⚠️  Cannot reply - no parent open BUY trade found | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                );
              }
            } else {
              // Normal update (not transitioning to closed)
            console.log(
              `🔄 Attempting to update Discord message | Whale: ${whale.label || whale.walletAddress} | Message ID: ${activity.discordMessageId} | Status: ${activity.status}`
            );

              // Skip Discord updates for closed trades with losses (negative percentPnl)
              if (activity.status === "closed" && positionData.percentPnl !== undefined && positionData.percentPnl < 0) {
                console.log(
                  `⏭️  Skipping Discord update (loss detected: ${positionData.percentPnl.toFixed(2)}%) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                );
              } else {
                // Additional check: "added" and "partially_closed" trades should ONLY be sent for whale category whales
                const whaleCategoryForUpdate = whale.category || "regular";
                if ((activity.status === "added" || activity.status === "partially_closed") && whaleCategoryForUpdate !== "whale") {
                  console.log(
                    `⏭️  Skipping Discord update (${activity.status} status only allowed for whale category, not ${whaleCategoryForUpdate}) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
                  );
                } else {
                  // activity.discordMessageId is guaranteed to be defined by the if condition above
                  const updateSuccess = await discordService.updateWhaleAlert(activity.discordMessageId!, {
                walletAddress: whale.walletAddress,
                traderName: whale.label,
                profileUrl,
                thumbnailUrl: metadata.icon,
                marketLink,
                marketName: metadata.market,
                activityType: activity.activityType.replace('POLYMARKET_', ''),
                shares: activity.amount,
                totalShares: positionData.totalShares,
                totalBought: positionData.totalBought,
                usdValue: metadata.usdValue,
                activityTimestamp: activity.activityTimestamp,
                transactionHash: activity.transactionHash,
                blockchain: "Polygon",
                additionalInfo: `Outcome: ${metadata.outcome}\nPrice: $${parseFloat(metadata.price).toFixed(2)}`,
                status: activity.status,
                realizedPnl: activity.realizedPnl,
                percentPnl: positionData.percentPnl,
                whaleCategory: whale.category || "regular",
                tradeCategory: activity.category || undefined,
              });

                  if (!updateSuccess) {
                    console.warn(
                      `⚠️  Discord message update failed | Whale: ${whale.label || whale.walletAddress} | Message ID: ${activity.discordMessageId}`
                    );
                  }
                }
              }
            }
          } else if (activity.discordMessageId && !shouldUpdate) {
            const reason = usdValue < this.MIN_USD_VALUE_FOR_DISCORD 
              ? `USD value $${usdValue.toFixed(2)} < $${this.MIN_USD_VALUE_FOR_DISCORD}`
              : price === null 
                ? `price is null`
                : `price $${price.toFixed(2)} > $0.95`;
            console.log(
              `⏭️  Skipping Discord update (${reason}) | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
            );
          } else {
            console.warn(
              `⚠️  No Discord message ID stored for activity | Whale: ${whale.label || whale.walletAddress} | Activity: ${activity.id}`
            );
          }
        }
      }
    } catch (error) {
      console.error(
        `❌ Error checking positions for whale ${whale.label || whale.walletAddress}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Handle SELL trades for copytrade positions
   * Matches SELL trades to open copytrade positions using FIFO
   */
  private async handleCopytradeSell(
    whale: TrackedWhale,
    activity: WhaleActivity,
    trade: PolymarketTrade,
    status: string
  ): Promise<void> {
    try {
      if (!trade.conditionId || trade.outcomeIndex === undefined) {
        return;
      }

      // Find or create CopyTradeWallet for this tracked whale
      let copytradeWallet = await this.copytradeWalletRepository.findOne({
        where: { trackedWhaleId: whale.id },
      });

      if (!copytradeWallet) {
        // Create a virtual CopyTradeWallet for this tracked whale
        const investment = whale.copytradeInvestment || 500;
        copytradeWallet = this.copytradeWalletRepository.create({
          walletAddress: whale.walletAddress,
          label: whale.label || `Whale: ${whale.walletAddress.slice(0, 8)}`,
          subscriptionType: whale.subscriptionType || "free",
          simulatedInvestment: investment,
          durationHours: 24,
          partialClosePercentage: 100, // Default 100%
          isActive: true,
          trackedWhaleId: whale.id,
        });
        copytradeWallet = await this.copytradeWalletRepository.save(copytradeWallet);
      }

      // Find all open copytrade positions for this market/outcome (FIFO order)
      const openPositions = await this.copytradePositionRepository.find({
        where: {
          copyTradeWalletId: copytradeWallet.id,
          conditionId: trade.conditionId,
          outcomeIndex: trade.outcomeIndex,
          status: "open",
        },
        order: {
          entryDate: "ASC", // FIFO: oldest first
        },
      });

      if (openPositions.length === 0) {
        console.log(
          `⚠️  No open copytrade positions found for SELL trade | Whale: ${whale.label || whale.walletAddress} | Market: ${trade.title}`
        );
        return;
      }

      const exitPrice = parseFloat(trade.price.toString());
      const sharesSoldByWhale = parseFloat(trade.size.toString());
      const partialClosePct = copytradeWallet.partialClosePercentage || 100;
      
      // Calculate total shares we have in open positions for this market/outcome
      const totalOurShares = openPositions.reduce((sum, pos) => sum + parseFloat(pos.sharesBought), 0);
      
      let actualSharesToSell: number;
      
      if (status === "closed") {
        // Fully closed: sell all our shares
        actualSharesToSell = totalOurShares;
      } else {
        // Partially closed: calculate based on partial close percentage
        // Step 1: Calculate what % of whale's tracked position was sold
        // (Our tracked positions represent the whale's buys we've copied)
        const whalePositionPercentageSold = totalOurShares > 0 
          ? sharesSoldByWhale / totalOurShares 
          : 0;
        
        // Step 2: Cap at 100% (whale can't sell more than we have tracked)
        const cappedPercentage = Math.min(whalePositionPercentageSold, 1.0);
        
        // Step 3: Apply our partial close percentage setting
        // If whale sold 50% of their position and partialClosePct = 100%, we sell 50% of ours
        // If whale sold 50% and partialClosePct = 50%, we sell 25% of ours
        const ourPositionPercentageToSell = cappedPercentage * (partialClosePct / 100);
        
        // Step 4: Calculate our shares to sell
        const sharesToSell = totalOurShares * ourPositionPercentageToSell;
        actualSharesToSell = Math.min(sharesToSell, totalOurShares);
        
        console.log(
          `📊 CopyTrade Partial Close: Whale sold ${sharesSoldByWhale.toFixed(2)} shares ` +
          `(${(cappedPercentage * 100).toFixed(1)}% of tracked position). ` +
          `With ${partialClosePct}% setting, selling ${(ourPositionPercentageToSell * 100).toFixed(1)}% ` +
          `(${actualSharesToSell.toFixed(2)} shares) of our ${totalOurShares.toFixed(2)} shares.`
        );
      }

      let remainingSharesToSell = actualSharesToSell;

      // Apply FIFO: sell from oldest positions first
      for (const position of openPositions) {
        if (remainingSharesToSell <= 0) break;

        const positionShares = parseFloat(position.sharesBought);
        const sharesToSellFromThis = Math.min(remainingSharesToSell, positionShares);
        const remainingShares = positionShares - sharesToSellFromThis;

        // Calculate PnL for this position
        const entryPrice = parseFloat(position.entryPrice);
        const costBasis = sharesToSellFromThis * entryPrice;
        const proceeds = sharesToSellFromThis * exitPrice;
        const realizedPnl = proceeds - costBasis;
        const percentPnl = (realizedPnl / costBasis) * 100;
        const finalValue = position.simulatedInvestment + realizedPnl;

        if (remainingShares > 0) {
          // Partial close: update position
          position.status = "partially_closed";
          position.sharesSold = sharesToSellFromThis.toString();
          position.sharesBought = remainingShares.toString(); // Update remaining shares
          position.exitPrice = exitPrice.toString();
          position.exitDate = new Date(trade.timestamp * 1000);
          position.exitTransactionHash = trade.transactionHash;
          position.realizedPnl = realizedPnl.toString();
          position.percentPnl = percentPnl;
          position.finalValue = finalValue;
        } else {
          // Full close: mark as closed
          position.status = "closed";
          position.sharesSold = sharesToSellFromThis.toString();
          position.exitPrice = exitPrice.toString();
          position.exitDate = new Date(trade.timestamp * 1000);
          position.exitTransactionHash = trade.transactionHash;
          position.realizedPnl = realizedPnl.toString();
          position.percentPnl = percentPnl;
          position.finalValue = finalValue;
        }

        await this.copytradePositionRepository.save(position);
        remainingSharesToSell -= sharesToSellFromThis;

        console.log(
          `📊 Updated copytrade position (${position.status}) for ${whale.label || whale.walletAddress}: ` +
          `Sold ${sharesToSellFromThis.toFixed(2)} shares @ $${exitPrice.toFixed(4)} | ` +
          `PnL: $${realizedPnl.toFixed(2)} (${percentPnl.toFixed(2)}%) | Market: ${trade.title}`
        );

        // Update Google Sheets only for fully closed positions (skip partially_closed)
        if (position.status === "closed") {
          try {
            await googleSheetsService.updatePosition(position.id, {
              exitDate: position.exitDate,
              exitPrice: position.exitPrice,
              sharesSold: position.sharesSold,
              realizedPnl: position.realizedPnl,
              percentPnl: position.percentPnl,
              finalValue: position.finalValue,
              status: position.status,
              realizedOutcome: position.realizedOutcome,
            });
          } catch (sheetsError) {
            console.error("⚠️  Failed to update Google Sheets:", sheetsError);
          }
        }
      }
    } catch (error) {
      console.error("❌ Error handling copytrade SELL:", error);
    }
  }

  /**
   * Create a copytrade position for a tracked whale in copytrade
   * Creates a position for EVERY stored BUY trade with the configured investment amount
   */
  private async createCopytradePosition(
    whale: TrackedWhale,
    activity: WhaleActivity,
    trade: PolymarketTrade,
    status: string
  ): Promise<void> {
    try {
      // Get investment amount (default $500)
      const investment = whale.copytradeInvestment || 500;
      
      // Calculate shares bought based on investment and entry price
      const entryPrice = parseFloat(trade.price.toString());
      const sharesBought = investment / entryPrice;
      
      // Find or create CopyTradeWallet for this tracked whale
      let copytradeWallet = await this.copytradeWalletRepository.findOne({
        where: { trackedWhaleId: whale.id },
      });
      
      if (!copytradeWallet) {
        // Create a virtual CopyTradeWallet for this tracked whale
        copytradeWallet = this.copytradeWalletRepository.create({
          walletAddress: whale.walletAddress,
          label: whale.label || `Whale: ${whale.walletAddress.slice(0, 8)}`,
          subscriptionType: whale.subscriptionType || "free",
          simulatedInvestment: investment,
          durationHours: 24,
          partialClosePercentage: 100, // Default 100%
          isActive: true,
          trackedWhaleId: whale.id,
        });
        copytradeWallet = await this.copytradeWalletRepository.save(copytradeWallet);
        console.log(`📊 Created virtual CopyTradeWallet for tracked whale: ${whale.label || whale.walletAddress}`);
      }
      
      // For "added" buys, don't create separate copytrade positions
      // They're additions to existing positions and should be aggregated
      // Only create positions for "open" status (initial buys)
      if (status === "added") {
        console.log(
          `⏭️  Skipping copytrade position for added BUY (aggregates into existing position) | ` +
          `Whale: ${whale.label || whale.walletAddress} | Market: ${trade.title}`
        );
        return;
      }

      // Create copytrade position only for initial BUY trades (status = "open")
      // Each initial BUY trade gets its own position with $500 (or configured amount) investment
      const position = this.copytradePositionRepository.create({
        copyTradeWalletId: copytradeWallet.id,
        whaleActivityId: activity.id,
        conditionId: trade.conditionId,
        asset: trade.asset,
        marketName: trade.title,
        marketSlug: trade.slug,
        outcome: trade.outcome,
        outcomeIndex: trade.outcomeIndex,
        simulatedInvestment: investment,
        sharesBought: sharesBought.toString(),
        entryPrice: entryPrice.toString(),
        entryDate: new Date(trade.timestamp * 1000),
        entryTransactionHash: trade.transactionHash,
        status: "open",
        metadata: {
          originalActivityStatus: status, // Store original status for reference
        },
      });
      
      const savedPosition = await this.copytradePositionRepository.save(position);
      
      console.log(
        `📊 Created copytrade position (initial BUY) for ${whale.label || whale.walletAddress}: ` +
        `$${investment} @ $${entryPrice.toFixed(4)} = ${sharesBought.toFixed(2)} shares | Market: ${trade.title}`
      );
      
      // Calculate trader's actual USD value for this trade
      const traderUsdValue = trade.size * trade.price;
      
      // Update Google Sheets (only for initial "open" positions)
      try {
        await googleSheetsService.appendPosition({
          walletAddress: whale.walletAddress,
          traderName: whale.label,
          subscriptionType: copytradeWallet.subscriptionType,
          outcomeChosen: trade.outcome,
          marketName: trade.title, // Market name
          entryDateTime: new Date(trade.timestamp * 1000),
          entryPrice: entryPrice.toString(),
          simulatedInvestment: investment,
          traderUsdValue: traderUsdValue, // Trader's actual USD value
          sharesBought: sharesBought.toString(),
          status: "open", // Always use "open" for initial positions sent to Google Sheets
          positionId: savedPosition.id,
          conditionId: trade.conditionId,
          outcomeIndex: trade.outcomeIndex,
        });
      } catch (sheetsError) {
        console.error("⚠️  Failed to update Google Sheets for copytrade position:", sheetsError);
      }
    } catch (error) {
      console.error("❌ Error creating copytrade position:", error);
    }
  }

  /**
   * Create a copytrade position for a copytrade-only wallet (not a tracked whale)
   */
  private async createCopytradePositionForWallet(
    wallet: CopyTradeWallet,
    trade: PolymarketTrade
  ): Promise<void> {
    try {
      const investment = wallet.simulatedInvestment || 500;
      const entryPrice = parseFloat(trade.price.toString());
      const sharesBought = investment / entryPrice;
      
      // Create copytrade position
      const position = this.copytradePositionRepository.create({
        copyTradeWalletId: wallet.id,
        conditionId: trade.conditionId,
        asset: trade.asset,
        marketName: trade.title,
        marketSlug: trade.slug,
        outcome: trade.outcome,
        outcomeIndex: trade.outcomeIndex,
        simulatedInvestment: investment,
        sharesBought: sharesBought.toString(),
        entryPrice: entryPrice.toString(),
        entryDate: new Date(trade.timestamp * 1000),
        entryTransactionHash: trade.transactionHash,
        status: "open",
      });
      
      const savedPosition = await this.copytradePositionRepository.save(position);
      
      console.log(
        `📊 Created copytrade position for wallet ${wallet.label || wallet.walletAddress}: ` +
        `$${investment} @ $${entryPrice.toFixed(4)} = ${sharesBought.toFixed(2)} shares | Market: ${trade.title}`
      );
      
      // Calculate trader's actual USD value for this trade
      const traderUsdValue = trade.size * trade.price;
      
      // Update Google Sheets
      try {
        await googleSheetsService.appendPosition({
          walletAddress: wallet.walletAddress,
          traderName: wallet.label,
          subscriptionType: wallet.subscriptionType,
          outcomeChosen: trade.outcome,
          marketName: trade.title, // Market name
          entryDateTime: new Date(trade.timestamp * 1000),
          entryPrice: entryPrice.toString(),
          simulatedInvestment: investment,
          traderUsdValue: traderUsdValue, // Trader's actual USD value
          sharesBought: sharesBought.toString(),
          status: "open", // Copytrade-only wallets always start with "open"
          positionId: savedPosition.id,
          conditionId: trade.conditionId,
          outcomeIndex: trade.outcomeIndex,
        });
      } catch (sheetsError) {
        console.error("⚠️  Failed to update Google Sheets for copytrade position:", sheetsError);
      }
    } catch (error) {
      console.error("❌ Error creating copytrade position for wallet:", error);
    }
  }

  /**
   * Check for fully closed positions by comparing open BUY trades with closed positions API
   * This is the NEW logic for detecting fully closed trades
   */
  private async checkFullyClosedPositions(whale: TrackedWhale): Promise<void> {
    try {
      console.log(`🔍 Checking fully closed positions for ${whale.label || whale.walletAddress}...`);

      // Fetch all BUY trades with status "open" from database
      const openBuyTrades = await this.activityRepository.find({
        where: {
          whaleId: whale.id,
          activityType: 'POLYMARKET_BUY',
          status: 'open',
        },
        order: {
          activityTimestamp: 'ASC',
        },
      });

      if (openBuyTrades.length === 0) {
        console.log(`   No open BUY trades found for ${whale.label || whale.walletAddress}`);
        return;
      }

      console.log(`   Found ${openBuyTrades.length} open BUY trade(s) for ${whale.label || whale.walletAddress}`);

      // Normalize conditionIds for consistent comparison
      const normalizeConditionId = (id: string | undefined): string => {
        if (!id) return "";
        return id.toLowerCase().trim();
      };

      // Get unique trades by conditionId only (since we match by conditionId only)
      const uniqueTrades = new Map<string, WhaleActivity>();
      for (const trade of openBuyTrades) {
        const conditionId = trade.metadata?.conditionId;
        if (conditionId !== undefined) {
          // Use normalized conditionId as key (no outcomeIndex in key)
          const normalizedConditionId = normalizeConditionId(conditionId);
          // Keep the oldest open BUY trade for each unique conditionId
          if (!uniqueTrades.has(normalizedConditionId)) {
            uniqueTrades.set(normalizedConditionId, trade);
          }
        }
      }

      console.log(`   Checking ${uniqueTrades.size} unique conditionId(s)`);

      if (uniqueTrades.size === 0) {
        return;
      }

      // Extract conditionIds from open trades to filter the API query
      // This is more efficient and ensures we get the exact positions we need
      const conditionIdsToCheck = Array.from(uniqueTrades.values())
        .map(trade => trade.metadata?.conditionId)
        .filter((id): id is string => id !== undefined && id !== null);

      // Fetch closed positions filtered by conditionIds (more efficient than fetching all)
      // When filtering by market, we don't need pagination since we're querying specific markets
      const closedPositions = await polymarketService.getUserClosedPositions(
        whale.walletAddress,
        conditionIdsToCheck, // Filter by conditionIds from open trades
        undefined, // No offset needed when filtering by specific markets
        undefined, // Use default limit (500)
        "REALIZEDPNL", // Sort by realized PnL (matches user's successful query)
        "DESC" // Descending order
      );

      // Create a map of closed positions by conditionId, then by asset
      // This handles cases where a trader trades both sides of a market (Yes/No, Up/Down)
      // Structure: Map<conditionId, Map<asset, closedPosition>>
      const closedPositionMap = new Map<string, Map<string, any>>();
      
      for (const p of closedPositions) {
        const normalizedConditionId = normalizeConditionId(p.conditionId);
        const asset = p.asset; // Asset is unique per outcome in a market
        
        if (!closedPositionMap.has(normalizedConditionId)) {
          closedPositionMap.set(normalizedConditionId, new Map());
        }
        closedPositionMap.get(normalizedConditionId)!.set(asset, p);
      }

      // Check each unique open BUY trade against closed positions
      // Match by both conditionId AND asset to correctly identify which closed position
      for (const [key, openBuyTrade] of uniqueTrades.entries()) {
        const conditionId = openBuyTrade.metadata?.conditionId;
        const asset = openBuyTrade.metadata?.asset;
        
        if (!conditionId || !asset) continue;
        
        const normalizedConditionId = normalizeConditionId(conditionId);
        const closedPositionsForMarket = closedPositionMap.get(normalizedConditionId);
        
        if (!closedPositionsForMarket) continue;
        
        // Match by asset to find the specific closed position for this trade
        const closedPosition = closedPositionsForMarket.get(asset);
        
        if (closedPosition) {
          // Check if we already sent a gainz alert for this position BEFORE processing
          // This prevents duplicate alerts on server restart
          const existingMetadata = openBuyTrade.metadata || {};
          if (existingMetadata.gainzAlertSent === true) {
            console.log(`   ⏭️  Skipping gainz alert - already sent for activity ${openBuyTrade.id}`);
            continue; // Skip this trade, alert was already sent
          }
          
          console.log(`   ✅ Found closed position match for ${whale.label || whale.walletAddress} | ConditionId: ${conditionId} | Asset: ${asset.substring(0, 20)}...`);
          
          // Always use realizedPnl from closed position API (it's accurate)
          const realizedPnl = closedPosition.realizedPnl;
          
          // Calculate percentage PnL from closed position
          const initialValue = closedPosition.totalBought * closedPosition.avgPrice;
          const percentPnl = initialValue > 0 && realizedPnl !== undefined
            ? (realizedPnl / initialValue) * 100
            : undefined;

          // Determine realized outcome based on PNL sign
          // If PNL is positive, trader won (use closedPosition.outcome)
          // If PNL is negative, trader lost (use closedPosition.oppositeOutcome)
          let realizedOutcome: string;
          let realizedOutcomeIndex: number;
          
          if (realizedPnl !== undefined && realizedPnl >= 0) {
            // Positive PNL: trader's outcome won
            realizedOutcome = closedPosition.outcome;
            realizedOutcomeIndex = closedPosition.outcomeIndex;
          } else {
            // Negative PNL: trader's outcome lost, opposite outcome won
            realizedOutcome = closedPosition.oppositeOutcome;
            // Flip the outcome index (0 -> 1, 1 -> 0)
            realizedOutcomeIndex = closedPosition.outcomeIndex === 0 ? 1 : 0;
          }

          // Build alert data for the closed position
          const tradeMetadata = openBuyTrade.metadata || {};
          const profileUrl = `https://polymarket.com/profile/${whale.walletAddress}`;
          const marketLink = tradeMetadata.slug
            ? `https://polymarket.com/market/${tradeMetadata.slug}`
            : undefined;

          // Calculate exit price using formula: Average Exit Price = (Total Cost + Realized PnL) / Total Bought
          // Total Cost = avgPrice × totalBought
          const totalCost = closedPosition.totalBought * closedPosition.avgPrice;
          const calculatedExitPrice = closedPosition.totalBought > 0 && realizedPnl !== undefined
            ? (totalCost + realizedPnl) / closedPosition.totalBought
            : closedPosition.curPrice; // Fallback to curPrice if calculation not possible
          const exitPrice = calculatedExitPrice.toString();
          
          const alertData = {
            walletAddress: whale.walletAddress,
            traderName: whale.label,
            profileUrl,
            thumbnailUrl: tradeMetadata.icon,
            marketLink,
            marketName: tradeMetadata.market,
            activityType: 'SELL',
            shares: closedPosition.totalBought.toString(), // Use totalBought from closed position
            totalShares: 0, // Fully closed = 0 remaining shares
            totalBought: closedPosition.totalBought,
            usdValue: tradeMetadata.usdValue,
            activityTimestamp: openBuyTrade.activityTimestamp,
            transactionHash: openBuyTrade.transactionHash,
            blockchain: "Polygon",
            additionalInfo: `Outcome: ${realizedOutcome}\nPrice: $${parseFloat(tradeMetadata.price || '0').toFixed(2)}`, // Keep for backward compatibility
            status: 'closed',
            realizedPnl: realizedPnl?.toString(), // Always use from closed position API
            percentPnl,
            whaleCategory: whale.category || "regular",
            tradeCategory: openBuyTrade.category || undefined,
            subscriptionType: whale.subscriptionType || "free",
            entryPrice: tradeMetadata.price, // Entry price from original buy
            exitPrice: exitPrice, // Calculated using: (Total Cost + Realized PnL) / Total Bought
            outcome: realizedOutcome, // Use realized outcome based on PNL sign (shows actual game result)
          };

          // Reply to Discord message before updating database (to prevent race conditions)
          if (openBuyTrade.discordMessageId) {
            console.log(`   💬 Replying to Discord message for closed position | Original: ${openBuyTrade.discordMessageId}`);
            
            // Skip Discord notifications for losses (negative percentPnl)
            if (percentPnl !== undefined && percentPnl < 0) {
              console.log(
                `   ⏭️  Skipping Discord reply (loss detected: ${percentPnl.toFixed(2)}%) | Whale: ${whale.label || whale.walletAddress}`
              );
            } else {
              // Check if alert should be sent for this status
              const whaleCategoryForCheck = whale.category || "regular";
              if (!discordService.shouldSendAlertForStatus(whaleCategoryForCheck, 'closed')) {
                console.log(
                  `   ⏭️  Skipping Discord reply (status "closed" disabled for ${whaleCategoryForCheck} traders) | Whale: ${whale.label || whale.walletAddress}`
                );
              } else {
                const embed = discordService.buildWhaleAlertEmbed(alertData, whale.category || "regular");
                const replyMessageId = await discordService.replyToMessage(
                  openBuyTrade.discordMessageId, 
                  embed,
                  whale.category || "regular",
                  openBuyTrade.category || undefined,
                  whale.subscriptionType || "free"
                );
                
                if (replyMessageId) {
                  console.log(`   ✅ Discord reply sent successfully | Reply ID: ${replyMessageId}`);
                } else {
                  console.warn(`   ⚠️  Failed to send Discord reply`);
                }
              }
            }
          } else {
            console.warn(`   ⚠️  No Discord message ID found for open BUY trade ${openBuyTrade.id}`);
          }

          // Update the open BUY trade status to closed in database (after Discord reply)
          openBuyTrade.status = 'closed';
          openBuyTrade.realizedPnl = realizedPnl?.toString();
          openBuyTrade.percentPnl = percentPnl ?? undefined;
          
          // Update metadata with exit price and realized outcome (separate from original outcome)
          // Exit price is calculated using: Average Exit Price = (Total Cost + Realized PnL) / Total Bought
          const updatedMetadata = openBuyTrade.metadata || {};
          
          // Only update exit price if not already set (preserve original calculation to prevent duplicates)
          if (!updatedMetadata.exitPrice) {
            updatedMetadata.exitPrice = calculatedExitPrice; // Use calculated exit price (not curPrice)
          }
          
          // Store realized outcome separately (based on PNL) - don't overwrite original outcome
          if (!updatedMetadata.realizedOutcome) {
            updatedMetadata.realizedOutcome = realizedOutcome; // The actual winning outcome (based on PNL sign)
            updatedMetadata.realizedOutcomeIndex = realizedOutcomeIndex; // The index of the winning outcome
          }
          
          openBuyTrade.metadata = updatedMetadata;
          
          // Save activity FIRST to ensure metadata is persisted before sending alert
          // This prevents duplicate alerts from checkAndUpdatePositions and on server restart
          await this.activityRepository.save(openBuyTrade);
          
          // Send gainz alert if this closed position has high PnL and alert wasn't already sent
          // Only send for positive PnL (losses are skipped)
          if (percentPnl !== undefined && percentPnl >= 0 && !existingMetadata.gainzAlertSent) {
            await this.sendGainzAlertForActivity(openBuyTrade, whale, updatedMetadata);
            
            // Set flag AFTER successfully attempting to send to prevent duplicates
            // sendGainzAlertForActivity has its own checks, but we set the flag here to prevent duplicates
            // even if the alert doesn't meet threshold (to prevent re-processing)
            if (!openBuyTrade.metadata) {
              openBuyTrade.metadata = {};
            }
            openBuyTrade.metadata.gainzAlertSent = true;
            await this.activityRepository.save(openBuyTrade);
          }
          
          console.log(`   ✅ Updated open BUY trade status to closed in database | Activity: ${openBuyTrade.id}`);
        }
      }
    } catch (error) {
      console.error(
        `❌ Error checking fully closed positions for whale ${whale.label || whale.walletAddress}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get polling status
   */
  getStatus(): { isRunning: boolean; interval: number } {
    return {
      isRunning: this.pollingInterval !== null,
      interval: this.POLL_INTERVAL_MS,
    };
  }

  /**
   * Cleanup database by removing activities that don't meet storage criteria
   * Removes activities where USD value < threshold (based on whale category) OR price > $0.95
   */
  private async cleanupDatabase(): Promise<void> {
    if (this.isCleaning) {
      console.log("⏭️  Skipping cleanup - previous cleanup still in progress");
      return;
    }

    this.isCleaning = true;

    try {
      console.log("🧹 Starting database cleanup...");

      // Fetch all activities
      const allActivities = await this.activityRepository.find({
        relations: ["whale"],
      });

      let deletedCount = 0;
      const activitiesToDelete: WhaleActivity[] = [];

      // Find activities that don't meet criteria
      for (const activity of allActivities) {
        const metadata = activity.metadata || {};
        const usdValue = metadata.usdValue ? parseFloat(metadata.usdValue) : 0;
        const price = metadata.price ? parseFloat(metadata.price) : null;

        // Determine whale category to apply appropriate threshold
        if (!activity.whale) {
          console.warn(`⚠️  Activity ${activity.id} has no whale relation, skipping cleanup check`);
          continue;
        }
        const minUsdValue = this.getMinUsdValueForStorage(activity.whale);
        
        // Check if activity should be removed based on side and status
        // SELL and added BUY trades are not filtered
        const isSell = activity.activityType === 'POLYMARKET_SELL';
        const isAddedBuy = activity.status === 'added';
        
        if (!isSell && !isAddedBuy) {
          // Initial BUY trades must meet thresholds
          if (usdValue < minUsdValue || (price !== null && price > this.MAX_PRICE_FOR_STORAGE)) {
          activitiesToDelete.push(activity);
          }
        }
      }

      // Delete activities in batches to avoid overwhelming the database
      const BATCH_SIZE = 100;
      for (let i = 0; i < activitiesToDelete.length; i += BATCH_SIZE) {
        const batch = activitiesToDelete.slice(i, i + BATCH_SIZE);
        const idsToDelete = batch.map(a => a.id);

        // Delete activities by ID
        const result = await this.activityRepository
          .createQueryBuilder()
          .delete()
          .from(WhaleActivity)
          .where("id IN (:...ids)", { ids: idsToDelete })
          .execute();

        deletedCount += result.affected || 0;

        // Log batch deletion
        const whaleInfo = batch.map(a => a.whale?.label || a.whale?.walletAddress || "Unknown").join(", ");
        console.log(
          `🗑️  Deleted batch ${Math.floor(i / BATCH_SIZE) + 1} (${result.affected || 0} activities) | Whales: ${whaleInfo}`
        );
      }

      if (deletedCount > 0) {
        console.log(`✅ Cleanup complete: Removed ${deletedCount} activities that don't meet storage criteria`);
      } else {
        console.log("✅ Cleanup complete: No activities to remove");
      }
    } catch (error) {
      console.error("❌ Error during database cleanup:", error);
    } finally {
      this.isCleaning = false;
    }
  }
}

export const tradePollingService = new TradePollingService();


