import "reflect-metadata";
import dotenv from "dotenv";
import { AppDataSource } from "../config/database.js";
import { arbitrageDiscoveryService } from "../services/arbitrage-discovery.service.js";

// Load environment variables
dotenv.config();

async function main() {
  try {
    console.log("🔄 Initializing database connection...");
    await AppDataSource.initialize();
    console.log("✅ Database connection established\n");

    console.log("🚀 Starting arbitrage discovery...\n");
    await arbitrageDiscoveryService.discoverArbitrageOpportunities();

    console.log("\n✨ Arbitrage discovery completed successfully!");
  } catch (error) {
    console.error("\n❌ Error running arbitrage discovery:", error);
    process.exit(1);
  } finally {
    await AppDataSource.destroy();
    process.exit(0);
  }
}

main();

