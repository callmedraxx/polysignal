import "reflect-metadata";
import dotenv from "dotenv";
import { AppDataSource } from "../config/database.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";

// Load environment variables
dotenv.config();

async function main() {
  try {
    console.log("🔄 Initializing database connection...");
    await AppDataSource.initialize();
    console.log("✅ Database connection established\n");

    const whaleRepository = AppDataSource.getRepository(TrackedWhale);

    // Use raw SQL for efficient bulk update of NULL or empty category values
    const result = await whaleRepository
      .createQueryBuilder()
      .update(TrackedWhale)
      .set({ category: "regular" })
      .where("category IS NULL OR category = ''")
      .execute();

    const updatedCount = result.affected || 0;

    if (updatedCount === 0) {
      console.log("✓ No whales need category migration (all already have categories)");
    } else {
      console.log(`✅ Successfully updated ${updatedCount} whale(s) with category "regular"`);
    }
  } catch (error) {
    console.error("\n❌ Error migrating whale categories:", error);
    process.exit(1);
  } finally {
    await AppDataSource.destroy();
    process.exit(0);
  }
}

main();

