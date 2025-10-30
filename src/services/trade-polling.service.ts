import { AppDataSource } from "../config/database.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";
import { polymarketService, type PolymarketTrade } from "./polymarket.service.js";
import { discordService } from "./discord.service.js";

class TradePollingService {
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 8000; // 8 seconds (between 5-10 as requested)
  private isPolling = false;
  private whaleRepository = AppDataSource.getRepository(TrackedWhale);
  private activityRepository = AppDataSource.getRepository(WhaleActivity);

  /**
   * Start polling for trades
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
  }

  /**
   * Stop polling for trades
   */
  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      console.log("🛑 Trade polling service stopped");
    }
  }

  /**
   * Poll trades for all active tracked whales
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

      if (activeWhales.length === 0) {
        console.log("ℹ️  No active whales to track");
        return;
      }

      console.log(`🐋 Polling trades for ${activeWhales.length} whale(s)...`);

      // Process each whale
      const results = await Promise.allSettled(
        activeWhales.map((whale) => this.pollWhaleTradesAndStore(whale))
      );

      // Log results
      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      console.log(`✅ Polling complete: ${successful} successful, ${failed} failed`);
    } catch (error) {
      console.error("❌ Error polling whales:", error);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll trades for a specific whale and store new ones
   */
  private async pollWhaleTradesAndStore(whale: TrackedWhale): Promise<void> {
    try {
      // Fetch recent trades from Polymarket
      const trades = await polymarketService.getRecentUserTrades(
        whale.walletAddress,
        50 // Fetch last 50 trades
      );

      if (trades.length === 0) {
        return;
      }

      // Check which trades are new
      const newTrades = await this.filterNewTrades(whale.id, trades);

      if (newTrades.length === 0) {
        return;
      }

      console.log(
        `📊 Found ${newTrades.length} new trade(s) for ${whale.label || whale.walletAddress}`
      );

      // Store new trades in database
      for (const trade of newTrades) {
        await this.storeTrade(whale, trade);
      }
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
   * Store a trade as a WhaleActivity in the database
   */
  private async storeTrade(
    whale: TrackedWhale,
    trade: PolymarketTrade
  ): Promise<void> {
    try {
      // Calculate USD value (size * price)
      const usdValue = (trade.size * trade.price).toFixed(6);

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
      });

      await this.activityRepository.save(activity);

      // Send Discord notification
      await discordService.sendWhaleAlert({
        walletAddress: whale.walletAddress,
        activityType: `${trade.side} on Polymarket`,
        amount: usdValue,
        tokenSymbol: "USD",
        transactionHash: trade.transactionHash,
        blockchain: "Polygon",
        additionalInfo: `Market: ${trade.title}\nOutcome: ${trade.outcome}\nPrice: $${trade.price}`,
      });

      console.log(
        `✅ Stored ${trade.side} trade for ${whale.label || whale.walletAddress}: $${usdValue}`
      );
    } catch (error) {
      console.error("❌ Error storing trade:", error);
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
}

export const tradePollingService = new TradePollingService();

