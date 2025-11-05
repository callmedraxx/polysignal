import { AppDataSource } from "../config/database.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";
import { polymarketService, type PolymarketTrade } from "./polymarket.service.js";
import { discordService } from "./discord.service.js";
import { detectCategory } from "../utils/category-detector.js";
import { inferCategoryFromTags } from "../utils/category-from-tags.js";
import { IsNull } from "typeorm";

class TradePollingService {
  private pollingInterval: NodeJS.Timeout | null = null;
  private positionPollingInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds (between 5-10 as requested)
  private readonly POSITION_POLL_INTERVAL_MS = 10000; // 10 seconds for position checks
  private readonly CLEANUP_INTERVAL_MS = 3600000; // 1 hour cleanup interval
  
  // Configurable USD value thresholds from environment variables
  private readonly MAX_PRICE_FOR_STORAGE = 0.95; // Maximum price to store in database
  private readonly MIN_USD_VALUE_FOR_DISCORD = 500; // Minimum USD value to send/update Discord messages
  private readonly ALLOWED_MIN_USD_VALUES = [500, 1000, 2000, 3000, 4000, 5000]; // Fixed allowed values

  constructor() {
    // Log configuration
    console.log(`💰 Trade storage thresholds: Using per-trader minUsdValue from database`);
    console.log(`   - Allowed values: $${this.ALLOWED_MIN_USD_VALUES.join(", $")}`);
    console.log(`   - Default for new traders: $500`);
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

      console.log(
        `📊 Found ${newTrades.length} new trade(s) for ${whale.label || whale.walletAddress}`
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
   * - SELL trades: no filtering
   * - Added BUY trades (with existing buy): no filtering
   * - Initial BUY trades: filtering based on whale category (configurable via MIN_USD_VALUE_REGULAR and MIN_USD_VALUE_WHALE env vars) and price <= $0.95
   */
  private async shouldStoreTrade(
    trade: PolymarketTrade,
    whale: TrackedWhale
  ): Promise<boolean> {
    const usdValue = trade.size * trade.price;
    const price = trade.price;
    
    // SELL trades: no filtering
    if (trade.side === "SELL") {
      return true;
    }
    
    // BUY trades: check if there's an existing BUY trade for the same market
    if (trade.side === "BUY" && trade.conditionId) {
      const hasExisting = await this.hasExistingBuyTrade(trade.conditionId, whale.id, trade.outcomeIndex);
      
      // Added BUY trade (has existing buy): no filtering
      if (hasExisting) {
        return true;
      }
    }
    
    // Initial BUY trade: apply filtering based on whale category
    const minUsdValue = this.getMinUsdValueForStorage(whale);
    
    // Check USD value threshold
    if (usdValue < minUsdValue) {
      return false;
    }
    
    // Check price threshold
    if (price > this.MAX_PRICE_FOR_STORAGE) {
      return false;
    }
    
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
          const wasHandledByFullyClosedCheck = activityMetadata.exitPrice !== undefined;
          
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
          if (wasNotClosed && percentPnl !== undefined && !wasHandledByFullyClosedCheck) {
            // Use updated metadata with exitPrice and realizedOutcome
            await this.sendGainzAlertForActivity(activity, whale, metadata);
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
          const wasHandledByFullyClosedCheck = activityMetadata.exitPrice !== undefined;
          
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
          if (wasNotClosed && percentPnl !== undefined && !wasHandledByFullyClosedCheck) {
            // Use updated metadata with exitPrice and realizedOutcome
            await this.sendGainzAlertForActivity(activity, whale, metadata);
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
          updatedMetadata.exitPrice = calculatedExitPrice; // Use calculated exit price (not curPrice)
          // Store realized outcome separately (based on PNL) - don't overwrite original outcome
          updatedMetadata.realizedOutcome = realizedOutcome; // The actual winning outcome (based on PNL sign)
          updatedMetadata.realizedOutcomeIndex = realizedOutcomeIndex; // The index of the winning outcome
          openBuyTrade.metadata = updatedMetadata;
          
          // Send gainz alert if this closed position has high PnL
          if (percentPnl !== undefined) {
            await this.sendGainzAlertForActivity(openBuyTrade, whale, updatedMetadata);
          }
          await this.activityRepository.save(openBuyTrade);
          
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


