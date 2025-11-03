import axios, { type AxiosInstance } from "axios";

// Kalshi API Types
export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  open_time: string;
  close_time: string;
  expected_expiration_time: string;
  expiration_time: string;
  latest_expiration_time: string;
  settlement_timer_seconds: number;
  status: string;
  response_price_units: string;
  yes_bid: number;
  yes_bid_dollars: string;
  yes_ask: number;
  yes_ask_dollars: string;
  no_bid: number;
  no_bid_dollars: string;
  no_ask: number;
  no_ask_dollars: string;
  last_price: number;
  last_price_dollars: string;
  volume: number;
  volume_24h: number;
  result: string | null;
  can_close_early: boolean;
  open_interest: number;
  notional_value: number;
  notional_value_dollars: string;
  previous_yes_bid: number;
  previous_yes_bid_dollars: string;
  previous_yes_ask: number;
  previous_yes_ask_dollars: string;
  previous_price: number;
  previous_price_dollars: string;
  liquidity: number;
  liquidity_dollars: string;
  settlement_value: number;
  settlement_value_dollars: string;
  expiration_value: string;
  category: string;
  risk_limit_cents: number;
  fee_waiver_expiration_time?: string;
  early_close_condition?: string;
  tick_size: number;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
  functional_strike?: string;
  custom_strike?: Record<string, any>;
  rules_primary?: string;
  rules_secondary?: string;
  mve_collection_ticker?: string;
  mve_selected_legs?: Array<{
    event_ticker: string;
    market_ticker: string;
    side: string;
  }>;
  primary_participant_key?: string;
  price_level_structure?: string;
  price_ranges?: Array<{
    start: string;
    end: string;
    step: string;
  }>;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export interface KalshiMarketsParams {
  limit?: number;
  cursor?: string;
  event_ticker?: string;
  series_ticker?: string;
  max_close_ts?: number;
  min_close_ts?: number;
  status?: string;
  tickers?: string;
}

class KalshiService {
  private client: AxiosInstance;
  private readonly baseURL = "https://api.elections.kalshi.com/trade-api/v2";

  constructor() {
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Fetch markets from Kalshi API
   */
  async getMarkets(params?: KalshiMarketsParams): Promise<KalshiMarketsResponse> {
    try {
      const queryParams: Record<string, any> = {
        limit: params?.limit ?? 1000,
        ...(params?.cursor && { cursor: params.cursor }),
        ...(params?.event_ticker && { event_ticker: params.event_ticker }),
        ...(params?.series_ticker && { series_ticker: params.series_ticker }),
        ...(params?.max_close_ts && { max_close_ts: params.max_close_ts }),
        ...(params?.min_close_ts && { min_close_ts: params.min_close_ts }),
        ...(params?.status && { status: params.status }),
        ...(params?.tickers && { tickers: params.tickers }),
      };

      const response = await this.client.get<KalshiMarketsResponse>("/markets", {
        params: queryParams,
      });

      return response.data;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        console.error(
          `❌ Error fetching Kalshi markets:`,
          error.response?.data || error.message
        );
      } else {
        console.error(`❌ Unexpected error fetching Kalshi markets:`, error);
      }
      throw error;
    }
  }

  /**
   * Fetch all open markets with pagination
   * Continues fetching using cursor until no more results
   */
  async getAllOpenMarkets(
    minCloseTimestamp?: number
  ): Promise<KalshiMarket[]> {
    const allMarkets: KalshiMarket[] = [];
    let cursor: string | undefined = undefined;
    let hasMore = true;
    let batchCount = 0;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;

    while (hasMore) {
      try {
        const params: KalshiMarketsParams = {
          limit: 1000,
          status: "open",
          ...(cursor && { cursor }),
          ...(minCloseTimestamp && { min_close_ts: minCloseTimestamp }),
        };

        batchCount++;
        const cursorInfo = cursor ? `cursor: ${cursor.substring(0, 20)}...` : "initial request";
        console.log(`  Fetching Kalshi batch ${batchCount} (${cursorInfo})...`);

        const response = await this.getMarkets(params);
        
        if (response.markets.length === 0) {
          console.log(`  Batch ${batchCount}: No markets returned (cursor may be exhausted)`);
          hasMore = false;
          break;
        }

        allMarkets.push(...response.markets);
        console.log(`  Batch ${batchCount}: Fetched ${response.markets.length} markets (total: ${allMarkets.length})`);

        // Check if there's a next cursor
        if (response.cursor && response.cursor.length > 0 && response.cursor !== cursor) {
          cursor = response.cursor;
          consecutiveErrors = 0; // Reset error counter on success
          
          // Safety check: stop if we've fetched too many (likely infinite loop)
          if (batchCount >= 500) {
            console.log(`  ⚠️  Stopping: Reached safety limit of 500 batches (${allMarkets.length} markets)`);
            console.log(`  If this seems incomplete, please check the API for remaining markets.`);
            hasMore = false;
            break;
          }
        } else {
          // No cursor or same cursor means we've reached the end
          if (response.cursor && response.cursor === cursor) {
            console.log(`  Reached end: Same cursor returned (no new results)`);
          } else {
            console.log(`  Reached end: No cursor returned`);
          }
          hasMore = false;
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (error) {
        consecutiveErrors++;
        console.error(`❌ Error fetching Kalshi markets batch ${batchCount}:`, error);
        
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`  Giving up after ${maxConsecutiveErrors} consecutive errors`);
          hasMore = false;
        } else {
          // Wait longer on error before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    console.log(`  ✓ Completed fetching Kalshi markets: ${allMarkets.length} total across ${batchCount} batches`);
    return allMarkets;
  }

  /**
   * Get market URL for a Kalshi market
   */
  getMarketUrl(ticker: string): string {
    return `https://kalshi.com/markets/${ticker}`;
  }
}

export const kalshiService = new KalshiService();

