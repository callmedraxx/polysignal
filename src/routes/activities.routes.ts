import { Router, type Request, type Response } from "express";
import { AppDataSource } from "../config/database.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";
import { discordService } from "../services/discord.service.js";
import { detectCategoryFromMetadata } from "../utils/category-detector.js";

const router = Router();
const activityRepository = AppDataSource.getRepository(WhaleActivity);
const whaleRepository = AppDataSource.getRepository(TrackedWhale);

/**
 * @swagger
 * /api/activities:
 *   get:
 *     summary: Get all whale activities
 *     tags: [Activities]
 *     parameters:
 *       - in: query
 *         name: whaleId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by whale ID
 *       - in: query
 *         name: activityType
 *         schema:
 *           type: string
 *         description: Filter by activity type
 *       - in: query
 *         name: conditionId
 *         schema:
 *           type: string
 *         description: Filter by conditionId (from metadata)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by status (e.g., open, added, partially_closed, closed)
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by category (e.g., sports, crypto, politics, economic)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of results to return
 *     responses:
 *       200:
 *         description: List of whale activities
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/WhaleActivity'
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const { whaleId, activityType, conditionId, status, category, limit = "100" } = req.query;
    
    const queryBuilder = activityRepository
      .createQueryBuilder("activity")
      .leftJoinAndSelect("activity.whale", "whale")
      .orderBy("activity.activityTimestamp", "DESC")
      .take(parseInt(limit as string));
    
    if (whaleId) {
      queryBuilder.andWhere("activity.whaleId = :whaleId", { whaleId });
    }
    
    if (activityType) {
      queryBuilder.andWhere("activity.activityType = :activityType", { activityType });
    }
    
    if (conditionId) {
      queryBuilder.andWhere("activity.metadata->>'conditionId' = :conditionId", { conditionId });
    }
    
    if (status) {
      queryBuilder.andWhere("activity.status = :status", { status });
    }
    
    if (category) {
      queryBuilder.andWhere("activity.category = :category", { category });
    }
    
    const activities = await queryBuilder.getMany();
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch activities", message: String(error) });
  }
});

/**
 * @swagger
 * /api/activities/{id}:
 *   get:
 *     summary: Get a specific activity by ID
 *     tags: [Activities]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Activity details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WhaleActivity'
 *       404:
 *         description: Activity not found
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const activity = await activityRepository.findOne({
      where: { id: req.params.id },
      relations: ["whale"],
    });
    
    if (!activity) {
      res.status(404).json({ error: "Activity not found" });
      return;
    }
    
    res.json(activity);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch activity", message: String(error) });
  }
});

/**
 * @swagger
 * /api/activities:
 *   post:
 *     summary: Create a new whale activity
 *     tags: [Activities]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - whaleId
 *               - activityType
 *             properties:
 *               whaleId:
 *                 type: string
 *                 format: uuid
 *               activityType:
 *                 type: string
 *               transactionHash:
 *                 type: string
 *               amount:
 *                 type: string
 *               tokenSymbol:
 *                 type: string
 *               fromAddress:
 *                 type: string
 *               toAddress:
 *                 type: string
 *               blockchain:
 *                 type: string
 *               metadata:
 *                 type: object
 *               activityTimestamp:
 *                 type: string
 *                 format: date-time
 *               sendDiscordNotification:
 *                 type: boolean
 *                 description: Whether to send a Discord notification
 *     responses:
 *       201:
 *         description: Activity created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WhaleActivity'
 *       400:
 *         description: Invalid input
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      whaleId,
      activityType,
      transactionHash,
      amount,
      tokenSymbol,
      fromAddress,
      toAddress,
      blockchain,
      metadata,
      activityTimestamp,
      sendDiscordNotification = true,
    } = req.body;
    
    if (!whaleId || !activityType) {
      res.status(400).json({ error: "whaleId and activityType are required" });
      return;
    }
    
    const whale = await whaleRepository.findOne({ where: { id: whaleId } });
    if (!whale) {
      res.status(404).json({ error: "Whale not found" });
      return;
    }
    
    // Check if activity meets storage criteria (USD value >= $500 AND price <= $0.95)
    const usdValue = metadata?.usdValue ? parseFloat(metadata.usdValue) : 0;
    const price = metadata?.price ? parseFloat(metadata.price) : null;
    const MIN_USD_VALUE_FOR_STORAGE = 500;
    const MAX_PRICE_FOR_STORAGE = 0.95;

    if (usdValue < MIN_USD_VALUE_FOR_STORAGE || (price !== null && price > MAX_PRICE_FOR_STORAGE)) {
      const reason = usdValue < MIN_USD_VALUE_FOR_STORAGE 
        ? `USD value $${usdValue.toFixed(2)} < $${MIN_USD_VALUE_FOR_STORAGE}`
        : price !== null 
          ? `price $${price.toFixed(2)} > $${MAX_PRICE_FOR_STORAGE}`
          : `price is null`;
      res.status(400).json({ 
        error: "Activity does not meet storage criteria", 
        reason,
        criteria: {
          minUsdValue: MIN_USD_VALUE_FOR_STORAGE,
          maxPrice: MAX_PRICE_FOR_STORAGE
        }
      });
      return;
    }
    
    // Detect category from metadata using intelligent keyword matching
    const category = detectCategoryFromMetadata(metadata);
    
    if (category) {
      console.log(
        `📁 Category detected for ${whale.label || whale.walletAddress}: "${category}" (market: ${metadata?.market || "N/A"})`
      );
    }
    
    const activity = activityRepository.create({
      whaleId,
      activityType,
      transactionHash,
      amount,
      tokenSymbol,
      fromAddress,
      toAddress,
      blockchain,
      metadata,
      category: category || undefined, // Set the detected category (convert null to undefined)
      activityTimestamp: activityTimestamp ? new Date(activityTimestamp) : new Date(),
    });
    
    const savedActivity = await activityRepository.save(activity);
    
    // Send Discord notification if enabled
    if (sendDiscordNotification) {
      // Check price condition (only send if price <= $0.95)
      const price = metadata?.price ? parseFloat(metadata.price) : null;
      if (price === null || price > 0.95) {
        console.log(
          `⏭️  Skipping Discord notification (price $${price !== null ? price.toFixed(2) : 'N/A'} > $0.95) | Whale: ${whale.label || whale.walletAddress} | Activity: ${savedActivity.id}`
        );
      } else {
        // Construct profile URL
        const profileUrl = `https://polymarket.com/profile/${whale.walletAddress}`;
        
        // Construct market link using slug from metadata
        const marketLink = metadata?.slug
          ? `https://polymarket.com/market/${metadata.slug}`
          : undefined;
        
        const messageId = await discordService.sendWhaleAlert({
          walletAddress: whale.walletAddress,
          traderName: whale.label,
          profileUrl,
          thumbnailUrl: metadata?.icon,
          marketLink,
          marketName: metadata?.market,
          activityType,
          shares: amount,
          usdValue: metadata?.usdValue,
          activityTimestamp: activityTimestamp ? new Date(activityTimestamp) : new Date(),
          transactionHash,
          blockchain,
          whaleCategory: whale.category || "regular", // Pass whale category
          tradeCategory: savedActivity.category || undefined, // Pass trade/market category
        });

        // Store Discord message ID if available
        if (messageId) {
          savedActivity.discordMessageId = messageId;
          await activityRepository.save(savedActivity);
        }
      }
    }
    
    res.status(201).json(savedActivity);
  } catch (error) {
    res.status(500).json({ error: "Failed to create activity", message: String(error) });
  }
});

/**
 * @swagger
 * /api/activities/{id}:
 *   put:
 *     summary: Update a whale activity
 *     tags: [Activities]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               activityType:
 *                 type: string
 *               transactionHash:
 *                 type: string
 *               amount:
 *                 type: string
 *               tokenSymbol:
 *                 type: string
 *               fromAddress:
 *                 type: string
 *               toAddress:
 *                 type: string
 *               blockchain:
 *                 type: string
 *               metadata:
 *                 type: object
 *     responses:
 *       200:
 *         description: Activity updated successfully
 *       404:
 *         description: Activity not found
 */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const activity = await activityRepository.findOne({
      where: { id: req.params.id },
    });
    
    if (!activity) {
      res.status(404).json({ error: "Activity not found" });
      return;
    }
    
    const {
      activityType,
      transactionHash,
      amount,
      tokenSymbol,
      fromAddress,
      toAddress,
      blockchain,
      metadata,
    } = req.body;
    
    if (activityType !== undefined) activity.activityType = activityType;
    if (transactionHash !== undefined) activity.transactionHash = transactionHash;
    if (amount !== undefined) activity.amount = amount;
    if (tokenSymbol !== undefined) activity.tokenSymbol = tokenSymbol;
    if (fromAddress !== undefined) activity.fromAddress = fromAddress;
    if (toAddress !== undefined) activity.toAddress = toAddress;
    if (blockchain !== undefined) activity.blockchain = blockchain;
    if (metadata !== undefined) activity.metadata = metadata;
    
    const updatedActivity = await activityRepository.save(activity);
    res.json(updatedActivity);
  } catch (error) {
    res.status(500).json({ error: "Failed to update activity", message: String(error) });
  }
});

/**
 * @swagger
 * /api/activities/{id}:
 *   delete:
 *     summary: Delete a whale activity
 *     tags: [Activities]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Activity deleted successfully
 *       404:
 *         description: Activity not found
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    if (!req.params.id) {
      res.status(400).json({ error: "Activity ID is required" });
      return;
    }
    const result = await activityRepository.delete(req.params.id);
    
    if (result.affected === 0) {
      res.status(404).json({ error: "Activity not found" });
      return;
    }
    
    res.json({ message: "Activity deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete activity", message: String(error) });
  }
});

export default router;

