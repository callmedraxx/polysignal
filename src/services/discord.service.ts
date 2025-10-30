import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

class DiscordService {
  private client: Client;
  private channelId: string;
  private isReady: boolean = false;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
    });

    this.channelId = process.env.DISCORD_NOTIFICATION_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID || "";

    this.client.once("ready", () => {
      console.log(`✅ Discord bot logged in as ${this.client.user?.tag}`);
      this.isReady = true;
    });

    this.client.on("error", (error) => {
      console.error("❌ Discord client error:", error);
    });
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

  async sendWhaleAlert(data: {
    walletAddress: string;
    activityType: string;
    amount?: string;
    tokenSymbol?: string;
    transactionHash?: string;
    blockchain?: string;
    additionalInfo?: string;
  }): Promise<void> {
    if (!this.isReady || !this.channelId) {
      console.warn("⚠️  Discord bot not ready or channel ID not configured");
      return;
    }

    try {
      const channel = await this.client.channels.fetch(this.channelId);
      
      if (!channel || !(channel instanceof TextChannel)) {
        console.error("❌ Channel not found or not a text channel");
        return;
      }

      // Determine embed color based on activity type
      let embedColor = "#0099ff"; // Default blue
      if (data.activityType.toUpperCase().includes("BUY")) {
        embedColor = "#22c55e"; // Green for buys
      } else if (data.activityType.toUpperCase().includes("SELL")) {
        embedColor = "#ef4444"; // Red for sells
      }

      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setTitle("🐋 Whale Activity Detected")
        .addFields(
          { name: "Wallet Address", value: data.walletAddress, inline: false },
          { name: "Activity Type", value: data.activityType, inline: true },
          { name: "Blockchain", value: data.blockchain || "Unknown", inline: true }
        )
        .setTimestamp();

      if (data.amount && data.tokenSymbol) {
        embed.addFields({
          name: "Amount",
          value: `${data.amount} ${data.tokenSymbol}`,
          inline: true,
        });
      }

      if (data.transactionHash) {
        embed.addFields({
          name: "Transaction",
          value: `\`${data.transactionHash}\``,
          inline: false,
        });
      }

      if (data.additionalInfo) {
        embed.addFields({
          name: "Details",
          value: data.additionalInfo,
          inline: false,
        });
      }

      await channel.send({ embeds: [embed] });
      console.log("✅ Discord notification sent successfully");
    } catch (error) {
      console.error("❌ Failed to send Discord message:", error);
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.isReady || !this.channelId) {
      console.warn("⚠️  Discord bot not ready or channel ID not configured");
      return;
    }

    try {
      const channel = await this.client.channels.fetch(this.channelId);
      
      if (!channel || !(channel instanceof TextChannel)) {
        console.error("❌ Channel not found or not a text channel");
        return;
      }

      await channel.send(message);
      console.log("✅ Discord message sent successfully");
    } catch (error) {
      console.error("❌ Failed to send Discord message:", error);
    }
  }

  disconnect(): void {
    this.client.destroy();
    this.isReady = false;
    console.log("👋 Discord bot disconnected");
  }
}

export const discordService = new DiscordService();

