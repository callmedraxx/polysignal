import { AppDataSource } from "../config/database.js";
import { CopyTradePosition } from "../entities/CopyTradePosition.js";
import { CopyTradeWallet } from "../entities/CopyTradeWallet.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";
import { googleSheetsService } from "../services/google-sheets.service.js";

/**
 * Script to update Google Sheets with closed positions that were missed
 * 
 * Strategy (follows the same pattern as the real code):
 * 1. Find closed activities (WhaleActivity with status = "closed")
 * 2. For each closed activity, find open CopyTradePositions and close them
 * 3. Then update the spreadsheet with all closed positions
 * 
 * This ensures the database is in sync before updating the spreadsheet
 */
async function updateClosedPositions() {
  try {
    console.log("🚀 Starting closed positions update script...\n");

    // Initialize database
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
      console.log("✅ Database initialized\n");
    }

    // Initialize Google Sheets service
    await googleSheetsService.initialize();
    console.log("✅ Google Sheets service initialized\n");

    // Get all positions from database to debug
    const positionRepository = AppDataSource.getRepository(CopyTradePosition);
    
    // First, let's see what statuses exist
    const allPositions = await positionRepository.find({
      relations: ["copyTradeWallet"],
    });
    
    console.log(`📊 Total positions in database: ${allPositions.length}`);
    
    // Count by status
    const statusCounts = new Map<string, number>();
    for (const pos of allPositions) {
      const status = pos.status || "unknown";
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    }
    
    console.log(`📊 Positions by status:`);
    for (const [status, count] of statusCounts.entries()) {
      console.log(`   ${status}: ${count}`);
    }
    console.log();

    // Get all closed positions from database
    const closedPositions = await positionRepository.find({
      where: {
        status: "closed",
      },
      relations: ["copyTradeWallet"],
      order: {
        exitDate: "DESC",
      },
    });

    console.log(`📊 Found ${closedPositions.length} closed positions in database\n`);
    
    // Check if there are closed activities that should have closed positions
    const activityRepository = AppDataSource.getRepository(WhaleActivity);
    const closedActivities = await activityRepository.find({
      where: {
        status: "closed",
        activityType: "POLYMARKET_BUY",
      },
      relations: ["whale"],
    });
    
    console.log(`📊 Found ${closedActivities.length} closed BUY activities in database\n`);
    
    // Step 1: For each closed activity, find/create and close the corresponding CopyTradePosition
    let positionsCreated = 0;
    let positionsUpdated = 0;
    
    for (const activity of closedActivities) {
      try {
        const whale = activity.whale;
        if (!whale || !whale.isCopytrade) {
          continue; // Skip if whale doesn't have copytrade enabled
        }
        
        const conditionId = activity.metadata?.conditionId;
        const outcomeIndex = activity.metadata?.outcomeIndex;
        
        if (!conditionId || outcomeIndex === undefined) {
          console.log(`   ⏭️  Skipping activity ${activity.id} - missing conditionId or outcomeIndex`);
          continue;
        }
        
        // Find or create CopyTradeWallet
        const walletRepository = AppDataSource.getRepository(CopyTradeWallet);
        let copytradeWallet = await walletRepository.findOne({
          where: { trackedWhaleId: whale.id },
        });
        
        if (!copytradeWallet) {
          const investment = whale.copytradeInvestment || 500;
          copytradeWallet = walletRepository.create({
            walletAddress: whale.walletAddress,
            label: whale.label || `Whale: ${whale.walletAddress.slice(0, 8)}`,
            subscriptionType: whale.subscriptionType || "free",
            simulatedInvestment: investment,
            durationHours: 24,
            partialClosePercentage: 100,
            isActive: true,
            trackedWhaleId: whale.id,
          });
          copytradeWallet = await walletRepository.save(copytradeWallet);
        }
        
        // Find open positions for this activity
        const openPositions = await positionRepository.find({
          where: {
            copyTradeWalletId: copytradeWallet.id,
            conditionId: conditionId,
            outcomeIndex: outcomeIndex,
            status: "open",
          },
          relations: ["copyTradeWallet"],
          order: {
            entryDate: "ASC",
          },
        });
        
        if (openPositions.length === 0) {
          console.log(`   ⏭️  No open positions found for activity ${activity.id}`);
          continue;
        }
        
        // Calculate exit price from activity metadata
        const exitPrice = activity.metadata?.exitPrice 
          ? parseFloat(activity.metadata.exitPrice.toString())
          : null;
        
        if (!exitPrice) {
          console.log(`   ⏭️  Skipping activity ${activity.id} - missing exit price`);
          continue;
        }
        
        // Close all open positions (FIFO)
        const totalShares = openPositions.reduce((sum, pos) => sum + parseFloat(pos.sharesBought), 0);
        let remainingShares = totalShares;
        
        for (const position of openPositions) {
          if (remainingShares <= 0) break;
          
          const positionShares = parseFloat(position.sharesBought);
          const sharesToSell = Math.min(remainingShares, positionShares);
          
          // Calculate PnL
          const entryPrice = parseFloat(position.entryPrice);
          const costBasis = sharesToSell * entryPrice;
          const proceeds = sharesToSell * exitPrice;
          const realizedPnl = proceeds - costBasis;
          const percentPnl = (realizedPnl / costBasis) * 100;
          // Ensure both are numbers for addition (not string concatenation)
          // simulatedInvestment is a decimal type which can be a number or string
          const simulatedInvestment = typeof position.simulatedInvestment === 'number' 
            ? position.simulatedInvestment 
            : parseFloat(String(position.simulatedInvestment));
          const finalValue = simulatedInvestment + realizedPnl;
          
          // Update position to closed
          position.status = "closed";
          position.sharesSold = sharesToSell.toString();
          position.exitPrice = exitPrice.toString();
          position.exitDate = activity.activityTimestamp || new Date();
          position.exitTransactionHash = activity.transactionHash;
          position.realizedPnl = realizedPnl.toString();
          position.percentPnl = percentPnl;
          position.finalValue = finalValue;
          
          if (activity.metadata?.realizedOutcome) {
            position.realizedOutcome = activity.metadata.realizedOutcome;
          }
          
          await positionRepository.save(position);
          positionsUpdated++;
          remainingShares -= sharesToSell;
          
          console.log(`   ✅ Closed position ${position.id} for activity ${activity.id}`);
        }
      } catch (error) {
        console.error(`   ❌ Error processing activity ${activity.id}:`, error);
      }
    }
    
    console.log(`\n📊 Closed ${positionsUpdated} positions from ${closedActivities.length} activities\n`);
    
    // Step 2: Now get all closed positions (including newly closed ones) and update spreadsheet
    const allClosedPositions = await positionRepository.find({
      where: {
        status: "closed",
      },
      relations: ["copyTradeWallet"],
      order: {
        exitDate: "DESC",
      },
    });
    
    console.log(`📊 Found ${allClosedPositions.length} closed positions to update in spreadsheet\n`);

    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let notFoundCount = 0;

    // Process each closed position
    for (const position of allClosedPositions) {
      try {
        const wallet = position.copyTradeWallet;
        const walletAddress = wallet.walletAddress;
        const traderName = wallet.label || walletAddress;

        console.log(`\n🔍 Processing position ${position.id}`);
        console.log(`   Trader: ${traderName}`);
        console.log(`   Market: ${position.marketName || position.conditionId}`);
        console.log(`   Entry Date: ${position.entryDate}`);
        console.log(`   Exit Date: ${position.exitDate || "N/A"}`);

        // Check if position has exit data (is actually closed)
        if (!position.exitDate || !position.exitPrice) {
          console.log(`   ⏭️  Skipping - missing exit data`);
          skippedCount++;
          continue;
        }

        // Update the position in Google Sheets
        // This will find the matching row in the spreadsheet and update it
        try {
          // Ensure percentPnl is a number if it exists
          let percentPnl: number | undefined = undefined;
          if (position.percentPnl !== undefined && position.percentPnl !== null) {
            percentPnl = typeof position.percentPnl === 'number' 
              ? position.percentPnl 
              : parseFloat(String(position.percentPnl));
            if (isNaN(percentPnl)) {
              percentPnl = undefined;
            }
          }
          
          await googleSheetsService.updatePosition(position.id, {
            exitDate: position.exitDate,
            exitPrice: position.exitPrice,
            sharesSold: position.sharesSold,
            realizedPnl: position.realizedPnl,
            percentPnl: percentPnl,
            finalValue: position.finalValue,
            status: position.status,
            realizedOutcome: position.realizedOutcome,
          });

          updatedCount++;
          console.log(`   ✅ Updated spreadsheet for position ${position.id}`);
        } catch (updateError: any) {
          // Check if it's a "not found" error
          if (updateError?.message?.includes("Could not find matching") || 
              updateError?.message?.includes("not found")) {
            notFoundCount++;
            console.log(`   ⚠️  Position not found in spreadsheet - row may not exist or entry date doesn't match`);
            console.log(`      Entry Date: ${position.entryDate}`);
            console.log(`      ConditionId: ${position.conditionId}`);
            console.log(`      OutcomeIndex: ${position.outcomeIndex}`);
            console.log(`      Wallet: ${walletAddress}`);
          } else {
            // It's a different error (like the percentPnl.toFixed error)
            errorCount++;
            console.error(`   ❌ Failed to update position in Google Sheets:`, updateError);
            if (updateError instanceof Error) {
              console.error(`      ${updateError.message}`);
            }
            // Don't increment updatedCount for errors
          }
        }
      } catch (error) {
        errorCount++;
        console.error(`   ❌ Error updating position ${position.id}:`, error);
        if (error instanceof Error) {
          console.error(`      ${error.message}`);
        }
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("📊 Summary:");
    console.log(`   📝 Positions closed from activities: ${positionsUpdated}`);
    console.log(`   ✅ Spreadsheet updates: ${updatedCount}`);
    console.log(`   ⏭️  Skipped (missing data): ${skippedCount}`);
    console.log(`   ⚠️  Not found in spreadsheet: ${notFoundCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    console.log("=".repeat(60));

    // Close database connection
    await AppDataSource.destroy();
    console.log("\n✅ Script completed successfully");
  } catch (error) {
    console.error("❌ Fatal error:", error);
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
      console.error(`   ${error.stack}`);
    }
    process.exit(1);
  }
}

// Run the script
updateClosedPositions().catch((error) => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});

