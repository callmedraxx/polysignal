import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

interface ChannelConfig {
  default?: string;
  sport?: string;
  sports?: string; // Alias for sport (category detector returns "sports")
  crypto?: string;
  politics?: string;
  economic?: string;
  whale?: string;
  whales?: string; // Alias for whale
  gainz?: string; // Channel for high-profit closed positions
  free?: string; // Channel for free subscription traders
}

interface MessageFieldConfig {
  showShares: boolean;
  showTotalShares: boolean;
  showUsdValue: boolean;
  showValueInTitle: boolean;
  showWhen: boolean;
  showType: boolean;
  showStatus: boolean;
  showPrice: boolean;
  showOutcome: boolean;
  showEntryPrice: boolean;
  showExitPrice: boolean;
  showRealizedPnl: boolean;
}

interface StatusAlertConfig {
  sendForAdded: boolean;
  sendForOpen: boolean;
  sendForClosed: boolean;
  sendForPartiallyClosed: boolean;
}

interface GainzAlertConfig {
  showMarket: boolean;
  showTrader: boolean;
  showProfitPercent: boolean;
  showRealizedPnl: boolean;
  showPositionValue: boolean;
  showWhen: boolean;
  showCategory: boolean;
  showThumbnail: boolean;
  showFooter: boolean;
  showTimestamp: boolean;
  showEntryPrice: boolean;
  showExitPrice: boolean;
  showOutcome: boolean;
}

/**
 * Helper to parse boolean from environment variable
 * Defaults to false if not set or invalid
 */
function parseBooleanEnv(key: string, defaultValue: boolean = false): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

class DiscordService {
  private client: Client;
  private channels: ChannelConfig;
  private isReady: boolean = false;
  private messageFields: MessageFieldConfig; // For regular traders
  private whaleMessageFields: MessageFieldConfig; // For whale category traders
  private statusAlerts: StatusAlertConfig; // For regular traders
  private whaleStatusAlerts: StatusAlertConfig; // For whale category traders
  private gainzThreshold: number;
  private gainzAlertConfig: GainzAlertConfig; // For gainz alerts

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
    });

    // Helper to safely get environment variable (treat empty strings as undefined)
    const getEnvVar = (key: string): string | undefined => {
      const value = process.env[key];
      return value && value.trim() ? value.trim() : undefined;
    };

    // Parse channel IDs from environment (treat empty strings as undefined)
    this.channels = {
      default: getEnvVar("DISCORD_NOTIFICATION_CHANNEL_ID") || getEnvVar("DISCORD_CHANNEL_ID"),
      sport: getEnvVar("DISCORD_SPORT_CHANNEL_ID") || getEnvVar("DISCORD_SPORTS_CHANNEL_ID"),
      sports: getEnvVar("DISCORD_SPORTS_CHANNEL_ID") || getEnvVar("DISCORD_SPORT_CHANNEL_ID"), // Support both plural and singular
      crypto: getEnvVar("DISCORD_CRYPTO_CHANNEL_ID"),
      whale: getEnvVar("DISCORD_WHALE_CHANNEL_ID") || getEnvVar("DISCORD_WHALES_CHANNEL_ID"),
      politics: getEnvVar("DISCORD_POLITICS_CHANNEL_ID"),
      economic: getEnvVar("DISCORD_ECONOMIC_CHANNEL_ID"),
      gainz: getEnvVar("DISCORD_GAINZ_CHANNEL_ID"),
      free: getEnvVar("DISCORD_FREE_CHANNEL_ID"),
    };

    // Configure message field visibility from environment variables for regular traders
    // Defaults: all fields shown (true) except shares/totalShares/usdValue/valueInTitle (false for backward compatibility)
    this.messageFields = {
      showShares: parseBooleanEnv("DISCORD_SHOW_SHARES", false),
      showTotalShares: parseBooleanEnv("DISCORD_SHOW_TOTAL_SHARES", false),
      showUsdValue: parseBooleanEnv("DISCORD_SHOW_USD_VALUE", false),
      showValueInTitle: parseBooleanEnv("DISCORD_SHOW_VALUE_IN_TITLE", false),
      showWhen: parseBooleanEnv("DISCORD_SHOW_WHEN", true),
      showType: parseBooleanEnv("DISCORD_SHOW_TYPE", true),
      showStatus: parseBooleanEnv("DISCORD_SHOW_STATUS", true),
      showPrice: parseBooleanEnv("DISCORD_SHOW_PRICE", true),
      showOutcome: parseBooleanEnv("DISCORD_SHOW_OUTCOME", true),
      showEntryPrice: parseBooleanEnv("DISCORD_SHOW_ENTRY_PRICE", true),
      showExitPrice: parseBooleanEnv("DISCORD_SHOW_EXIT_PRICE", true),
      showRealizedPnl: parseBooleanEnv("DISCORD_SHOW_REALIZED_PNL", true),
    };

    // Configure message field visibility for whale category traders (separate controls)
    // Defaults: all fields shown (true) except shares/totalShares/usdValue/valueInTitle (false for backward compatibility)
    this.whaleMessageFields = {
      showShares: parseBooleanEnv("DISCORD_WHALE_SHOW_SHARES", false),
      showTotalShares: parseBooleanEnv("DISCORD_WHALE_SHOW_TOTAL_SHARES", false),
      showUsdValue: parseBooleanEnv("DISCORD_WHALE_SHOW_USD_VALUE", false),
      showValueInTitle: parseBooleanEnv("DISCORD_WHALE_SHOW_VALUE_IN_TITLE", false),
      showWhen: parseBooleanEnv("DISCORD_WHALE_SHOW_WHEN", true),
      showType: parseBooleanEnv("DISCORD_WHALE_SHOW_TYPE", true),
      showStatus: parseBooleanEnv("DISCORD_WHALE_SHOW_STATUS", true),
      showPrice: parseBooleanEnv("DISCORD_WHALE_SHOW_PRICE", true),
      showOutcome: parseBooleanEnv("DISCORD_WHALE_SHOW_OUTCOME", true),
      showEntryPrice: parseBooleanEnv("DISCORD_WHALE_SHOW_ENTRY_PRICE", true),
      showExitPrice: parseBooleanEnv("DISCORD_WHALE_SHOW_EXIT_PRICE", true),
      showRealizedPnl: parseBooleanEnv("DISCORD_WHALE_SHOW_REALIZED_PNL", true),
    };

    // Configure status-based alert controls for regular traders
    // Defaults: all statuses enabled (true)
    this.statusAlerts = {
      sendForAdded: parseBooleanEnv("DISCORD_SEND_FOR_ADDED", true),
      sendForOpen: parseBooleanEnv("DISCORD_SEND_FOR_OPEN", true),
      sendForClosed: parseBooleanEnv("DISCORD_SEND_FOR_CLOSED", true),
      sendForPartiallyClosed: parseBooleanEnv("DISCORD_SEND_FOR_PARTIALLY_CLOSED", true),
    };

    // Configure status-based alert controls for whale category traders
    // Defaults: all statuses enabled (true)
    this.whaleStatusAlerts = {
      sendForAdded: parseBooleanEnv("DISCORD_WHALE_SEND_FOR_ADDED", true),
      sendForOpen: parseBooleanEnv("DISCORD_WHALE_SEND_FOR_OPEN", true),
      sendForClosed: parseBooleanEnv("DISCORD_WHALE_SEND_FOR_CLOSED", true),
      sendForPartiallyClosed: parseBooleanEnv("DISCORD_WHALE_SEND_FOR_PARTIALLY_CLOSED", true),
    };

    // Log field configuration
    console.log(`📋 Discord message field configuration (Regular traders):`);
    console.log(`   - Show Shares: ${this.messageFields.showShares}`);
    console.log(`   - Show Total Shares: ${this.messageFields.showTotalShares}`);
    console.log(`   - Show USD Value: ${this.messageFields.showUsdValue}`);
    console.log(`   - Show Value in Title: ${this.messageFields.showValueInTitle}`);
    console.log(`   - Show When: ${this.messageFields.showWhen}`);
    console.log(`   - Show Type: ${this.messageFields.showType}`);
    console.log(`   - Show Status: ${this.messageFields.showStatus}`);
    console.log(`   - Show Price: ${this.messageFields.showPrice}`);
    console.log(`   - Show Outcome: ${this.messageFields.showOutcome}`);
    
    console.log(`📋 Discord message field configuration (Whale traders):`);
    console.log(`   - Show Shares: ${this.whaleMessageFields.showShares}`);
    console.log(`   - Show Total Shares: ${this.whaleMessageFields.showTotalShares}`);
    console.log(`   - Show USD Value: ${this.whaleMessageFields.showUsdValue}`);
    console.log(`   - Show Value in Title: ${this.whaleMessageFields.showValueInTitle}`);
    console.log(`   - Show When: ${this.whaleMessageFields.showWhen}`);
    console.log(`   - Show Type: ${this.whaleMessageFields.showType}`);
    console.log(`   - Show Status: ${this.whaleMessageFields.showStatus}`);
    console.log(`   - Show Price: ${this.whaleMessageFields.showPrice}`);
    console.log(`   - Show Outcome: ${this.whaleMessageFields.showOutcome}`);
    
    console.log(`📋 Discord status alert configuration (Regular traders):`);
    console.log(`   - Send for Added: ${this.statusAlerts.sendForAdded}`);
    console.log(`   - Send for Open: ${this.statusAlerts.sendForOpen}`);
    console.log(`   - Send for Closed: ${this.statusAlerts.sendForClosed}`);
    console.log(`   - Send for Partially Closed: ${this.statusAlerts.sendForPartiallyClosed}`);
    
    console.log(`📋 Discord status alert configuration (Whale traders):`);
    console.log(`   - Send for Added: ${this.whaleStatusAlerts.sendForAdded}`);
    console.log(`   - Send for Open: ${this.whaleStatusAlerts.sendForOpen}`);
    console.log(`   - Send for Closed: ${this.whaleStatusAlerts.sendForClosed}`);
    console.log(`   - Send for Partially Closed: ${this.whaleStatusAlerts.sendForPartiallyClosed}`);
    
    // Configure gainz alert threshold
    this.gainzThreshold = parseFloat(process.env.DISCORD_GAINZ_THRESHOLD || "50");
    console.log(`🎯 Gainz alert threshold: ${this.gainzThreshold}%`);
    if (this.channels.gainz) {
      console.log(`   - Gainz channel: ${this.channels.gainz}`);
    } else {
      console.log(`   - Gainz channel: not configured`);
    }

    // Configure gainz alert field visibility
    // Defaults: all fields shown (true)
    this.gainzAlertConfig = {
      showMarket: parseBooleanEnv("DISCORD_GAINZ_SHOW_MARKET", true),
      showTrader: parseBooleanEnv("DISCORD_GAINZ_SHOW_TRADER", true),
      showProfitPercent: parseBooleanEnv("DISCORD_GAINZ_SHOW_PROFIT_PERCENT", true),
      showRealizedPnl: parseBooleanEnv("DISCORD_GAINZ_SHOW_REALIZED_PNL", true),
      showPositionValue: parseBooleanEnv("DISCORD_GAINZ_SHOW_POSITION_VALUE", true),
      showWhen: parseBooleanEnv("DISCORD_GAINZ_SHOW_WHEN", true),
      showCategory: parseBooleanEnv("DISCORD_GAINZ_SHOW_CATEGORY", true),
      showThumbnail: parseBooleanEnv("DISCORD_GAINZ_SHOW_THUMBNAIL", true),
      showFooter: parseBooleanEnv("DISCORD_GAINZ_SHOW_FOOTER", true),
      showTimestamp: parseBooleanEnv("DISCORD_GAINZ_SHOW_TIMESTAMP", true),
      showEntryPrice: parseBooleanEnv("DISCORD_GAINZ_SHOW_ENTRY_PRICE", true),
      showExitPrice: parseBooleanEnv("DISCORD_GAINZ_SHOW_EXIT_PRICE", true),
      showOutcome: parseBooleanEnv("DISCORD_GAINZ_SHOW_OUTCOME", true),
    };

    console.log(`📋 Discord gainz alert field configuration:`);
    console.log(`   - Show Market: ${this.gainzAlertConfig.showMarket}`);
    console.log(`   - Show Trader: ${this.gainzAlertConfig.showTrader}`);
    console.log(`   - Show Profit %: ${this.gainzAlertConfig.showProfitPercent}`);
    console.log(`   - Show Realized PnL: ${this.gainzAlertConfig.showRealizedPnl}`);
    console.log(`   - Show Position Value: ${this.gainzAlertConfig.showPositionValue}`);
    console.log(`   - Show When: ${this.gainzAlertConfig.showWhen}`);
    console.log(`   - Show Category: ${this.gainzAlertConfig.showCategory}`);
    console.log(`   - Show Thumbnail: ${this.gainzAlertConfig.showThumbnail}`);
    console.log(`   - Show Footer: ${this.gainzAlertConfig.showFooter}`);
    console.log(`   - Show Timestamp: ${this.gainzAlertConfig.showTimestamp}`);
    console.log(`   - Show Entry Price: ${this.gainzAlertConfig.showEntryPrice}`);
    console.log(`   - Show Exit Price: ${this.gainzAlertConfig.showExitPrice}`);
    console.log(`   - Show Outcome: ${this.gainzAlertConfig.showOutcome}`);
    
    // Count configured channels
    const channelCount = Object.values(this.channels).filter(c => c).length;
    if (channelCount > 0) {
      console.log(`📢 Discord bot configured for ${channelCount} channel(s)`);
      console.log(`   - Default: ${this.channels.default ? `YES (${this.channels.default})` : "not configured"}`);
      console.log(`   - Sport/Sports: ${(this.channels.sport || this.channels.sports) ? `YES (${this.channels.sport || this.channels.sports})` : "not configured"}`);
      console.log(`   - Crypto: ${this.channels.crypto ? `YES (${this.channels.crypto})` : "not configured"}`);
      console.log(`   - Politics: ${this.channels.politics ? `YES (${this.channels.politics})` : "not configured"}`);
      console.log(`   - Economic: ${this.channels.economic ? `YES (${this.channels.economic})` : "not configured"}`);
      console.log(`   - Whale: ${this.channels.whale ? `YES (${this.channels.whale})` : "not configured"}`);
      console.log(`   - Gainz: ${this.channels.gainz ? `YES (${this.channels.gainz})` : "not configured"}`);
    } else {
      console.warn(`⚠️  No Discord channels configured!`);
    }

    this.client.once("ready", () => {
      console.log(`✅ Discord bot logged in as ${this.client.user?.tag}`);
      this.isReady = true;
    });

    this.client.on("error", (error) => {
      console.error("❌ Discord client error:", error);
    });
  }

  /**
   * Get channel ID(s) based on subscription type, whale category, and trade category
   * Priority: subscriptionType (free -> free channel) > whale category > trade category
   */
  private getChannelIds(whaleCategory: string, tradeCategory?: string, subscriptionType?: string): string[] {
    const channelIds: string[] = [];
    const whaleCatLower = whaleCategory.toLowerCase();
    const subTypeLower = subscriptionType?.toLowerCase();
    
    // Priority 1: If subscription type is "free", route to free channel (ignore categories)
    if (subTypeLower === "free") {
      if (this.channels.free) {
        channelIds.push(this.channels.free);
        console.log(`🎯 Routing to FREE channel (subscriptionType: ${subscriptionType}, ignoring trade category)`);
        return channelIds;
      } else {
        console.log(`⚠️  FREE subscription type detected but no free channel configured. Falling back to default/category routing.`);
        // Fall through to default routing if free channel not configured
      }
    }
    
    // Priority 2: If whale is "whale", always use whale channel (only if not free subscription)
    if (whaleCatLower === "whale") {
      if (this.channels.whale) {
        channelIds.push(this.channels.whale);
        console.log(`🎯 Routing to WHALE channel (whale category: ${whaleCategory})`);
        return channelIds;
      } else {
        console.log(`⚠️  WHALE category detected but no whale channel configured. Available: whale=${this.channels.whale}, whales=${this.channels.whales}`);
        // If whale channel not configured, fall back to default
        if (this.channels.default) {
          channelIds.push(this.channels.default);
          console.log(`📌 WHALE category using DEFAULT channel fallback -> ${this.channels.default}`);
          return channelIds;
        }
        return channelIds; // Return empty if no default either
      }
    }
    
    // Priority 3: If whale is "regular" and subscription is "paid", route based on trade category
    // (If subscription is "free", it would have been caught above)
    if (whaleCatLower === "regular" && tradeCategory && subTypeLower !== "free") {
      const tradeCatLower = tradeCategory.toLowerCase();
      console.log(`🔍 Routing check: whaleCategory="${whaleCategory}", tradeCategory="${tradeCategory}" (lowercase: "${tradeCatLower}")`);
      
      // Check for "sports" (plural) - category detector returns "sports"
      if ((tradeCatLower === "sports" || tradeCatLower === "sport")) {
        const sportChannel = this.channels.sports || this.channels.sport;
        if (sportChannel) {
          channelIds.push(sportChannel);
          console.log(`✅ Routed to SPORT channel (${tradeCatLower}) -> ${sportChannel}`);
          return channelIds;
        } else {
          console.log(`⚠️  SPORT category detected but no channel configured. Available: sport=${this.channels.sport}, sports=${this.channels.sports}`);
        }
      } else if (tradeCatLower === "crypto") {
        if (this.channels.crypto) {
          channelIds.push(this.channels.crypto);
          console.log(`✅ Routed to CRYPTO channel -> ${this.channels.crypto}`);
          return channelIds;
        } else {
          console.log(`⚠️  CRYPTO category detected but no channel configured`);
        }
      } else if (tradeCatLower === "politics") {
        if (this.channels.politics) {
          channelIds.push(this.channels.politics);
          console.log(`✅ Routed to POLITICS channel -> ${this.channels.politics}`);
          return channelIds;
        } else {
          console.log(`⚠️  POLITICS category detected but no channel configured`);
        }
      } else if (tradeCatLower === "economic") {
        if (this.channels.economic) {
          channelIds.push(this.channels.economic);
          console.log(`✅ Routed to ECONOMIC channel -> ${this.channels.economic}`);
          return channelIds;
        } else {
          console.log(`⚠️  ECONOMIC category detected but no channel configured`);
        }
      } else {
        console.log(`⚠️  Unknown trade category "${tradeCatLower}" - falling back to default`);
      }
      
      // Fallback to default channel if no category match or channel not configured
      if (channelIds.length === 0 && this.channels.default) {
        channelIds.push(this.channels.default);
        console.log(`📌 Fallback to DEFAULT channel -> ${this.channels.default}`);
      }
    } else if (this.channels.default) {
      // Default fallback when whale is not "regular" or no trade category
      channelIds.push(this.channels.default);
      console.log(`📌 Using DEFAULT channel (whaleCategory="${whaleCategory}", tradeCategory="${tradeCategory || 'N/A'}")`);
    }
    
    return channelIds.filter(id => id); // Remove any undefined/null
  }

  /**
   * Format a timestamp into Discord's auto-updating relative time format
   * Uses Discord's timestamp format: <t:timestamp:R> which shows "2 hours ago" and auto-updates
   */
  private formatDiscordTimestamp(timestamp: string | Date): string {
    const date = new Date(timestamp);
    const unixTimestamp = Math.floor(date.getTime() / 1000); // Convert to Unix timestamp in seconds
    return `<t:${unixTimestamp}:R>`; // :R means relative time (auto-updates)
  }

  async connect(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    
    if (!token || token === "your_discord_bot_token_here") {
      console.warn("⚠️  Discord bot token not configured. Skipping Discord connection.");
      return;
    }

    try {
      await this.client.login(token);
    } catch (error) {
      console.error("❌ Failed to connect Discord bot:", error);
    }
  }

  /**
   * Parse additionalInfo to extract outcome and price
   */
  private parseAdditionalInfo(additionalInfo?: string): { outcome?: string; price?: string } {
    if (!additionalInfo) return {};
    
    const outcomeMatch = additionalInfo.match(/Outcome:\s*(.+)/i);
    const priceMatch = additionalInfo.match(/Price:\s*\$\s*(.+)/i);
    
    return {
      outcome: outcomeMatch && outcomeMatch[1] ? outcomeMatch[1].trim() : undefined,
      price: priceMatch && priceMatch[1] ? priceMatch[1].trim() : undefined,
    };
  }

  async sendWhaleAlert(data: {
    walletAddress: string;
    activityType: string;
    traderName?: string;
    profileUrl?: string;
    thumbnailUrl?: string;
    marketLink?: string;
    marketName?: string;
    shares?: string;
    totalShares?: number; // Total shares from position (for open/partially closed)
    totalBought?: number; // Total bought (for closed positions)
    usdValue?: string;
    activityTimestamp?: string | Date;
    transactionHash?: string;
    blockchain?: string;
    additionalInfo?: string;
    status?: string;
    realizedPnl?: string;
    percentPnl?: number; // Percentage PnL from position
    whaleCategory?: string; // "regular" or "whale"
    tradeCategory?: string; // e.g., "sport", "crypto", "politics"
    subscriptionType?: string; // "free" or "paid"
  }): Promise<string | null> {
    if (!this.isReady) {
      console.warn("⚠️  Discord bot not ready");
      return null;
    }

    // Get channel IDs based on subscription type, whale category, and trade category
    const whaleCategory = data.whaleCategory || "regular";
    const tradeCategory = data.tradeCategory;
    const subscriptionType = data.subscriptionType;

    // Check if alert should be sent for this status
    if (!this.shouldSendAlertForStatus(whaleCategory, data.status)) {
      console.log(
        `⏭️  Skipping Discord alert (status "${data.status}" disabled for ${whaleCategory} traders) | Whale: ${data.traderName || data.walletAddress}`
      );
      return null;
    }
    
    // Debug logging
    console.log(
      `🔍 Discord routing input: whaleCategory="${whaleCategory}", tradeCategory="${tradeCategory || 'undefined'}", type=${typeof tradeCategory}`
    );
    
    // Log channel configuration for debugging
    console.log(
      `📋 Available channels: default=${this.channels.default ? 'YES' : 'NO'}, politics=${this.channels.politics ? 'YES' : 'NO'}, crypto=${this.channels.crypto ? 'YES' : 'NO'}, sport=${(this.channels.sport || this.channels.sports) ? 'YES' : 'NO'}, economic=${this.channels.economic ? 'YES' : 'NO'}`
    );
    
    const channelIds = this.getChannelIds(whaleCategory, tradeCategory, subscriptionType);

    if (channelIds.length === 0) {
      console.warn(`⚠️  No channel configured for whale category "${whaleCategory}" and trade category "${tradeCategory || 'N/A'}"`);
      return null;
    }

    console.log(
      `📢 Routing Discord message | Whale: ${data.traderName || data.walletAddress} | Subscription: ${subscriptionType || 'N/A'} | Whale Category: ${whaleCategory} | Trade Category: ${tradeCategory || 'N/A'} | Channel(s): ${channelIds.join(', ')}`
    );

    // Build embed once (reused for all channels)
    const embed = this.buildWhaleAlertEmbed(data, whaleCategory);

    // Send to appropriate channel(s)
    const messageIds: string[] = [];
    for (const channelId of channelIds) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        
        if (!channel || !(channel instanceof TextChannel)) {
          console.error(`❌ Channel ${channelId} not found or not a text channel`);
          continue;
        }

        // Clone embed for each channel (embeds are mutable)
        const channelEmbed = EmbedBuilder.from(embed.data);
        const sentMessage = await channel.send({ embeds: [channelEmbed] });
        messageIds.push(sentMessage.id);
        console.log(`✅ Discord notification sent to channel ${channelId}`);
      } catch (error) {
        console.error(`❌ Failed to send Discord message to channel ${channelId}:`, error);
      }
    }

    // Return first message ID for backward compatibility (or JSON array for multiple)
    // Store as JSON array: ["msgId1", "msgId2", ...] or single string for one channel
    if (messageIds.length === 0) {
      return null;
    }
    
    // Filter out any undefined/null values and return
    const validMessageIds = messageIds.filter((id): id is string => !!id);
    if (validMessageIds.length === 0) {
      return null;
    }
    
    // Return JSON array if multiple channels, single ID if one channel
    const firstId = validMessageIds[0];
    if (!firstId) return null;
    return validMessageIds.length > 1 ? JSON.stringify(validMessageIds) : firstId;
  }

  /**
   * Build the whale alert embed (reusable for multiple channels)
   * Made public so it can be used for replies
   */
  /**
   * Format category name for display (capitalize first letter)
   */
  private formatCategoryName(category?: string): string {
    if (!category) return "";
    return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
  }

  /**
   * Get the appropriate message field configuration based on whale category
   */
  private getMessageFields(whaleCategory: string): MessageFieldConfig {
    const categoryLower = (whaleCategory || "regular").toLowerCase();
    return categoryLower === "whale" ? this.whaleMessageFields : this.messageFields;
  }

  /**
   * Get the appropriate status alert configuration based on whale category
   */
  private getStatusAlerts(whaleCategory: string): StatusAlertConfig {
    const categoryLower = (whaleCategory || "regular").toLowerCase();
    return categoryLower === "whale" ? this.whaleStatusAlerts : this.statusAlerts;
  }

  /**
   * Check if alert should be sent for the given status
   * Made public so it can be called from trade-polling service before sending/replying
   */
  public shouldSendAlertForStatus(whaleCategory: string, status?: string): boolean {
    if (!status) return true; // Default to sending if status is not provided
    
    const statusAlerts = this.getStatusAlerts(whaleCategory);
    const statusLower = status.toLowerCase();
    
    if (statusLower === "added") return statusAlerts.sendForAdded;
    if (statusLower === "open") return statusAlerts.sendForOpen;
    if (statusLower === "closed") return statusAlerts.sendForClosed;
    if (statusLower === "partially_closed") return statusAlerts.sendForPartiallyClosed;
    
    return true; // Default to sending for unknown statuses
  }

  /**
   * Build dynamic title based on whale category, trade category, status, and PnL
   */
  private buildAlertTitle(
    whaleCategory: string,
    tradeCategory?: string,
    status?: string,
    usdValue?: string,
    percentPnl?: number
  ): string {
    const whaleCatLower = whaleCategory.toLowerCase();
    const statusLower = status ? status.toLowerCase() : "";
    const categoryDisplay = this.formatCategoryName(tradeCategory) || "Trade";
    
    // New title structure: "Opening/Closing [Category] Position" for open/closed statuses
    if (statusLower === "open") {
      // For open status: "Opening Sports Position"
      if (whaleCatLower === "whale") {
        return `🐋 Opening Whale Position`;
      } else {
        return `Opening ${categoryDisplay} Position`;
      }
    } else if (statusLower === "closed") {
      // For closed status: "Closing Sports Position (%pnl)" - only show %pnl for closed
      const pnlDisplay = percentPnl !== undefined
        ? ` (${percentPnl >= 0 ? "+" : ""}${percentPnl.toFixed(2)}%)`
        : "";
      
      if (whaleCatLower === "whale") {
        return `🐋 Closing Whale Position${pnlDisplay}`;
      } else {
        return `Closing ${categoryDisplay} Position${pnlDisplay}`;
      }
    } else {
      // For other statuses (added, partially_closed): keep old format
      const statusUpper = status ? status.toUpperCase().replace('_', ' ') : "";
      
      if (whaleCatLower === "whale") {
        const whaleFields = this.whaleMessageFields;
        if (status === "partially_closed") {
          // Show PnL percentage for partially closed
          if (percentPnl !== undefined) {
            const pnlSign = percentPnl >= 0 ? "+" : "";
            return `🐋 Whale Position ${statusUpper} (${pnlSign}${Math.abs(percentPnl).toFixed(2)}%)`;
          }
          return `🐋 Whale Position ${statusUpper}`;
        } else {
          // Show USD value for added positions (if enabled for whale category)
          const usdDisplay = (whaleFields.showValueInTitle && usdValue) 
            ? `$${parseFloat(usdValue).toFixed(2)}` 
            : "";
          return `🐋 Whale Position ${statusUpper}${usdDisplay ? ` (${usdDisplay})` : ""}`;
        }
      } else {
        // Regular category
        if (status === "partially_closed") {
          // Show PnL percentage for partially closed
          if (percentPnl !== undefined) {
            const pnlSign = percentPnl >= 0 ? "+" : "";
            return `${categoryDisplay} Position ${statusUpper} (${pnlSign}${Math.abs(percentPnl).toFixed(2)}%)`;
          }
          return `${categoryDisplay} Position ${statusUpper}`;
        } else {
          // For added positions, show USD value (if enabled for regular category)
          const regularFields = this.messageFields;
          const usdDisplay = (regularFields.showValueInTitle && usdValue) 
            ? `$${parseFloat(usdValue).toFixed(2)}` 
            : "";
          return `${categoryDisplay} Position ${statusUpper}${usdDisplay ? ` (${usdDisplay})` : ""}`;
        }
      }
    }
  }

  buildWhaleAlertEmbed(data: {
    walletAddress: string;
    activityType: string;
    traderName?: string;
    profileUrl?: string;
    thumbnailUrl?: string;
    marketLink?: string;
    marketName?: string;
    shares?: string;
    totalShares?: number;
    totalBought?: number;
    usdValue?: string;
    activityTimestamp?: string | Date;
    transactionHash?: string;
    blockchain?: string;
    additionalInfo?: string;
    status?: string;
    realizedPnl?: string;
    percentPnl?: number;
    whaleCategory?: string;
    tradeCategory?: string;
    subscriptionType?: string;
    entryPrice?: string;
    exitPrice?: string;
    outcome?: string;
  }, whaleCategory: string = "regular"): EmbedBuilder {
    // Get the appropriate field configuration based on whale category
    const fieldConfig = this.getMessageFields(whaleCategory);
    // Determine embed color based on status and PnL
    let embedColor = 0x0099ff; // Default blue
    if (data.status) {
      const statusLower = data.status.toLowerCase();
      if (statusLower === "open") {
        embedColor = 0x22c55e; // Green for open
      } else if (statusLower === "added") {
        embedColor = 0x0099ff; // Blue for added
      } else if (statusLower === "partially_closed") {
        embedColor = 0xff8c00; // Orange for partially closed
      } else if (statusLower === "closed") {
        // Dynamic color for closed positions: green if positive PnL, red if negative
        if (data.percentPnl !== undefined) {
          embedColor = data.percentPnl >= 0 ? 0x22c55e : 0xef4444; // Green for profit, red for loss
        } else {
          embedColor = 0xef4444; // Default red if no PnL data
        }
      }
    }

    // Format trader name with profile link if available
    // For "regular" category, remove trader link and label
    let traderDisplay: string;
    if (whaleCategory.toLowerCase() === "regular") {
      // Regular category: just show wallet address, no link or label
      traderDisplay = data.walletAddress;
    } else {
      // Whale category: show trader name with link
      traderDisplay = data.profileUrl && data.traderName
        ? `[${data.traderName}](${data.profileUrl})`
        : (data.traderName || data.walletAddress);
    }

    // Parse additional info for outcome and price (fallback if not provided directly)
    const parsedInfo = this.parseAdditionalInfo(data.additionalInfo);
    // Use outcome from data if available (for closed positions), otherwise from parsed info
    const outcome = data.outcome || parsedInfo.outcome;
    const price = parsedInfo.price;

    // Build dynamic title
    const title = this.buildAlertTitle(
      whaleCategory,
      data.tradeCategory,
      data.status,
      data.usdValue,
      data.percentPnl
    );

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(title);
    
    // Add thumbnail image (icon) if available
    if (data.thumbnailUrl) {
      embed.setThumbnail(data.thumbnailUrl);
    }

    // 1. Market link (after title)
    if (data.marketLink && data.marketName) {
      embed.addFields({
        name: "Market",
        value: `[${data.marketName}](${data.marketLink})`,
        inline: false,
      });
    }

    // 2. Trader link with person emoji (only for whale category)
    if (whaleCategory.toLowerCase() !== "regular") {
      embed.addFields({
        name: "👤 Trader",
        value: traderDisplay,
        inline: false,
      });
    }

    // 3. When and Type on same horizontal line (with padding for spacing) - conditional based on config
    const fields: Array<{ name: string; value: string; inline: boolean }> = [];
    const fieldPadding = "   "; // Extra spacing between inline fields
    
    if (fieldConfig.showWhen && data.activityTimestamp) {
      // Use Discord's auto-updating timestamp format
      // This shows when the TRADE happened (activityTimestamp), NOT when the message was created
      const discordTimestamp = this.formatDiscordTimestamp(data.activityTimestamp);
      fields.push({
        name: "⏰ When",
        value: `${discordTimestamp}${fieldPadding}`,
        inline: true,
      });
    }

    if (fieldConfig.showType) {
      fields.push({
        name: "📊 Type",
        value: `${fieldPadding}${data.activityType}`,
        inline: true,
      });
    }

    // 4. Shares and Value on next line (conditional based on config for whale category)
    if (fieldConfig.showShares && data.shares) {
      const sharesValue = parseFloat(data.shares).toFixed(2);
      let sharesDisplay = sharesValue;
      
      // Add total shares based on status (if enabled for whale category)
      if (fieldConfig.showTotalShares && 
          (data.status === "open" || data.status === "added" || data.status === "partially_closed" || data.status === "closed")) {
        // Show total shares from position for all statuses
        // For closed positions, totalShares will be 0 to show no remaining shares
        if (data.totalShares !== undefined && data.totalShares > 0) {
          sharesDisplay = `${sharesValue} / ${data.totalShares.toFixed(2)} total`;
        } else if (data.status === "closed" && data.totalShares === 0) {
          // For fully closed positions, show only current shares (don't show / 0 total)
          sharesDisplay = sharesValue;
        }
      }
      
      fields.push({
        name: "📈 Shares",
        value: `${sharesDisplay}${fieldPadding}`,
        inline: true,
      });
    }
    
    // Add USD Value field (if enabled for whale category)
    if (fieldConfig.showUsdValue && data.usdValue) {
      const usdValue = parseFloat(data.usdValue).toFixed(2);
      fields.push({
        name: "💰 Value",
        value: `${fieldPadding}$${usdValue}`,
        inline: true,
      });
    }

    // 5. Price fields - Entry Price and Exit Price for closed positions, or single Price for others
    const isClosed = data.status?.toLowerCase() === "closed";
    const isPartiallyClosed = data.status?.toLowerCase() === "partially_closed";
    
    if (isClosed && data.entryPrice && data.exitPrice) {
      // For closed positions: show Entry Price and Exit Price separately
      if (fieldConfig.showEntryPrice && data.entryPrice) {
        fields.push({
          name: "🏷️ Entry Price",
          value: `$${parseFloat(data.entryPrice).toFixed(2)}${fieldPadding}`,
          inline: true,
        });
      }
      
      if (fieldConfig.showExitPrice && data.exitPrice) {
        fields.push({
          name: "🏷️ Exit Price",
          value: `$${parseFloat(data.exitPrice).toFixed(2)}${fieldPadding}`,
          inline: true,
        });
      }
    } else {
      // For non-closed positions: use the existing price logic
      // Dynamic label based on status: "Entry Price" for open/added, "Exit Price" for partially_closed
      if (fieldConfig.showPrice && price) {
        let priceLabel = "🏷️ Price";
        if (data.status) {
          const statusLower = data.status.toLowerCase();
          if (statusLower === "partially_closed") {
            priceLabel = "🏷️ Exit Price";
          } else if (statusLower === "open" || statusLower === "added") {
            priceLabel = "🏷️ Entry Price";
          }
        }
        fields.push({
          name: priceLabel,
          value: `$${price}${fieldPadding}`,
          inline: true,
        });
      }
    }
    
    if (fieldConfig.showOutcome && outcome) {
      fields.push({
        name: "🎯 Outcome",
        value: `${fieldPadding}${outcome}`,
        inline: true,
      });
    }

    // 6. Status and PnL if available (on same line) - conditional based on config
    if (fieldConfig.showStatus && data.status) {
      const statusLower = data.status.toLowerCase();
      const statusEmoji = statusLower === "open" ? "✅" : 
                         statusLower === "added" ? "➕" :
                         statusLower === "closed" ? "❌" : 
                         statusLower === "partially_closed" ? "🟠" : "🔄";
      fields.push({
        name: `${statusEmoji} Status`,
        value: `${data.status.toUpperCase().replace('_', ' ')}${fieldPadding}`,
        inline: true,
      });
    }

    // Show Realized PnL only if enabled and available (for closed positions)
    if (fieldConfig.showRealizedPnl && data.realizedPnl) {
      const pnlValue = parseFloat(data.realizedPnl).toFixed(2);
      const pnlEmoji = parseFloat(data.realizedPnl) >= 0 ? "📈" : "📉";
      fields.push({
        name: `${pnlEmoji} Realized PnL`,
        value: `${fieldPadding}$${pnlValue}`,
        inline: true,
      });
    }

    // Add all fields at once
    if (fields.length > 0) {
      embed.addFields(fields);
    }

    // Set timestamp with platform info at bottom
    // This shows when the MESSAGE was sent/updated (current time), NOT the trade timestamp
    // The trade timestamp is shown in the "When" field above using activityTimestamp
    embed.setFooter({ text: "Polymarket" }).setTimestamp(new Date());

    return embed;
  }

  async sendMessage(message: string, channelId?: string): Promise<void> {
    if (!this.isReady) {
      console.warn("⚠️  Discord bot not ready");
      return;
    }

    // Use provided channel ID or default channel
    const channelIds = channelId ? [channelId] : (this.channels.default ? [this.channels.default] : []);

    if (channelIds.length === 0) {
      console.warn("⚠️  No channel configured");
      return;
    }

    // Send to specified channel(s)
    for (const id of channelIds) {
      try {
        const channel = await this.client.channels.fetch(id);
        
        if (!channel || !(channel instanceof TextChannel)) {
          console.error(`❌ Channel ${id} not found or not a text channel`);
          continue;
        }

        await channel.send(message);
        console.log(`✅ Discord message sent to channel ${id}`);
      } catch (error) {
        console.error(`❌ Failed to send Discord message to channel ${id}:`, error);
      }
    }
  }

  /**
   * Parse message ID(s) - supports single ID or JSON array
   */
  private parseMessageIds(messageId: string): string[] {
    try {
      // Try to parse as JSON array first
      const parsed = JSON.parse(messageId);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON, treat as single ID
    }
    // Single message ID
    return [messageId];
  }

  /**
   * Update an existing Discord message(s) in all channels
   * @param messageId - The ID(s) of the message(s) to update (can be single ID or JSON array)
   * @param data - The data to update the message with (same as sendWhaleAlert)
   * @returns true if at least one update succeeded, false otherwise
   */
  async updateWhaleAlert(messageId: string, data: {
    walletAddress: string;
    activityType: string;
    traderName?: string;
    profileUrl?: string;
    thumbnailUrl?: string;
    marketLink?: string;
    marketName?: string;
    shares?: string;
    totalShares?: number;
    totalBought?: number;
    usdValue?: string;
    activityTimestamp?: string | Date;
    transactionHash?: string;
    blockchain?: string;
    additionalInfo?: string;
    status?: string;
    realizedPnl?: string;
    percentPnl?: number;
    whaleCategory?: string;
    tradeCategory?: string;
    subscriptionType?: string;
  }): Promise<boolean> {
    if (!this.isReady) {
      console.warn("⚠️  Discord bot not ready");
      return false;
    }

    // Parse message IDs (can be single ID or JSON array)
    const messageIds = this.parseMessageIds(messageId);
    
    // Get channel IDs based on subscription type, categories (for logging)
    const whaleCategory = data.whaleCategory || "regular";
    const channelIds = this.getChannelIds(whaleCategory, data.tradeCategory, data.subscriptionType);

    if (channelIds.length === 0) {
      console.warn(`⚠️  No channel configured for update`);
      return false;
    }
    
    // Build embed once (reused for all channels)
    const embed = this.buildWhaleAlertEmbed(data, whaleCategory);

    // Update messages in all channels
    let successCount = 0;
    const messageIdArray = messageIds.filter((id): id is string => !!id);
    
    // Match message IDs with channels (by index if same count, otherwise try each ID in each channel)
    for (let i = 0; i < Math.max(channelIds.length, messageIdArray.length); i++) {
      const channelId = channelIds[i % channelIds.length];
      const msgId = messageIdArray[i % messageIdArray.length];
      
      if (!msgId || !channelId) continue;
      
      try {
        const channel = await this.client.channels.fetch(channelId);
        
        if (!channel || !(channel instanceof TextChannel)) {
          console.error(`❌ Channel ${channelId} not found or not a text channel`);
          continue;
        }

        const message = await channel.messages.fetch(msgId);
        
        // Clone embed for each channel (embeds are mutable)
        const channelEmbed = EmbedBuilder.from(embed.data);
        await message.edit({ embeds: [channelEmbed] });
        
        successCount++;
        
        // Enhanced logging for successful update
        const updateInfo = [
          `Trader: ${data.traderName || data.walletAddress}`,
          `Status: ${data.status || "N/A"}`,
          data.realizedPnl ? `PnL: $${parseFloat(data.realizedPnl).toFixed(2)}` : null,
          `Channel: ${channelId}`,
          `Message ID: ${msgId}`
        ].filter(Boolean).join(" | ");
        
        console.log(`✅ Discord message updated successfully | ${updateInfo}`);
      } catch (error) {
        // Enhanced logging for failed update
        const traderInfo = data.traderName || data.walletAddress;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to update Discord message | Trader: ${traderInfo} | Channel: ${channelId} | Message ID: ${msgId} | Error: ${errorMessage}`, error);
      }
    }

    return successCount > 0;
  }

  /**
   * Reply to an existing Discord message(s) in all channels
   * @param messageId - The ID(s) of the message(s) to reply to (can be single ID or JSON array)
   * @param replyContent - The text content or embed to send as a reply
   * @returns The first reply message ID if successful, null otherwise
   */
  async replyToMessage(
    messageId: string, 
    replyContent: string | EmbedBuilder,
    whaleCategory?: string,
    tradeCategory?: string,
    subscriptionType?: string
  ): Promise<string | null> {
    if (!this.isReady) {
      console.warn("⚠️  Discord bot not ready");
      return null;
    }

    // Parse message IDs (can be single ID or JSON array)
    const messageIds = this.parseMessageIds(messageId);
    
    // Determine which channel(s) to reply in based on routing logic
    // If routing info is provided, use it; otherwise fall back to trying all channels
    let channelIdsToTry: string[];
    if (whaleCategory !== undefined || subscriptionType !== undefined) {
      channelIdsToTry = this.getChannelIds(
        whaleCategory || "regular",
        tradeCategory,
        subscriptionType
      );
    } else {
      // Fallback: try all configured channels if routing info not provided
      channelIdsToTry = [
        this.channels.free, // Include free channel
        this.channels.default,
        this.channels.sport,
        this.channels.crypto,
        this.channels.politics,
        this.channels.whale,
        this.channels.economic,
      ].filter((id): id is string => !!id);
    }

    const replyMessageIds: string[] = [];
    
    // Match message IDs with channels (by index if same count, otherwise try each ID in each channel)
    for (let i = 0; i < Math.max(channelIdsToTry.length, messageIds.length); i++) {
      const channelId = channelIdsToTry[i % channelIdsToTry.length];
      const msgId = messageIds[i % messageIds.length];
      
      if (!msgId || !channelId) continue;
      
      try {
        const channel = await this.client.channels.fetch(channelId);
        
        if (!channel || !(channel instanceof TextChannel)) {
          continue;
        }

        const message = await channel.messages.fetch(msgId);
        
        if (typeof replyContent === 'string') {
          const replyMessage = await message.reply({ content: replyContent });
          replyMessageIds.push(replyMessage.id);
          console.log(`✅ Discord reply sent to channel ${channelId}`);
        } else {
          // Clone embed for each channel (embeds are mutable)
          const channelEmbed = EmbedBuilder.from(replyContent.data);
          const replyMessage = await message.reply({ embeds: [channelEmbed] });
          replyMessageIds.push(replyMessage.id);
          console.log(`✅ Discord reply sent to channel ${channelId}`);
        }
      } catch (error) {
        // Try next channel/message if this one fails
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to reply to Discord message in channel ${channelId} | Message ID: ${msgId} | Error: ${errorMessage}`);
        continue;
      }
    }
    
    if (replyMessageIds.length === 0) {
      console.error("❌ Failed to reply to Discord message: message not found in any configured channel");
      return null;
    }
    
    // Return first reply message ID for backward compatibility
    return replyMessageIds[0] || null;
  }

  /**
   * Send a gainz alert for high-profit closed positions
   * Called when a position is closed with PnL >= threshold
   */
  async sendGainzAlert(data: {
    walletAddress: string;
    traderName?: string;
    profileUrl?: string;
    thumbnailUrl?: string;
    marketLink?: string;
    marketName?: string;
    percentPnl: number;
    realizedPnl?: string;
    usdValue?: string;
    activityTimestamp?: string | Date;
    whaleCategory?: string;
    tradeCategory?: string;
    entryPrice?: string;
    exitPrice?: string;
    outcome?: string;
  }): Promise<string | null> {
    if (!this.isReady) {
      console.warn("⚠️  Discord bot not ready");
      return null;
    }

    if (!this.channels.gainz) {
      // Silently skip if gainz channel not configured
      return null;
    }

    // Only send if PnL meets or exceeds threshold
    if (data.percentPnl < this.gainzThreshold) {
      return null;
    }

    try {
      const channel = await this.client.channels.fetch(this.channels.gainz);
      
      if (!channel || !(channel instanceof TextChannel)) {
        console.error(`❌ Gainz channel ${this.channels.gainz} not found or not a text channel`);
        return null;
      }

      // Build celebratory gainz embed
      const embed = new EmbedBuilder()
        .setColor(0x00ff00) // Bright green for gains
        .setTitle(`🎉 BIG GAINS ALERT! 🎉`);

      // Description with profit % (if enabled) - make it big and attractive
      if (this.gainzAlertConfig.showProfitPercent) {
        const profitPercent = data.percentPnl.toFixed(2);
        const profitSign = data.percentPnl >= 0 ? "+" : "";
        // Use larger, more prominent formatting with emojis
        embed.setDescription(`# 🔥 **${profitSign}${profitPercent}%** 🔥\n\n💰 **HUGE PROFIT!** 💰`);
      }

      // Thumbnail (if enabled)
      if (this.gainzAlertConfig.showThumbnail && data.thumbnailUrl) {
        embed.setThumbnail(data.thumbnailUrl);
      }

      // Market info (if enabled)
      if (this.gainzAlertConfig.showMarket && data.marketLink && data.marketName) {
        embed.addFields({
          name: "📊 Market",
          value: `[${data.marketName}](${data.marketLink})`,
          inline: false,
        });
      }

      // Trader info (if enabled)
      if (this.gainzAlertConfig.showTrader) {
        const traderDisplay = data.profileUrl && data.traderName
          ? `[${data.traderName}](${data.profileUrl})`
          : (data.traderName || data.walletAddress);
        
        embed.addFields({
          name: "👤 Trader",
          value: traderDisplay,
          inline: false,
        });
      }

      // Add PnL details fields (conditional based on config)
      const fields: Array<{ name: string; value: string; inline: boolean }> = [];
      
      // Note: Profit % is shown in description above, so we don't add it as a field
      // If you want it as a field instead, disable description and add it here

      // Realized PnL (if enabled)
      if (this.gainzAlertConfig.showRealizedPnl && data.realizedPnl) {
        const pnlValue = parseFloat(data.realizedPnl).toFixed(2);
        fields.push({
          name: "💵 Realized PnL",
          value: `$${pnlValue}`,
          inline: true,
        });
      }

      // Position Value (if enabled)
      if (this.gainzAlertConfig.showPositionValue && data.usdValue) {
        const usdValue = parseFloat(data.usdValue).toFixed(2);
        fields.push({
          name: "💲 Position Value",
          value: `$${usdValue}`,
          inline: true,
        });
      }

      // When/Closed (if enabled)
      if (this.gainzAlertConfig.showWhen && data.activityTimestamp) {
        const discordTimestamp = this.formatDiscordTimestamp(data.activityTimestamp);
        fields.push({
          name: "⏰ Closed",
          value: discordTimestamp,
          inline: true,
        });
      }

      // Category (if enabled)
      if (this.gainzAlertConfig.showCategory && data.tradeCategory) {
        const categoryDisplay = this.formatCategoryName(data.tradeCategory);
        fields.push({
          name: "🏷️ Category",
          value: categoryDisplay,
          inline: true,
        });
      }

      // Entry Price (if enabled)
      if (this.gainzAlertConfig.showEntryPrice && data.entryPrice) {
        fields.push({
          name: "🏷️ Entry Price",
          value: `$${parseFloat(data.entryPrice).toFixed(2)}`,
          inline: true,
        });
      }

      // Exit Price (if enabled)
      if (this.gainzAlertConfig.showExitPrice && data.exitPrice) {
        fields.push({
          name: "🏷️ Exit Price",
          value: `$${parseFloat(data.exitPrice).toFixed(2)}`,
          inline: true,
        });
      }

      // Outcome (if enabled)
      if (this.gainzAlertConfig.showOutcome && data.outcome) {
        fields.push({
          name: "🎯 Outcome",
          value: data.outcome,
          inline: true,
        });
      }

      // Add fields if any
      if (fields.length > 0) {
        embed.addFields(fields);
      }

      // Footer (if enabled)
      if (this.gainzAlertConfig.showFooter) {
        embed.setFooter({ text: "Polymarket Gains" });
      }

      // Timestamp (if enabled)
      if (this.gainzAlertConfig.showTimestamp) {
        embed.setTimestamp(new Date());
      }

      const sentMessage = await channel.send({ embeds: [embed] });
      console.log(`🎉 Gainz alert sent to channel ${this.channels.gainz} | PnL: ${data.percentPnl.toFixed(2)}%`);
      return sentMessage.id;
    } catch (error) {
      console.error(`❌ Failed to send gainz alert to channel ${this.channels.gainz}:`, error);
      return null;
    }
  }

  disconnect(): void {
    this.client.destroy();
    this.isReady = false;
    console.log("👋 Discord bot disconnected");
  }
}

export const discordService = new DiscordService();

