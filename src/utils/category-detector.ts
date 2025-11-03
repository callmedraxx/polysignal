/**
 * Category detection utility for Polymarket trades
 * Analyzes market titles and slugs to categorize into: politics, crypto, sports, economic, or other
 */

export type TradeCategory = "politics" | "crypto" | "sports" | "economic" | "other";

/**
 * Comprehensive keyword lists for each category
 * Organized by specificity - more specific terms checked first
 */
const CATEGORY_KEYWORDS: Record<TradeCategory, { strong: string[]; moderate: string[] }> = {
  other: {
    strong: [],
    moderate: [],
  },
  politics: {
    strong: [
      // Elections & Political Figures
      "president",
      "presidential",
      "election",
      "elections",
      "biden",
      "trump",
      "democrat",
      "republican",
      "senate",
      "congress",
      "senator",
      "governor",
      "mayor",
      "primaries",
      "primary",
      "vote",
      "voting",
      "ballot",
      "impeachment",
      "cabinet",
      "supreme court",
      "scotus",
      "nomination",
      "veto",
      "approval rating",
      "approval",
      
      // Political Events
      "inauguration",
      "state of the union",
      "debate",
      "debates",
      "campaign",
      "midterm",
      "midterms",
      "referendum",
      "referendums",
      "brexit",
      
      // Parties & Movements
      "democratic party",
      "republican party",
      "gop",
      "liberal",
      "conservative",
      "left",
      "right",
      "far-left",
      "far-right",
      "socialist",
      
      // Government
      "government",
      "federal",
      "state",
      "local",
      "legislature",
      "parliament",
      "minister",
      "secretary",
      "ambassador",
      "embassy",
    ],
    moderate: [
      "policy",
      "policies",
      "act",
      "bill",
      "law",
      "legislation",
      "regulatory",
      "regulation",
      "subpoena",
      "indictment",
      "lawsuit",
      "court",
      "judge",
      "justice",
      "prosecutor",
      "attorney general",
      "fbi",
      "cia",
      "national security",
      "homeland security",
      "border",
      "immigration",
      "visa",
    ],
  },
  
  crypto: {
    strong: [
      // Cryptocurrencies
      "bitcoin",
      "btc",
      "ethereum",
      "eth",
      "ether",
      "crypto",
      "cryptocurrency",
      "cryptocurrencies",
      "altcoin",
      "altcoins",
      "stablecoin",
      "stablecoins",
      "usdt",
      "usdc",
      "dai",
      "tether",
      
      // Blockchain & Web3
      "blockchain",
      "web3",
      "web 3",
      "defi",
      "decentralized",
      "nft",
      "nfts",
      "dao",
      "daos",
      "smart contract",
      "smart contracts",
      "dapp",
      "dapps",
      "yield farming",
      "liquidity",
      "staking",
      "validator",
      "mining",
      "proof of stake",
      "proof of work",
      "pos",
      "pow",
      
      // Exchanges & Platforms
      "coinbase",
      "binance",
      "ftx",
      "kraken",
      "uniswap",
      "pancakeswap",
      "sushiswap",
      "opensea",
      "metamask",
      "wallet",
      
      // Tokens & Coins
      "token",
      "tokens",
      "coin",
      "coins",
      "solana",
      "sol",
      "cardano",
      "ada",
      "polkadot",
      "dot",
      "chainlink",
      "link",
      "polygon",
      "matic",
      "avalanche",
      "avax",
      "cosmos",
      "atom",
      "litecoin",
      "ltc",
      "xrp",
      "ripple",
      "dogecoin",
      "doge",
      "shiba",
      "meme coin",
      "meme coins",
      
      // Crypto Events
      "halving",
      "fork",
      "hard fork",
      "soft fork",
      "upgrade",
      "merge",
      "shanghai",
      "cancun",
    ],
    moderate: [
      "hodl",
      "satoshi",
      "whale",
      "whales",
      "pump",
      "dump",
      "rug pull",
      "hack",
      "exploit",
      "airdrop",
      "ico",
      "ido",
      "launch",
      "listing",
      "delisting",
      "regulation",
      "regulatory",
      "sec",
      "cfdc",
      "gbtc",
      "etf",
      "spot etf",
      "futures etf",
    ],
  },
  
  sports: {
    strong: [
      // Major Sports
      "nfl",
      "super bowl",
      "superbowl",
      "nba",
      "nba finals",
      "nhl",
      "stanley cup",
      "mlb",
      "world series",
      "mls",
      "premier league",
      "champions league",
      "uefa",
      "fifa",
      "world cup",
      "olympics",
      "olympic",
      
      // Teams & Players
      "team",
      "teams",
      "player",
      "players",
      "athlete",
      "athletes",
      "coach",
      "manager",
      
      // Sports Terms
      "game",
      "games",
      "match",
      "matches",
      "playoff",
      "playoffs",
      "playoff",
      "championship",
      "championships",
      "champion",
      "champions",
      "tournament",
      "tournaments",
      "bracket",
      "brackets",
      "draft",
      "draft pick",
      "mvp",
      "most valuable player",
      "all-star",
      "all star",
      "rookie",
      "rookie of the year",
      "mvp",
      
      // Specific Sports
      "football",
      "soccer",
      "basketball",
      "baseball",
      "hockey",
      "tennis",
      "golf",
      "boxing",
      "mma",
      "ufc",
      "nascar",
      "formula 1",
      "f1",
      "racing",
      "racing",
      "cricket",
      "rugby",
      
      // Sports Events
      "kickoff",
      "halftime",
      "overtime",
      "penalty",
      "goal",
      "touchdown",
      "home run",
      "homerun",
      "ace",
      "grand slam",
    ],
    moderate: [
      "score",
      "scoring",
      "points",
      "win",
      "wins",
      "loss",
      "losses",
      "tie",
      "ties",
      "season",
      "seasons",
      "regular season",
      "postseason",
      "preseason",
      "trade",
      "trades",
      "free agency",
      "free agent",
      "contract",
      "contracts",
      "salary",
      "injury",
      "injuries",
      "suspension",
      "suspensions",
    ],
  },
  
  economic: {
    strong: [
      // Economic Indicators
      "gdp",
      "gross domestic product",
      "inflation",
      "cpi",
      "consumer price index",
      "ppi",
      "producer price index",
      "unemployment",
      "unemployment rate",
      "jobless",
      "jobs report",
      "non-farm payroll",
      "nonfarm payroll",
      "nfp",
      "fed",
      "federal reserve",
      "interest rate",
      "interest rates",
      "fed funds",
      "federal funds rate",
      "monetary policy",
      "quantitative easing",
      "qe",
      "tapering",
      "rate hike",
      "rate cut",
      "recession",
      "recessions",
      "depression",
      "gdp growth",
      "economic growth",
      
      // Markets & Finance
      "stock market",
      "stock markets",
      "dow",
      "dow jones",
      "sp500",
      "s&p 500",
      "s&p500",
      "nasdaq",
      "dow jones",
      "market index",
      "market indices",
      "bear market",
      "bull market",
      "crash",
      "correction",
      "volatility",
      "vix",
      "yield",
      "yields",
      "bond",
      "bonds",
      "treasury",
      "treasuries",
      "10-year",
      "30-year",
      "commodity",
      "commodities",
      "gold",
      "silver",
      "oil",
      "crude",
      "gasoline",
      "natural gas",
      
      // Currencies
      "dollar",
      "dollars",
      "usd",
      "yen",
      "jpy",
      "euro",
      "eur",
      "pound",
      "gbp",
      "yuan",
      "cny",
      "currency",
      "currencies",
      "forex",
      "fx",
      "exchange rate",
      "exchange rates",
      
      // Companies & Earnings
      "earnings",
      "earnings report",
      "revenue",
      "profit",
      "profits",
      "loss",
      "losses",
      "quarterly",
      "q1",
      "q2",
      "q3",
      "q4",
      "ipo",
      "merger",
      "acquisition",
      "acquisitions",
      
      // Economic Policies
      "stimulus",
      "stimulus package",
      "tax",
      "taxes",
      "tariff",
      "tariffs",
      "trade war",
      "trade deal",
      "debt ceiling",
      "budget",
      "deficit",
      "surplus",
    ],
    moderate: [
      "economic",
      "economy",
      "financial",
      "finance",
      "banking",
      "bank",
      "banks",
      "lending",
      "credit",
      "debt",
      "default",
      "liquidity",
      "solvency",
      "bankruptcy",
      "bailout",
      "bailouts",
      "consumer",
      "consumers",
      "retail",
      "wholesale",
      "supply chain",
      "logistics",
      "manufacturing",
      "industrial",
      "production",
      "capacity",
    ],
  },
};

/**
 * Normalize text for comparison (lowercase, remove special chars)
 */
function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

/**
 * Check if text contains any of the keywords (case-insensitive)
 */
function containsKeywords(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(keyword));
}

/**
 * Detect category from market title and slug
 * Returns one of: "politics", "crypto", "sports", "economic"
 * Returns null if no category can be determined with confidence
 */
export function detectCategory(
  marketTitle?: string | null,
  slug?: string | null
): TradeCategory | null {
  // Combine title and slug for analysis
  const searchText = [marketTitle, slug]
    .filter((text) => text && typeof text === "string")
    .join(" ");

  if (!searchText) {
    return null;
  }

  const normalized = normalizeText(searchText);

  // Score each category based on keyword matches
  const scores: Record<TradeCategory, number> = {
    politics: 0,
    crypto: 0,
    sports: 0,
    economic: 0,
    other: 0,
  };

  // Score based on strong keywords (higher weight)
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const cat = category as TradeCategory;
    
    // Strong keywords get 3 points each
    for (const keyword of keywords.strong) {
      if (normalized.includes(keyword)) {
        scores[cat] += 3;
      }
    }
    
    // Moderate keywords get 1 point each
    for (const keyword of keywords.moderate) {
      if (normalized.includes(keyword)) {
        scores[cat] += 1;
      }
    }
  }

  // Find the category with the highest score
  const maxScore = Math.max(...Object.values(scores));
  
  // Only return a category if we have a minimum confidence threshold
  // Require at least 3 points (one strong keyword match)
  if (maxScore < 3) {
    return "other"; // Return "other" if no strong match found
  }

  // Return the category with the highest score
  const winner = Object.entries(scores).find(([_, score]) => score === maxScore)?.[0] as TradeCategory;
  
  return winner || "other"; // Fallback to "other" if somehow no winner
}

/**
 * Detect category from activity metadata
 * Extracts market title and slug from metadata and detects category
 */
export function detectCategoryFromMetadata(
  metadata?: Record<string, any> | null
): TradeCategory | null {
  if (!metadata) {
    return null;
  }

  const marketTitle = metadata.market || metadata.title || null;
  const slug = metadata.slug || metadata.eventSlug || null;

  return detectCategory(marketTitle, slug);
}

