import "reflect-metadata";
import dotenv from "dotenv";
import { AppDataSource } from "../config/database.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";
import { detectCategoryFromMetadata } from "../utils/category-detector.js";
import { inferCategoryFromTags } from "../utils/category-from-tags.js";
import { polymarketService } from "../services/polymarket.service.js";

// Load environment variables
dotenv.config();

interface UpdateOptions {
  // Filter options
  whaleId?: string;
  activityType?: string;
  missingOnly?: boolean; // Only update activities with null/empty category
  dryRun?: boolean; // Preview changes without actually updating
  batchSize?: number; // Process in batches for better performance
}

async function updateActivityCategories(options: UpdateOptions = {}) {
  try {
    console.log("🔄 Initializing database connection...");
    await AppDataSource.initialize();
    console.log("✅ Database connection established\n");

    const activityRepository = AppDataSource.getRepository(WhaleActivity);
    const {
      whaleId,
      activityType,
      missingOnly = true,
      dryRun = false,
      batchSize = 10,
    } = options;

    // Build query to find activities
    let queryBuilder = activityRepository
      .createQueryBuilder("activity")
      .where("activity.activityType LIKE :pattern", { pattern: "POLYMARKET_%" });

    // Filter by whale if specified
    if (whaleId) {
      queryBuilder = queryBuilder.andWhere("activity.whaleId = :whaleId", { whaleId });
    }

    // Filter by activity type if specified
    if (activityType) {
      queryBuilder = queryBuilder.andWhere("activity.activityType = :activityType", {
        activityType: activityType.startsWith("POLYMARKET_")
          ? activityType
          : `POLYMARKET_${activityType}`,
      });
    }

    // Filter for missing categories or "other" category
    if (missingOnly) {
      queryBuilder = queryBuilder.andWhere(
        "(activity.category IS NULL OR activity.category = '' OR activity.category = 'other')"
      );
    }

    // Load activities with metadata
    const activities = await queryBuilder.getMany();

    if (activities.length === 0) {
      console.log("✓ No activities found matching the criteria");
      return;
    }

    console.log(`📊 Found ${activities.length} activity/activities to process\n`);

    if (dryRun) {
      console.log("🔍 DRY RUN MODE - No changes will be made\n");
    }

    let updated = 0;
    let failed = 0;
    let skipped = 0;
    let noSlug = 0;
    let apiFailed = 0;

    // Process in batches to avoid rate limiting
    for (let i = 0; i < activities.length; i += batchSize) {
      const batch = activities.slice(i, i + batchSize);
      console.log(
        `📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(activities.length / batchSize)} (${batch.length} activities)...`
      );

      for (const activity of batch) {
        const metadata = activity.metadata || {};
        const marketTitle = metadata.market || metadata.title;
        const slug = metadata.slug; // Use slug, not eventSlug

        // Skip if no slug available (need slug for API call)
        if (!slug) {
          console.log(
            `  ⏭️  Skipping activity ${activity.id}: No slug in metadata (market: ${marketTitle || "N/A"})`
          );
          noSlug++;
          continue;
        }

        // Skip if category already exists and we're in missingOnly mode (but allow "other" to be updated)
        if (missingOnly && activity.category && activity.category !== "other") {
          console.log(
            `  ⏭️  Skipping activity ${activity.id}: Already has category "${activity.category}"`
          );
          skipped++;
          continue;
        }

        try {
          // Fetch market by slug with tags using Polymarket API
          let category: string | null = null;
          
          try {
            const marketData = await polymarketService.getMarketBySlug(slug, true);
            
            if (marketData?.tags && marketData.tags.length > 0) {
              category = inferCategoryFromTags(marketData.tags);
              console.log(
                `  📁 Activity ${activity.id}: Category inferred from tags "${category}" (tags: ${marketData.tags.map(t => t.slug).join(", ")})`
              );
            } else {
              // Fallback to keyword-based detection if no tags found
              console.log(
                `  ⚠️  Activity ${activity.id}: No tags found, falling back to keyword detection (slug: ${slug})`
              );
              category = detectCategoryFromMetadata(metadata);
            }
          } catch (apiError) {
            // API call failed, fall back to keyword detection
            console.warn(
              `  ⚠️  Activity ${activity.id}: API call failed for slug "${slug}", falling back to keyword detection:`,
              apiError instanceof Error ? apiError.message : apiError
            );
            apiFailed++;
            category = detectCategoryFromMetadata(metadata);
          }

          if (!category) {
            console.log(
              `  ⚠️  Activity ${activity.id}: Could not detect category (market: ${marketTitle || "N/A"}, slug: ${slug})`
            );
            failed++;
            continue;
          }

          // Skip if category is the same (when not in missingOnly mode, but always update "other")
          if (!missingOnly && activity.category === category && activity.category !== "other") {
            console.log(
              `  ⏭️  Skipping activity ${activity.id}: Already has correct category "${category}"`
            );
            skipped++;
            continue;
          }
          
          // Always update if current category is "other" and we got a different category
          if (activity.category === "other" && category !== "other") {
            console.log(
              `  🔄 Activity ${activity.id}: Updating from "other" to "${category}"`
            );
          }

          if (dryRun) {
            console.log(
              `  🔍 Would update activity ${activity.id}: "${activity.category || "NULL"}" -> "${category}" (market: ${metadata.market || "N/A"})`
            );
          } else {
            // Update the activity
            activity.category = category;
            await activityRepository.save(activity);
            console.log(
              `  ✅ Updated activity ${activity.id}: "${category}" (market: ${metadata.market || "N/A"})`
            );
          }
          updated++;

          // Small delay to avoid rate limiting (150ms between requests)
          await new Promise(resolve => setTimeout(resolve, 150));
        } catch (error) {
          console.error(
            `  ❌ Error updating activity ${activity.id}:`,
            error instanceof Error ? error.message : error
          );
          failed++;
        }
      }

      // Delay between batches to avoid overwhelming the API
      if (i + batchSize < activities.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log("\n📈 Summary:");
    console.log(`  ✓ Updated: ${updated}`);
    console.log(`  ⚠️  Failed: ${failed}`);
    console.log(`  ⏭️  Skipped: ${skipped}`);
    console.log(`  📭 No slug: ${noSlug}`);
    console.log(`  🌐 API failures (fallback used): ${apiFailed}`);
    console.log(`  📊 Total processed: ${activities.length}`);

    if (dryRun) {
      console.log("\n💡 Run without --dry-run to apply changes");
    }
  } catch (error) {
    console.error("\n❌ Error updating activity categories:", error);
    process.exit(1);
  } finally {
    await AppDataSource.destroy();
    process.exit(0);
  }
}

// Parse command line arguments
function parseArgs(): UpdateOptions {
  const args = process.argv.slice(2);
  const options: UpdateOptions = {
    missingOnly: true,
    dryRun: false,
    batchSize: 10,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--whale-id":
        if (nextArg) {
          options.whaleId = nextArg;
          i++;
        }
        break;
      case "--activity-type":
        if (nextArg) {
          options.activityType = nextArg;
          i++;
        }
        break;
      case "--all":
        options.missingOnly = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--batch-size":
        if (nextArg) {
          options.batchSize = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--help":
        console.log(`
Usage: tsx src/scripts/update-activity-categories.ts [options]

Options:
  --whale-id <id>        Filter by whale ID (UUID)
  --activity-type <type> Filter by activity type (e.g., "BUY", "SELL", or "POLYMARKET_BUY")
  --all                  Update all activities, not just those missing categories or with "other"
  --dry-run              Preview changes without updating the database
  --batch-size <n>       Number of activities to process per batch (default: 10)
  --help                  Show this help message

Examples:
  # Update categories for all activities missing categories or with "other" (dry run)
  tsx src/scripts/update-activity-categories.ts --dry-run

  # Update categories for all activities missing categories or with "other"
  tsx src/scripts/update-activity-categories.ts

  # Update categories for a specific whale
  tsx src/scripts/update-activity-categories.ts --whale-id <uuid>

  # Update all activities (including those with existing categories)
  tsx src/scripts/update-activity-categories.ts --all

  # Update with custom batch size
  tsx src/scripts/update-activity-categories.ts --batch-size 50
        `);
        process.exit(0);
    }
  }

  return options;
}

// Main execution
const options = parseArgs();
updateActivityCategories(options);


