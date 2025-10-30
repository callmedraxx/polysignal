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

class PolymarketService {
  private client: AxiosInstance;
  private readonly baseURL = "https://data-api.polymarket.com";

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
}

export const polymarketService = new PolymarketService();

