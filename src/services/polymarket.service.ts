import axios, { type AxiosInstance } from "axios";

// Polymarket API Types
export interface PolymarketTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  bio: string;
  profileImage: string;
  profileImageOptimized: string;
  transactionHash: string;
}

export interface TradeQueryParams {
  limit?: number;
  offset?: number;
  takerOnly?: boolean;
  filterType?: "CASH" | "TOKENS";
  filterAmount?: number;
  market?: string[];
  eventId?: number[];
  user?: string;
  side?: "BUY" | "SELL";
}

export interface PolymarketPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

export interface PolymarketClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
}

// Polymarket Market Types
export interface PolymarketTag {
  id: string;
  label: string;
  slug: string;
  forceShow?: boolean;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  forceHide?: boolean;
  isCarousel?: boolean;
}

export interface PolymarketMarketBySlug {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  tags?: PolymarketTag[];
  [key: string]: any; // Allow additional fields
}

export interface PolymarketMarket {
  id: string;
  question: string;
  conditionId?: string;
  slug?: string;
  resolutionSource?: string;
  endDate?: string;
  category?: string;
  liquidity?: string;
  liquidityNum?: number;
  startDate?: string;
  image?: string;
  icon?: string;
  description?: string;
  outcomes?: string; // JSON string array
  outcomePrices?: string; // JSON string array
  volume?: string;
  volumeNum?: number;
  active?: boolean;
  closed?: boolean;
  [key: string]: any; // Allow additional fields
}

class PolymarketService {
  private client: AxiosInstance;
  private readonly baseURL = "https://data-api.polymarket.com";
  private readonly gammaBaseURL = "https://gamma-api.polymarket.com";

  constructor() {
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Get a separate client for Gamma API (markets endpoint)
   */
  private getGammaClient(): AxiosInstance {
    return axios.create({
      baseURL: this.gammaBaseURL,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Fetch markets from Polymarket Gamma API
   */
  async getMarkets(params?: {
    limit?: number;
    offset?: number;
    end_date_min?: string;
    liquidity_num_min?: number;
  }): Promise<PolymarketMarket[]> {
    try {
      const gammaClient = this.getGammaClient();
      const queryParams: Record<string, any> = {
        limit: params?.limit ?? 200,
        ...(params?.offset !== undefined && { offset: params.offset }),
        ...(params?.end_date_min && { end_date_min: params.end_date_min }),
        ...(params?.liquidity_num_min && { liquidity_num_min: params.liquidity_num_min }),
      };

      const response = await gammaClient.get<PolymarketMarket[]>("/markets", {
        params: queryParams,
      });

      return response.data;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        console.error(
          `❌ Error fetching Polymarket markets:`,
          error.response?.data || error.message
        );
      } else {
        console.error(`❌ Unexpected error fetching Polymarket markets:`, error);
      }
      throw error;
    }
  }

  /**
   * Get market by slug from Polymarket Gamma API
   * @param slug - The market slug
   * @param includeTag - Whether to include tags in the response
   * @returns Market data with tags if requested
   */
  async getMarketBySlug(
    slug: string,
    includeTag: boolean = true
  ): Promise<PolymarketMarketBySlug | null> {
    try {
      const gammaClient = this.getGammaClient();
      const url = `/markets/slug/${slug}${includeTag ? "?include_tag=true" : ""}`;
      
      const response = await gammaClient.get<PolymarketMarketBySlug>(url);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          // Market not found
          return null;
        }
        console.error(
          `❌ Error fetching market by slug "${slug}":`,
          error.response?.status,
          error.response?.statusText
        );
      } else {
        console.error(`❌ Error fetching market by slug "${slug}":`, error);
      }
      return null;
    }
  }

  /**
   * Fetch all active markets with pagination
   * Continues fetching until no more results are returned
   */
  async getAllActiveMarkets(
    minEndDate?: string,
    minLiquidity: number = 100
  ): Promise<PolymarketMarket[]> {
    const allMarkets: PolymarketMarket[] = [];
    let offset = 0;
    const limit = 200;
    let hasMore = true;
    let batchCount = 0;
    let consecutiveEmpty = 0;
    let consecutiveErrors = 0;
    const maxConsecutiveEmpty = 3;
    const maxConsecutiveErrors = 3;

    console.log(`  Fetching batch ${batchCount + 1} (offset: ${offset})...`);

    while (hasMore) {
      try {
        const params: any = {
          limit,
          offset,
          liquidity_num_min: minLiquidity,
        };
        
        if (minEndDate) {
          params.end_date_min = minEndDate;
        }

        const markets = await this.getMarkets(params);
        batchCount++;

        // Reset error counter on success
        consecutiveErrors = 0;

        if (markets.length === 0) {
          consecutiveEmpty++;
          console.log(`  Batch ${batchCount}: No markets returned (empty count: ${consecutiveEmpty}/${maxConsecutiveEmpty})`);
          
          if (consecutiveEmpty >= maxConsecutiveEmpty) {
            console.log(`  Stopping: ${maxConsecutiveEmpty} consecutive empty batches`);
            hasMore = false;
            break;
          }
          
          // Still increment offset to check next page
          offset += limit;
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }

        // Reset empty counter when we get results
        consecutiveEmpty = 0;
        allMarkets.push(...markets);

        console.log(`  Batch ${batchCount}: Fetched ${markets.length} markets (total: ${allMarkets.length}, offset: ${offset})`);

        // If we got fewer than the limit, we've reached the end
        if (markets.length < limit) {
          console.log(`  Reached end: Got ${markets.length} markets (less than limit of ${limit})`);
          hasMore = false;
        } else {
          // Increment offset for next batch
          offset += limit;
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (error) {
        consecutiveErrors++;
        console.error(`❌ Error fetching Polymarket markets batch ${batchCount + 1} (offset ${offset}):`, error);
        
        // On error, try up to maxConsecutiveErrors times before giving up
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`  Giving up after ${maxConsecutiveErrors} consecutive errors`);
          hasMore = false;
        } else {
          // Wait longer on error before retrying same offset
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    console.log(`  ✓ Completed fetching Polymarket markets: ${allMarkets.length} total across ${batchCount} batches`);
    return allMarkets;
  }

  /**
   * Get market URL for a Polymarket market
   */
  getMarketUrl(slug?: string, id?: string): string {
    if (slug) {
      return `https://polymarket.com/market/${slug}`;
    }
    if (id) {
      return `https://polymarket.com/event/${id}`;
    }
    return "https://polymarket.com";
  }

  /**
   * Legacy method - redirects to the new getMarketBySlug with tags
   * @deprecated Use getMarketBySlug(slug, true) instead
   */
  async getMarketBySlugLegacy(slug: string): Promise<PolymarketMarket | null> {
    try {
      const marketData = await this.getMarketBySlug(slug, false);
      if (!marketData) return null;
      
      // Convert PolymarketMarketBySlug to PolymarketMarket format
      return marketData as PolymarketMarket;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          // Market not found, return null
          return null;
        }
        console.error(
          `❌ Error fetching market by slug "${slug}":`,
          error.response?.data || error.message
        );
      } else {
        console.error(`❌ Unexpected error fetching market by slug:`, error);
      }
      return null;
    }
  }

  /**
   * Get category for a market by slug
   * Returns null if market not found or category unavailable
   */
  async getMarketCategory(slug: string): Promise<string | null> {
    try {
      const market = await this.getMarketBySlug(slug, false);
      return market?.category || null;
    } catch (error) {
      console.error(`❌ Error getting market category for slug "${slug}":`, error);
      return null;
    }
  }

  /**
   * Fetch trades for a specific user wallet address
   */
  async getUserTrades(
    walletAddress: string,
    params?: Omit<TradeQueryParams, "user">
  ): Promise<PolymarketTrade[]> {
    try {
      const queryParams: TradeQueryParams = {
        user: walletAddress,
        limit: params?.limit ?? 100,
        offset: params?.offset ?? 0,
        takerOnly: params?.takerOnly ?? true,
        ...params,
      };

      const response = await this.client.get<PolymarketTrade[]>("/trades", {
        params: queryParams,
      });

      return response.data;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        console.error(
          `❌ Error fetching trades for ${walletAddress}:`,
          error.response?.data || error.message
        );
      } else {
        console.error(`❌ Unexpected error fetching trades:`, error);
      }
      return [];
    }
  }

  /**
   * Fetch recent trades for a user (last N trades)
   */
  async getRecentUserTrades(
    walletAddress: string,
    limit: number = 50
  ): Promise<PolymarketTrade[]> {
    return this.getUserTrades(walletAddress, { limit });
  }

  /**
   * Fetch trades after a specific timestamp
   */
  async getTradesAfterTimestamp(
    walletAddress: string,
    afterTimestamp: number
  ): Promise<PolymarketTrade[]> {
    const allTrades = await this.getUserTrades(walletAddress, { limit: 100 });
    return allTrades.filter((trade) => trade.timestamp > afterTimestamp);
  }

  /**
   * Fetch current positions for a user
   * Batches conditionIds to avoid URL length limits
   */
  async getUserPositions(
    walletAddress: string,
    conditionIds?: string[]
  ): Promise<PolymarketPosition[]> {
    try {
      // If no conditionIds provided, fetch all positions
      if (!conditionIds || conditionIds.length === 0) {
        const response = await this.client.get<PolymarketPosition[]>("/positions", {
          params: {
            user: walletAddress,
            limit: 500, // Max allowed
          },
        });
        return response.data;
      }

      // Batch conditionIds to avoid URL length limits (50 per batch to be safe)
      const BATCH_SIZE = 50;
      const allPositions: PolymarketPosition[] = [];

      for (let i = 0; i < conditionIds.length; i += BATCH_SIZE) {
        const batch = conditionIds.slice(i, i + BATCH_SIZE);
        
        try {
          const response = await this.client.get<PolymarketPosition[]>("/positions", {
            params: {
              user: walletAddress,
              market: batch,
              limit: 500,
            },
          });
          
          allPositions.push(...response.data);
        } catch (error: any) {
          if (axios.isAxiosError(error)) {
            console.error(
              `❌ Error fetching positions batch for ${walletAddress} (batch ${Math.floor(i / BATCH_SIZE) + 1}):`,
              error.response?.data || error.message
            );
          } else {
            console.error(`❌ Unexpected error fetching positions batch:`, error);
          }
          // Continue with next batch even if one fails
        }
      }

      return allPositions;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        console.error(
          `❌ Error fetching positions for ${walletAddress}:`,
          error.response?.data || error.message
        );
      } else {
        console.error(`❌ Unexpected error fetching positions:`, error);
      }
      return [];
    }
  }

  /**
   * Fetch closed positions for a user
   * Batches conditionIds to avoid URL length limits
   */
  async getUserClosedPositions(
    walletAddress: string,
    conditionIds?: string[],
    offset?: number,
    limit?: number
  ): Promise<PolymarketClosedPosition[]> {
    try {
      const requestLimit = limit || 500; // Default to 500, max allowed
      
      // If no conditionIds provided, fetch all closed positions
      if (!conditionIds || conditionIds.length === 0) {
        const response = await this.client.get<PolymarketClosedPosition[]>("/closed-positions", {
          params: {
            user: walletAddress,
            limit: requestLimit,
            ...(offset !== undefined && { offset }),
          },
        });
        return response.data;
      }

      // Batch conditionIds to avoid URL length limits (50 per batch to be safe)
      const BATCH_SIZE = 50;
      const allPositions: PolymarketClosedPosition[] = [];

      for (let i = 0; i < conditionIds.length; i += BATCH_SIZE) {
        const batch = conditionIds.slice(i, i + BATCH_SIZE);
        
        try {
          const response = await this.client.get<PolymarketClosedPosition[]>("/closed-positions", {
            params: {
              user: walletAddress,
              market: batch,
              limit: requestLimit,
              ...(offset !== undefined && { offset }),
            },
          });
          
          allPositions.push(...response.data);
        } catch (error: any) {
          if (axios.isAxiosError(error)) {
            console.error(
              `❌ Error fetching closed positions batch for ${walletAddress} (batch ${Math.floor(i / BATCH_SIZE) + 1}):`,
              error.response?.data || error.message
            );
          } else {
            console.error(`❌ Unexpected error fetching closed positions batch:`, error);
          }
          // Continue with next batch even if one fails
        }
      }

      return allPositions;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        console.error(
          `❌ Error fetching closed positions for ${walletAddress}:`,
          error.response?.data || error.message
        );
      } else {
        console.error(`❌ Unexpected error fetching closed positions:`, error);
      }
      return [];
    }
  }
}

export const polymarketService = new PolymarketService();

