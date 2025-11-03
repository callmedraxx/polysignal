import "reflect-metadata";
import dotenv from "dotenv";
import { AppDataSource } from "../config/database.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";

// Load environment variables
dotenv.config();

async function main() {
  try {
    console.log("🔄 Initializing database connection...");
    await AppDataSource.initialize();
    console.log("✅ Database connection established\n");

    const activityRepository = AppDataSource.getRepository(WhaleActivity);

    // Find all BUY trades with "open" status
    const allOpenBuyTrades = await activityRepository.find({
      where: {
        activityType: "POLYMARKET_BUY",
        status: "open",
      },
      order: {
        activityTimestamp: "ASC",
      },
    });

    console.log(`📊 Found ${allOpenBuyTrades.length} BUY trades with "open" status\n`);

    if (allOpenBuyTrades.length === 0) {
      console.log("✓ No open BUY trades found. Nothing to fix.");
      process.exit(0);
    }

    // Group by whaleId, conditionId, and outcomeIndex
    const tradeGroups = new Map<string, WhaleActivity[]>();
    
    for (const trade of allOpenBuyTrades) {
      const conditionId = trade.metadata?.conditionId;
      const outcomeIndex = trade.metadata?.outcomeIndex;
      
      if (conditionId !== undefined && outcomeIndex !== undefined) {
        // Create key: whaleId:conditionId:outcomeIndex
        const key = `${trade.whaleId}:${conditionId}:${outcomeIndex}`;
        
        if (!tradeGroups.has(key)) {
          tradeGroups.set(key, []);
        }
        tradeGroups.get(key)!.push(trade);
      }
    }

    console.log(`📋 Found ${tradeGroups.size} unique trade groups (whaleId:conditionId:outcomeIndex)\n`);

    let updatedCount = 0;

    // For each group, keep only the first (oldest) trade as "open", mark others as "added"
    for (const [key, trades] of tradeGroups.entries()) {
      if (trades.length > 1) {
        // Sort by activityTimestamp to ensure oldest is first
        trades.sort((a, b) => {
          const timeA = a.activityTimestamp ? new Date(a.activityTimestamp).getTime() : 0;
          const timeB = b.activityTimestamp ? new Date(b.activityTimestamp).getTime() : 0;
          return timeA - timeB;
        });

        // Keep first trade as "open", update others to "added"
        const tradesToUpdate = trades.slice(1); // All except the first one
        
        for (const trade of tradesToUpdate) {
          console.log(`  Updating trade ${trade.id} from "open" to "added"`);
          console.log(`    Whale: ${trade.whaleId} | ConditionId: ${trade.metadata?.conditionId} | OutcomeIndex: ${trade.metadata?.outcomeIndex}`);
          
          trade.status = "added";
          await activityRepository.save(trade);
          updatedCount++;
        }
      }
    }

    if (updatedCount === 0) {
      console.log("\n✓ No duplicate open BUY trades found. All trades have correct status.");
    } else {
      console.log(`\n✅ Successfully updated ${updatedCount} trade(s) from "open" to "added"`);
    }
  } catch (error) {
    console.error("\n❌ Error fixing BUY trade statuses:", error);
    process.exit(1);
  } finally {
    await AppDataSource.destroy();
    process.exit(0);
  }
}

main();

