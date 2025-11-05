import { AppDataSource } from "../config/database.js";
import { ArbitrageOpportunity } from "../entities/ArbitrageOpportunity.js";
import { polymarketService, type PolymarketMarket } from "./polymarket.service.js";
import { kalshiService, type KalshiMarket } from "./kalshi.service.js";

interface MarketMatch {
  polymarket: PolymarketMarket;
  kalshi: KalshiMarket;
  similarityScore: number;
}

interface ArbitrageCalculation {
  yesPolyPlusNoKalshi: number;
  noPolyPlusYesKalshi: number;
  bestMargin: number;
  bestType: "yes_poly_no_kalshi" | "no_poly_yes_kalshi";
}

class ArbitrageDiscoveryService {
  private readonly MIN_SIMILARITY_SCORE = 0.3; // Minimum similarity to consider a match
  private readonly MAX_ARBITRAGE_THRESHOLD: number; // Markets should sum to < threshold for arbitrage (default: 97)
  private readonly MIN_LIQUIDITY = 100;
  private readonly DATE_TOLERANCE_DAYS = 30; // Markets should close within 30 days of each other

  constructor() {
    // Configure arbitrage threshold from environment variable (default: 97)
    // Only deals that add up to less than this threshold are considered arbitrage
    this.MAX_ARBITRAGE_THRESHOLD = parseFloat(
      process.env.ARBITRAGE_THRESHOLD || "97"
    );
    
    console.log(`💰 Arbitrage threshold configured: ${this.MAX_ARBITRAGE_THRESHOLD}%`);
    console.log(`   (Only deals summing to < ${this.MAX_ARBITRAGE_THRESHOLD}% will be considered)`);
  }

  /**
   * Normalize text for comparison (lowercase, remove special chars, trim)
   */
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Extract keywords from text (common words filtered out)
   */
  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set([
      "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
      "of", "with", "by", "from", "will", "be", "is", "are", "was", "were",
      "this", "that", "these", "those", "it", "its", "if", "when", "where",
      "what", "who", "which", "how", "why", "can", "may", "might", "must",
      "should", "would", "could", "have", "has", "had", "do", "does", "did",
    ]);

    const normalized = this.normalizeText(text);
    const words = normalized.split(/\s+/).filter(
      (word) => word.length > 2 && !stopWords.has(word)
    );

    return new Set(words);
  }

  /**
   * Calculate Jaccard similarity between two sets of keywords
   */
  private calculateJaccardSimilarity(
    set1: Set<string>,
    set2: Set<string>
  ): number {
    if (set1.size === 0 && set2.size === 0) return 1;
    if (set1.size === 0 || set2.size === 0) return 0;

    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return intersection.size / union.size;
  }

  /**
   * Calculate similarity score between two markets
   */
  private calculateMarketSimilarity(
    polymarket: PolymarketMarket,
    kalshi: KalshiMarket
  ): number {
    // Extract keywords from both markets
    const polyKeywords = this.extractKeywords(
      `${polymarket.question || ""} ${polymarket.description || ""}`
    );
    const kalshiKeywords = this.extractKeywords(
      `${kalshi.title || ""} ${kalshi.subtitle || ""}`
    );

    // Calculate Jaccard similarity
    let similarity = this.calculateJaccardSimilarity(polyKeywords, kalshiKeywords);

    // Boost similarity if dates are close
    if (polymarket.endDate && kalshi.close_time) {
      const polyDate = new Date(polymarket.endDate);
      const kalshiDate = new Date(kalshi.close_time);
      const daysDiff = Math.abs(
        (polyDate.getTime() - kalshiDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysDiff <= this.DATE_TOLERANCE_DAYS) {
        // Boost by up to 0.2 based on date proximity
        const dateBoost = Math.max(0, 1 - daysDiff / this.DATE_TOLERANCE_DAYS) * 0.2;
        similarity += dateBoost;
      } else {
        // Penalize if dates are far apart
        similarity *= 0.7;
      }
    }

    // Check for exact keyword matches (boost)
    const polyText = this.normalizeText(
      `${polymarket.question || ""} ${polymarket.description || ""}`
    );
    const kalshiText = this.normalizeText(
      `${kalshi.title || ""} ${kalshi.subtitle || ""}`
    );

    // Check if major keywords appear in both
    const polyWords = polyText.split(/\s+/).filter((w) => w.length > 4);
    const kalshiWords = kalshiText.split(/\s+/).filter((w) => w.length > 4);
    const commonImportantWords = polyWords.filter((w) => kalshiWords.includes(w));
    
    if (commonImportantWords.length > 0) {
      similarity += Math.min(0.2, commonImportantWords.length * 0.05);
    }

    return Math.min(1, similarity);
  }

  /**
   * Parse outcome prices from Polymarket
   * Uses bestAsk if available (worst-case buying price), otherwise falls back to outcomePrices
   */
  private parsePolymarketPrices(
    market: PolymarketMarket
  ): { yesPrice: number; noPrice: number } | null {
    try {
      // Prefer bestAsk/bestBid if available (orderbook prices for buying)
      if (
        market.bestAsk !== undefined &&
        market.bestBid !== undefined &&
        typeof market.bestAsk === "number" &&
        typeof market.bestBid === "number"
      ) {
        // bestAsk is what we'd pay to buy Yes, bestBid is what we'd get selling No
        // For buying No, we'd pay (1 - bestAsk), but that's not directly available
        // Use bestAsk for Yes and (1 - bestBid) as approximation for No buying price
        // Actually, for arbitrage we need: buying Yes at ask, buying No at ask
        // If we only have bestAsk for Yes, assume No ask = 1 - Yes bid (inverse relationship for binary)
        return {
          yesPrice: market.bestAsk,
          noPrice: 1 - market.bestBid, // Approximate No ask price
        };
      }

      // Fallback to outcomePrices (current market prices)
      if (market.outcomePrices) {
        const prices = JSON.parse(market.outcomePrices) as string[];
        const outcomes = market.outcomes
          ? (JSON.parse(market.outcomes) as string[])
          : ["Yes", "No"];

        const yesIndex = outcomes.findIndex(
          (o) => o.toLowerCase() === "yes"
        );
        const noIndex = outcomes.findIndex((o) => o.toLowerCase() === "no");

        if (
          yesIndex >= 0 &&
          noIndex >= 0 &&
          yesIndex < prices.length &&
          noIndex < prices.length
        ) {
          const yesPriceStr = prices[yesIndex];
          const noPriceStr = prices[noIndex];
          if (yesPriceStr && noPriceStr) {
            return {
              yesPrice: parseFloat(yesPriceStr),
              noPrice: parseFloat(noPriceStr),
            };
          }
        }
      }

      return null;
    } catch (error) {
      console.error(`Error parsing Polymarket prices for ${market.id}:`, error);
      return null;
    }
  }

  /**
   * Get Kalshi prices (in decimal form from cents)
   */
  private getKalshiPrices(market: KalshiMarket): {
    yesBid: number;
    yesAsk: number;
    noBid: number;
    noAsk: number;
  } {
    // Kalshi prices are in cents (0-100), convert to decimal (0-1)
    return {
      yesBid: market.yes_bid / 100,
      yesAsk: market.yes_ask / 100,
      noBid: market.no_bid / 100,
      noAsk: market.no_ask / 100,
    };
  }

  /**
   * Calculate arbitrage opportunities
   * Only considers deals where sum < threshold (default 97)
   * Margin is always positive (100 - sum)
   */
  private calculateArbitrage(
    polyPrices: { yesPrice: number; noPrice: number },
    kalshiPrices: { yesBid: number; yesAsk: number; noBid: number; noAsk: number }
  ): ArbitrageCalculation | null {
    // Strategy 1: Buy Yes on Polymarket + Buy No on Kalshi
    // Use ask price for buying (worst case)
    const yesPolyPlusNoKalshi = polyPrices.yesPrice * 100 + kalshiPrices.noAsk * 100;

    // Strategy 2: Buy No on Polymarket + Buy Yes on Kalshi
    const noPolyPlusYesKalshi = polyPrices.noPrice * 100 + kalshiPrices.yesAsk * 100;

    // Only consider arbitrage if at least one strategy sums to < threshold
    // Each strategy must have sum < threshold and margin must be positive
    let validStrategies: Array<{
      sum: number;
      margin: number;
      type: "yes_poly_no_kalshi" | "no_poly_yes_kalshi";
    }> = [];

    // Check Strategy 1: Yes Poly + No Kalshi
    if (yesPolyPlusNoKalshi < this.MAX_ARBITRAGE_THRESHOLD) {
      const margin = 100 - yesPolyPlusNoKalshi;
      if (margin > 0) {
        validStrategies.push({
          sum: yesPolyPlusNoKalshi,
          margin,
          type: "yes_poly_no_kalshi",
        });
      }
    }

    // Check Strategy 2: No Poly + Yes Kalshi
    if (noPolyPlusYesKalshi < this.MAX_ARBITRAGE_THRESHOLD) {
      const margin = 100 - noPolyPlusYesKalshi;
      if (margin > 0) {
        validStrategies.push({
          sum: noPolyPlusYesKalshi,
          margin,
          type: "no_poly_yes_kalshi",
        });
      }
    }

    // Only return if we have at least one valid strategy with positive margin
    if (validStrategies.length === 0) {
      return null;
    }

    // Find the best strategy (highest margin = best arbitrage)
    const bestStrategy = validStrategies.reduce((best, current) =>
      current.margin > best.margin ? current : best
    );

    return {
      yesPolyPlusNoKalshi,
      noPolyPlusYesKalshi,
      bestMargin: bestStrategy.margin, // Always positive since margin = 100 - sum and sum < threshold
      bestType: bestStrategy.type,
    };
  }

  /**
   * Pre-process markets to extract and cache keywords
   */
  private preprocessMarkets(
    polymarkets: PolymarketMarket[],
    kalshiMarkets: KalshiMarket[]
  ): {
    polyProcessed: Array<{
      market: PolymarketMarket;
      keywords: Set<string>;
      keywordHash: string;
      text: string;
      endDate?: Date;
    }>;
    kalshiProcessed: Array<{
      market: KalshiMarket;
      keywords: Set<string>;
      keywordHash: string;
      text: string;
      closeTime?: Date;
    }>;
  } {
    console.log(`   📝 Pre-processing markets (extracting keywords)...`);
    const startTime = Date.now();

    const polyProcessed = polymarkets.map((market) => {
      const text = `${market.question || ""} ${market.description || ""}`;
      const keywords = this.extractKeywords(text);
      // Create hash for quick filtering
      const keywordHash = Array.from(keywords).sort().join("|");
      return {
        market,
        keywords,
        keywordHash,
        text,
        endDate: market.endDate ? new Date(market.endDate) : undefined,
      };
    });

    const kalshiProcessed = kalshiMarkets.map((market) => {
      const text = `${market.title || ""} ${market.subtitle || ""}`;
      const keywords = this.extractKeywords(text);
      const keywordHash = Array.from(keywords).sort().join("|");
      return {
        market,
        keywords,
        keywordHash,
        text,
        closeTime: market.close_time ? new Date(market.close_time) : undefined,
      };
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✓ Pre-processing complete in ${elapsed}s`);

    return { polyProcessed, kalshiProcessed };
  }

  /**
   * Fast similarity check using cached keywords
   */
  private fastSimilarityCheck(
    polyProcessed: { keywords: Set<string>; keywordHash: string; endDate?: Date },
    kalshiProcessed: { keywords: Set<string>; keywordHash: string; closeTime?: Date }
  ): number {
    // Quick Jaccard similarity using pre-computed keyword sets
    const intersection = new Set(
      [...polyProcessed.keywords].filter((x) => kalshiProcessed.keywords.has(x))
    );
    const union = new Set([...polyProcessed.keywords, ...kalshiProcessed.keywords]);

    if (union.size === 0) return 0;
    let similarity = intersection.size / union.size;

    // Quick date check
    if (polyProcessed.endDate && kalshiProcessed.closeTime) {
      const daysDiff = Math.abs(
        (polyProcessed.endDate.getTime() - kalshiProcessed.closeTime.getTime()) /
          (1000 * 60 * 60 * 24)
      );
      if (daysDiff <= this.DATE_TOLERANCE_DAYS) {
        similarity += Math.max(0, 1 - daysDiff / this.DATE_TOLERANCE_DAYS) * 0.2;
      } else {
        similarity *= 0.7;
      }
    }

    return Math.min(1, similarity);
  }

  /**
   * Find matching markets between Polymarket and Kalshi - OPTIMIZED VERSION
   */
  private async findMatchingMarkets(
    polymarkets: PolymarketMarket[],
    kalshiMarkets: KalshiMarket[]
  ): Promise<MarketMatch[]> {
    console.log(`\n🔗 Starting optimized market matching...`);
    console.log(`   Comparing ${polymarkets.length.toLocaleString()} Polymarket × ${kalshiMarkets.length.toLocaleString()} Kalshi markets`);
    console.log(`   Total comparisons: ${(polymarkets.length * kalshiMarkets.length).toLocaleString()}`);

    // Pre-process all markets (extract keywords once)
    const { polyProcessed, kalshiProcessed } = this.preprocessMarkets(
      polymarkets,
      kalshiMarkets
    );

    const matches: MarketMatch[] = [];
    const totalComparisons = polyProcessed.length * kalshiProcessed.length;
    let comparisonsDone = 0;
    let matchesFound = 0;

    // Log progress every 100k comparisons or every 5 seconds
    const logInterval = 100000;
    let lastLogTime = Date.now();
    const logIntervalMs = 5000; // Log every 5 seconds

    const startTime = Date.now();
    console.log(`\n   🔄 Starting comparisons at ${new Date().toLocaleTimeString()}...`);

    // Process comparisons with better progress tracking
    for (const polyProc of polyProcessed) {
      for (const kalshiProc of kalshiProcessed) {
        comparisonsDone++;

        // Fast similarity check using pre-computed keywords
        const similarity = this.fastSimilarityCheck(polyProc, kalshiProc);

        if (similarity >= this.MIN_SIMILARITY_SCORE) {
          matches.push({
            polymarket: polyProc.market,
            kalshi: kalshiProc.market,
            similarityScore: similarity,
          });
          matchesFound++;
        }

        // Log progress: either every N comparisons OR every N seconds
        const now = Date.now();
        const shouldLog =
          comparisonsDone % logInterval === 0 ||
          now - lastLogTime >= logIntervalMs ||
          comparisonsDone === totalComparisons;

        if (shouldLog) {
          const progress = ((comparisonsDone / totalComparisons) * 100).toFixed(2);
          const elapsed = ((now - startTime) / 1000).toFixed(1);
          const rate = comparisonsDone / ((now - startTime) / 1000); // comparisons per second
          const remaining = totalComparisons - comparisonsDone;
          const eta = remaining / rate; // seconds remaining

          console.log(
            `   [${new Date().toLocaleTimeString()}] Progress: ${progress}% | ` +
              `${comparisonsDone.toLocaleString()}/${totalComparisons.toLocaleString()} comparisons | ` +
              `${matchesFound} matches | ` +
              `${rate.toFixed(0).toLocaleString()} cmp/s | ` +
              `ETA: ${(eta / 60).toFixed(1)} min`
          );
          lastLogTime = now;
        }
      }
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `\n   ✓ Matching complete in ${totalElapsed}s: Found ${matches.length} potential matches`
    );

    // Sort by similarity score (highest first)
    console.log(`   Sorting matches by similarity...`);
    matches.sort((a, b) => b.similarityScore - a.similarityScore);

    // Remove duplicates (keep best match for each market)
    console.log(`   Removing duplicate matches...`);
    const seenPoly = new Set<string>();
    const seenKalshi = new Set<string>();
    const uniqueMatches: MarketMatch[] = [];

    for (const match of matches) {
      if (
        !seenPoly.has(match.polymarket.id) &&
        !seenKalshi.has(match.kalshi.ticker)
      ) {
        uniqueMatches.push(match);
        seenPoly.add(match.polymarket.id);
        seenKalshi.add(match.kalshi.ticker);
      }
    }

    console.log(`   ✓ After deduplication: ${uniqueMatches.length} unique matches`);

    // Show top matches for visibility
    if (uniqueMatches.length > 0) {
      console.log(`\n   📊 Top 5 matches by similarity:`);
      uniqueMatches.slice(0, 5).forEach((match, idx) => {
        console.log(`   ${idx + 1}. Similarity: ${(match.similarityScore * 100).toFixed(1)}%`);
        console.log(`      Poly: "${match.polymarket.question?.substring(0, 60)}..."`);
        console.log(`      Kalshi: "${match.kalshi.title?.substring(0, 60)}..."`);
      });
    }

    return uniqueMatches;
  }

  /**
   * Save arbitrage opportunity to database
   */
  private async saveArbitrageOpportunity(
    match: MarketMatch,
    calculation: ArbitrageCalculation,
    polyPrices: { yesPrice: number; noPrice: number },
    kalshiPrices: { yesBid: number; yesAsk: number; noBid: number; noAsk: number }
  ): Promise<void> {
    try {
      const repo = AppDataSource.getRepository(ArbitrageOpportunity);

      // Check if opportunity already exists
      const existing = await repo.findOne({
        where: {
          polymarketId: match.polymarket.id,
          kalshiTicker: match.kalshi.ticker,
        },
      });

      const opportunityData = {
        polymarketId: match.polymarket.id,
        polymarketQuestion: match.polymarket.question || "",
        polymarketSlug: match.polymarket.slug,
        polymarketConditionId: match.polymarket.conditionId,
        polymarketLink: polymarketService.getMarketUrl(
          match.polymarket.slug,
          match.polymarket.id
        ),
        polymarketYesPrice: polyPrices.yesPrice,
        polymarketNoPrice: polyPrices.noPrice,
        polymarketLiquidity: match.polymarket.liquidityNum || parseFloat(match.polymarket.liquidity || "0"),
        polymarketEndDate: match.polymarket.endDate
          ? new Date(match.polymarket.endDate)
          : undefined,
        kalshiTicker: match.kalshi.ticker,
        kalshiTitle: match.kalshi.title || "",
        kalshiEventTicker: match.kalshi.event_ticker,
        kalshiLink: kalshiService.getMarketUrl(match.kalshi.ticker || ""),
        kalshiYesBid: match.kalshi.yes_bid,
        kalshiYesAsk: match.kalshi.yes_ask,
        kalshiNoBid: match.kalshi.no_bid,
        kalshiNoAsk: match.kalshi.no_ask,
        kalshiLiquidity: parseFloat(match.kalshi.liquidity_dollars || "0"),
        kalshiCloseTime: match.kalshi.close_time
          ? new Date(match.kalshi.close_time)
          : undefined,
        yesPolymarketPlusNoKalshi: calculation.yesPolyPlusNoKalshi,
        noPolymarketPlusYesKalshi: calculation.noPolyPlusYesKalshi,
        bestArbitrageMargin: calculation.bestMargin,
        arbitrageType: calculation.bestType,
        similarityScore: match.similarityScore,
        metadata: {
          polyDescription: match.polymarket.description || null,
          kalshiSubtitle: match.kalshi.subtitle || null,
          polyVolume: match.polymarket.volumeNum ?? null,
          kalshiVolume: match.kalshi.volume ?? null,
        } as Record<string, any>,
      };

      if (existing) {
        // Update existing opportunity - use save instead of update for complex types
        await repo.save({ ...existing, ...opportunityData });
        console.log(
          `  ✓ Updated arbitrage: ${match.polymarket.question?.substring(0, 50)}...`
        );
      } else {
        // Create new opportunity
        const opportunity = repo.create(opportunityData);
        await repo.save(opportunity);
        console.log(
          `  ✓ Saved new arbitrage: ${match.polymarket.question?.substring(0, 50)}...`
        );
      }
    } catch (error) {
      console.error(
        `❌ Error saving arbitrage opportunity:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Main discovery method - finds arbitrage opportunities
   */
  async discoverArbitrageOpportunities(): Promise<void> {
    console.log("🔍 Starting arbitrage discovery...");
    console.log(`📅 Filter: Markets closing after ${new Date().toISOString().split("T")[0]}`);
    console.log(`💰 Minimum liquidity: $${this.MIN_LIQUIDITY}`);

    try {
      // Get current date for filtering
      const currentDate = new Date();
      const minEndDate = currentDate.toISOString().split("T")[0];
      const minCloseTimestamp = Math.floor(currentDate.getTime() / 1000);

      console.log("\n📊 Fetching markets from both platforms simultaneously...");
      console.log("   (This may take a few minutes depending on market volume)\n");
      
      // Fetch from both APIs in parallel
      const fetchPromise = Promise.all([
        polymarketService.getAllActiveMarkets(minEndDate, this.MIN_LIQUIDITY),
        kalshiService.getAllOpenMarkets(minCloseTimestamp),
      ]);

      // Show progress indicators
      const progressInterval = setInterval(() => {
        process.stdout.write(".");
      }, 1000);

      const [polymarketMarkets, kalshiMarkets] = await fetchPromise;
      clearInterval(progressInterval);

      console.log(`\n\n✓ Fetched ${polymarketMarkets.length.toLocaleString()} Polymarket markets`);
      console.log(`✓ Fetched ${kalshiMarkets.length.toLocaleString()} Kalshi markets`);

      const matches = await this.findMatchingMarkets(polymarketMarkets, kalshiMarkets);

      if (matches.length === 0) {
        console.log("\n❌ No matching markets found. Exiting.");
        return;
      }

      console.log("\n💹 Calculating arbitrage opportunities...");
      let comparedCount = 0;
      let arbitrageCount = 0;

      // Process matches in parallel batches for better performance
      const BATCH_SIZE = 50; // Process 50 matches at a time
      
      for (let i = 0; i < matches.length; i += BATCH_SIZE) {
        const batch = matches.slice(i, i + BATCH_SIZE);
        
        // Process batch in parallel
        const batchPromises = batch.map(async (match) => {
          // Parse Polymarket prices
          const polyPrices = this.parsePolymarketPrices(match.polymarket);
          if (!polyPrices) {
            return null;
          }

          // Get Kalshi prices
          const kalshiPrices = this.getKalshiPrices(match.kalshi);

          // Calculate arbitrage
          const calculation = this.calculateArbitrage(polyPrices, kalshiPrices);

          if (calculation) {
            console.log(
              `\n  💰 ARBITRAGE FOUND! Margin: ${calculation.bestMargin.toFixed(2)}% | Type: ${calculation.bestType}`
            );
            console.log(
              `     Poly: "${match.polymarket.question?.substring(0, 50)}..."`
            );
            console.log(
              `     Kalshi: "${match.kalshi.title?.substring(0, 50)}..."`
            );
            
            await this.saveArbitrageOpportunity(
              match,
              calculation,
              polyPrices,
              kalshiPrices
            );
            return true; // Arbitrage found
          }
          
          return false; // No arbitrage
        });

        // Wait for batch to complete
        const batchResults = await Promise.all(batchPromises);
        
        comparedCount += batch.length;
        const batchArbitrageCount = batchResults.filter(r => r === true).length;
        arbitrageCount += batchArbitrageCount;

        // Log progress after each batch
        console.log(
          `  Progress: ${comparedCount}/${matches.length} compared, ${arbitrageCount} arbitrages found`
        );
      }

      console.log("\n✅ Discovery complete!");
      console.log(`📈 Statistics:`);
      console.log(`   - Similar markets found: ${matches.length}`);
      console.log(`   - Markets compared: ${comparedCount}`);
      console.log(`   - Arbitrage opportunities found: ${arbitrageCount}`);
    } catch (error) {
      console.error("\n❌ Error during arbitrage discovery:", error);
      throw error;
    }
  }

  /**
   * Get all saved arbitrage opportunities
   */
  async getArbitrageOpportunities(
    limit: number = 100,
    offset: number = 0
  ): Promise<ArbitrageOpportunity[]> {
    const repo = AppDataSource.getRepository(ArbitrageOpportunity);
    return repo.find({
      take: limit,
      skip: offset,
      order: {
        bestArbitrageMargin: "DESC",
      },
    });
  }
}

export const arbitrageDiscoveryService = new ArbitrageDiscoveryService();

