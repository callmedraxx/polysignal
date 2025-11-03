/**
 * Category detection from Polymarket tags
 * Infers category from market tags returned by the Polymarket API
 */

import type { TradeCategory } from "./category-detector.js";

export type { TradeCategory };

/**
 * Infer category from Polymarket tags
 * Priority order:
 * 1. If tags contain "sports" (or related sports tags), return "sports"
 * 2. If tags contain "politics", return "politics"
 * 3. If tags contain "economic" or "economics", return "economic"
 * 4. If tags contain "crypto" or "cryptocurrency", return "crypto"
 * 5. Otherwise, return "other"
 * 
 * If multiple category tags exist (e.g., politics and economic), prefer politics, then economic
 */
export function inferCategoryFromTags(tags: Array<{ slug: string; label?: string }>): TradeCategory {
  if (!tags || tags.length === 0) {
    return "other";
  }

  const tagSlugs = tags.map(tag => tag.slug.toLowerCase());
  const tagLabels = tags
    .map(tag => tag.label?.toLowerCase())
    .filter((label): label is string => !!label);

  // Check for sports - highest priority for sports-related tags
  const sportsKeywords = ["sports", "sport", "nfl", "nba", "nhl", "mlb", "mls", "soccer", "football", "basketball", "baseball", "hockey", "tennis", "golf", "games"];
  if (tagSlugs.some(slug => sportsKeywords.some(keyword => slug === keyword || slug.includes(keyword))) ||
      tagLabels.some(label => sportsKeywords.some(keyword => label === keyword || label.includes(keyword)))) {
    return "sports";
  }

  // Check for politics
  const politicsKeywords = ["politics", "political", "election", "elections", "president", "presidential"];
  if (tagSlugs.some(slug => politicsKeywords.some(keyword => slug === keyword || slug.includes(keyword))) ||
      tagLabels.some(label => politicsKeywords.some(keyword => label === keyword || label.includes(keyword)))) {
    return "politics";
  }

  // Check for economic
  const economicKeywords = ["economic", "economics", "economy", "finance", "financial", "markets", "federal-reserve", "fed"];
  if (tagSlugs.some(slug => economicKeywords.some(keyword => slug === keyword || slug.includes(keyword))) ||
      tagLabels.some(label => economicKeywords.some(keyword => label === keyword || label.includes(keyword)))) {
    return "economic";
  }

  // Check for crypto
  const cryptoKeywords = ["crypto", "cryptocurrency", "bitcoin", "btc", "ethereum", "eth", "blockchain", "defi"];
  if (tagSlugs.some(slug => cryptoKeywords.some(keyword => slug === keyword || slug.includes(keyword))) ||
      tagLabels.some(label => cryptoKeywords.some(keyword => label === keyword || label.includes(keyword)))) {
    return "crypto";
  }

  // Default to "other" if no category matches
  return "other";
}

