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
}

class DiscordService {
  private client: Client;
  private channels: ChannelConfig;
  private isReady: boolean = false;

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
    };
    
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
   * Get channel ID(s) based on whale category and trade category
   */
  private getChannelIds(whaleCategory: string, tradeCategory?: string): string[] {
    const channelIds: string[] = [];
    const whaleCatLower = whaleCategory.toLowerCase();
    
    // If whale is "whale", always use whale channel
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
    
    // If whale is "regular", route based on trade category
    if (whaleCatLower === "regular" && tradeCategory) {
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
  }): Promise<string | null> {
    if (!this.isReady) {
      console.warn("⚠️  Discord bot not ready");
      return null;
    }

    // Get channel IDs based on whale and trade categories
    const whaleCategory = data.whaleCategory || "regular";
    const tradeCategory = data.tradeCategory;
    
    // Debug logging
    console.log(
      `🔍 Discord routing input: whaleCategory="${whaleCategory}", tradeCategory="${tradeCategory || 'undefined'}", type=${typeof tradeCategory}`
    );
    
    // Log channel configuration for debugging
    console.log(
      `📋 Available channels: default=${this.channels.default ? 'YES' : 'NO'}, politics=${this.channels.politics ? 'YES' : 'NO'}, crypto=${this.channels.crypto ? 'YES' : 'NO'}, sport=${(this.channels.sport || this.channels.sports) ? 'YES' : 'NO'}, economic=${this.channels.economic ? 'YES' : 'NO'}`
    );
    
    const channelIds = this.getChannelIds(whaleCategory, tradeCategory);

    if (channelIds.length === 0) {
      console.warn(`⚠️  No channel configured for whale category "${whaleCategory}" and trade category "${tradeCategory || 'N/A'}"`);
      return null;
    }

    console.log(
      `📢 Routing Discord message | Whale: ${data.traderName || data.walletAddress} | Whale Category: ${whaleCategory} | Trade Category: ${tradeCategory || 'N/A'} | Channel(s): ${channelIds.join(', ')}`
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
    const statusUpper = status ? status.toUpperCase().replace('_', ' ') : "";
    
    // If whale category is "whale"
    if (whaleCatLower === "whale") {
      if (status === "closed" || status === "partially_closed") {
        // Show PnL percentage (no USD value for closed/partially closed)
        if (percentPnl !== undefined) {
          const pnlSign = percentPnl >= 0 ? "+" : "";
          return `🐋 Whale Position ${statusUpper} (${pnlSign}${Math.abs(percentPnl).toFixed(2)}%)`;
        }
        return `🐋 Whale Position ${statusUpper}`;
      } else {
        // Show USD value for open and added positions
        const usdDisplay = usdValue ? `$${parseFloat(usdValue).toFixed(2)}` : "";
        return `🐋 Whale Position ${statusUpper}${usdDisplay ? ` (${usdDisplay})` : ""}`;
      }
    } else {
      // Regular category - show trade category
      const categoryDisplay = this.formatCategoryName(tradeCategory) || "Trade";
      
      if (status === "closed" || status === "partially_closed") {
        // Show PnL percentage in brackets with Gained/Loss label
        if (percentPnl !== undefined) {
          const pnlSign = percentPnl >= 0 ? "+" : "";
          const pnlLabel = percentPnl >= 0 ? "Gained" : "Loss";
          return `${categoryDisplay} Position ${statusUpper} (${pnlSign}${Math.abs(percentPnl).toFixed(2)}% ${pnlLabel})`;
        }
        return `${categoryDisplay} Position ${statusUpper}`;
      } else {
        // For open and added positions, show USD value
        const usdDisplay = usdValue ? `$${parseFloat(usdValue).toFixed(2)}` : "";
        return `${categoryDisplay} Position ${statusUpper}${usdDisplay ? ` (${usdDisplay})` : ""}`;
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
  }, whaleCategory: string = "regular"): EmbedBuilder {
    // Determine embed color based on status (not buy/sell)
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
        embedColor = 0xef4444; // Red for closed
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

    // Parse additional info for outcome and price
    const { outcome, price } = this.parseAdditionalInfo(data.additionalInfo);

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

    // 3. When and Type on same horizontal line (with padding for spacing)
    const fields: Array<{ name: string; value: string; inline: boolean }> = [];
    const fieldPadding = "   "; // Extra spacing between inline fields
    
    if (data.activityTimestamp) {
      // Use Discord's auto-updating timestamp format
      // This shows when the TRADE happened (activityTimestamp), NOT when the message was created
      const discordTimestamp = this.formatDiscordTimestamp(data.activityTimestamp);
      fields.push({
        name: "⏰ When",
        value: `${discordTimestamp}${fieldPadding}`,
        inline: true,
      });
    }

    fields.push({
      name: "📊 Type",
      value: `${fieldPadding}${data.activityType}`,
      inline: true,
    });

    // 4. Shares and Value on next line
    if (data.shares || data.usdValue) {
      if (data.shares) {
        const sharesValue = parseFloat(data.shares).toFixed(2);
        let sharesDisplay = sharesValue;
        
        // Add total shares based on status
        if (data.status === "open" || data.status === "added" || data.status === "partially_closed" || data.status === "closed") {
          // Show total shares from position for all statuses
          // For closed positions, totalShares will be 0 to show no remaining shares
          if (data.totalShares !== undefined && data.totalShares > 0) {
            sharesDisplay = `${sharesValue} / ${data.totalShares.toFixed(2)} total`;
          } else if (data.status === "closed" && data.totalShares === 0) {
            // For fully closed positions, show only total shares (don't show / 0 total)
            sharesDisplay = sharesValue;
          }
        }
        
        fields.push({
          name: "📈 Shares",
          value: `${sharesDisplay}${fieldPadding}`,
          inline: true,
        });
      }
      
      if (data.usdValue) {
        const usdValue = parseFloat(data.usdValue).toFixed(2);
        fields.push({
          name: "💰 Value",
          value: `${fieldPadding}$${usdValue}`,
          inline: true,
        });
      }
    }

    // 5. Outcome and Price on next line
    if (outcome || price) {
      if (outcome) {
        fields.push({
          name: "🎯 Outcome",
          value: `${outcome}${fieldPadding}`,
          inline: true,
        });
      }
      
      if (price) {
        fields.push({
          name: "🏷️ Price",
          value: `${fieldPadding}$${price}`,
          inline: true,
        });
      }
    }

    // 6. Status and PnL if available (on same line)
    if (data.status) {
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

    if (data.realizedPnl) {
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
  }): Promise<boolean> {
    if (!this.isReady) {
      console.warn("⚠️  Discord bot not ready");
      return false;
    }

    // Parse message IDs (can be single ID or JSON array)
    const messageIds = this.parseMessageIds(messageId);
    
    // Get channel IDs based on categories (for logging)
    const whaleCategory = data.whaleCategory || "regular";
    const channelIds = this.getChannelIds(whaleCategory, data.tradeCategory);

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
  async replyToMessage(messageId: string, replyContent: string | EmbedBuilder): Promise<string | null> {
    if (!this.isReady) {
      console.warn("⚠️  Discord bot not ready");
      return null;
    }

    // Parse message IDs (can be single ID or JSON array)
    const messageIds = this.parseMessageIds(messageId);
    
    // Reply to messages in all channels
    // Note: For replies, we need to know which channel(s) to reply in
    // This should be passed as a parameter or determined from context
    // For now, try all configured channels
    const allChannelIds = [
      this.channels.default,
      this.channels.sport,
      this.channels.crypto,
      this.channels.politics,
      this.channels.whale,
    ].filter((id): id is string => !!id);

    const replyMessageIds: string[] = [];
    
    // Match message IDs with channels (by index if same count, otherwise try each ID in each channel)
    for (let i = 0; i < Math.max(allChannelIds.length, messageIds.length); i++) {
      const channelId = allChannelIds[i % allChannelIds.length];
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

  disconnect(): void {
    this.client.destroy();
    this.isReady = false;
    console.log("👋 Discord bot disconnected");
  }
}

export const discordService = new DiscordService();

