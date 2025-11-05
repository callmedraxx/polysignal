import { Router, type Request, type Response } from "express";
import { AppDataSource } from "../config/database.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";
import { tradePollingService } from "../services/trade-polling.service.js";

const router = Router();
const whaleRepository = AppDataSource.getRepository(TrackedWhale);

/**
 * @swagger
 * /api/whales:
 *   get:
 *     summary: Get all tracked whales
 *     tags: [Whales]
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *         description: Filter by active status
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by whale category/type
 *     responses:
 *       200:
 *         description: List of tracked whales
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TrackedWhale'
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const { isActive, category } = req.query;
    const where: any = {};
    
    if (isActive !== undefined) {
      where.isActive = isActive === "true";
    }
    
    if (category !== undefined) {
      where.category = category;
    }
    
    const whales = await whaleRepository.find({
      where: Object.keys(where).length > 0 ? where : undefined,
      order: { createdAt: "DESC" },
    });
    
    res.json(whales);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch whales", message: String(error) });
  }
});

/**
 * @swagger
 * /api/whales/{id}:
 *   get:
 *     summary: Get a specific whale by ID
 *     tags: [Whales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Whale details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackedWhale'
 *       404:
 *         description: Whale not found
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const whale = await whaleRepository.findOne({
      where: { id: req.params.id },
      relations: ["activities"],
    });
    
    if (!whale) {
      res.status(404).json({ error: "Whale not found" });
      return;
    }
    
    res.json(whale);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch whale", message: String(error) });
  }
});

/**
 * @swagger
 * /api/whales:
 *   post:
 *     summary: Add a new whale wallet address
 *     tags: [Whales]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - walletAddress
 *               - label
 *             properties:
 *               walletAddress:
 *                 type: string
 *                 description: The wallet address to track
 *                 example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
 *               label:
 *                 type: string
 *                 description: Label to identify the whale
 *                 example: "Vitalik"
 *               category:
 *                 type: string
 *                 description: Category/type of whale (e.g., "regular", "whale", "mega_whale")
 *                 default: "regular"
 *                 example: "whale"
 *               subscriptionType:
 *                 type: string
 *                 description: Subscription type (e.g., "free", "paid")
 *                 enum: ["free", "paid"]
 *                 default: "free"
 *                 example: "paid"
 *               minUsdValue:
 *                 type: number
 *                 description: Minimum USD value threshold for storing initial BUY trades
 *                 enum: [500, 1000, 2000, 3000, 4000, 5000]
 *                 default: 500
 *                 example: 1000
 *               frequency:
 *                 type: integer
 *                 nullable: true
 *                 description: Custom frequency limit for initial buy trades per reset period (null = use default: 1 for free, 3 for paid)
 *                 minimum: 0
 *                 example: 5
 *               description:
 *                 type: string
 *                 description: Optional description of the whale
 *               isActive:
 *                 type: boolean
 *                 description: Whether the whale is actively tracked
 *                 default: true
 *     responses:
 *       201:
 *         description: Whale added successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackedWhale'
 *       400:
 *         description: Invalid input or wallet address already exists
 *       500:
 *         description: Server error
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { walletAddress, label, category, subscriptionType, description, isActive, minUsdValue, frequency } = req.body;
    
    if (!walletAddress) {
      res.status(400).json({ error: "walletAddress is required" });
      return;
    }
    
    if (!label) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    
    // Validate minUsdValue if provided
    const ALLOWED_MIN_USD_VALUES = [500, 1000, 2000, 3000, 4000, 5000];
    if (minUsdValue !== undefined) {
      if (!ALLOWED_MIN_USD_VALUES.includes(minUsdValue)) {
        res.status(400).json({ 
          error: `minUsdValue must be one of: ${ALLOWED_MIN_USD_VALUES.join(", ")}` 
        });
        return;
      }
    }
    
    // Validate subscriptionType if provided
    const ALLOWED_SUBSCRIPTION_TYPES = ["free", "paid"];
    if (subscriptionType !== undefined) {
      if (!ALLOWED_SUBSCRIPTION_TYPES.includes(subscriptionType)) {
        res.status(400).json({ 
          error: `subscriptionType must be one of: ${ALLOWED_SUBSCRIPTION_TYPES.join(", ")}` 
        });
        return;
      }
    }
    
    // Validate frequency if provided (must be positive integer or null)
    if (frequency !== undefined && frequency !== null) {
      const freqNum = parseInt(frequency, 10);
      if (isNaN(freqNum) || freqNum < 0) {
        res.status(400).json({ 
          error: "frequency must be a positive integer or null" 
        });
        return;
      }
    }
    
    const whale = whaleRepository.create({
      walletAddress,
      label,
      category: category || "regular", // Default to "regular" if not specified
      subscriptionType: subscriptionType || "free", // Default to "free" if not specified
      description,
      minUsdValue: minUsdValue || 500, // Default to 500 if not specified
      frequency: frequency !== undefined && frequency !== null ? parseInt(frequency, 10) : null,
      isActive: isActive !== undefined ? isActive : true,
    });
    
    const savedWhale = await whaleRepository.save(whale);
    res.status(201).json(savedWhale);
  } catch (error: any) {
    if (error.code === "23505") {
      res.status(400).json({ error: "Wallet address already exists" });
      return;
    }
    res.status(500).json({ error: "Failed to add whale", message: String(error) });
  }
});

/**
 * @swagger
 * /api/whales/{id}:
 *   put:
 *     summary: Update a tracked whale
 *     tags: [Whales]
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
 *               label:
 *                 type: string
 *               description:
 *                 type: string
 *               category:
 *                 type: string
 *                 description: Category/type of whale (e.g., "regular", "whale", "mega_whale")
 *               subscriptionType:
 *                 type: string
 *                 description: Subscription type (e.g., "free", "paid")
 *                 enum: ["free", "paid"]
 *                 example: "paid"
 *               minUsdValue:
 *                 type: number
 *                 description: Minimum USD value threshold for storing initial BUY trades
 *                 enum: [500, 1000, 2000, 3000, 4000, 5000]
 *                 example: 1000
 *               frequency:
 *                 type: integer
 *                 nullable: true
 *                 description: Custom frequency limit for initial buy trades per reset period (null = use default: 1 for free, 3 for paid)
 *                 minimum: 0
 *                 example: 5
 *               isActive:
 *                 type: boolean
 *               metadata:
 *                 type: object
 *     responses:
 *       200:
 *         description: Whale updated successfully
 *       404:
 *         description: Whale not found
 */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const whale = await whaleRepository.findOne({
      where: { id: req.params.id },
    });
    
    if (!whale) {
      res.status(404).json({ error: "Whale not found" });
      return;
    }
    
    const { label, description, category, subscriptionType, isActive, metadata, minUsdValue, frequency } = req.body;
    
    // Validate minUsdValue if provided
    const ALLOWED_MIN_USD_VALUES = [500, 1000, 2000, 3000, 4000, 5000];
    if (minUsdValue !== undefined) {
      if (!ALLOWED_MIN_USD_VALUES.includes(minUsdValue)) {
        res.status(400).json({ 
          error: `minUsdValue must be one of: ${ALLOWED_MIN_USD_VALUES.join(", ")}` 
        });
        return;
      }
      whale.minUsdValue = minUsdValue;
    }
    
    // Validate subscriptionType if provided
    const ALLOWED_SUBSCRIPTION_TYPES = ["free", "paid"];
    if (subscriptionType !== undefined) {
      if (!ALLOWED_SUBSCRIPTION_TYPES.includes(subscriptionType)) {
        res.status(400).json({ 
          error: `subscriptionType must be one of: ${ALLOWED_SUBSCRIPTION_TYPES.join(", ")}` 
        });
        return;
      }
      whale.subscriptionType = subscriptionType;
    }
    
    // Validate frequency if provided (must be positive integer or null)
    if (frequency !== undefined) {
      if (frequency === null) {
        whale.frequency = null;
      } else {
        const freqNum = parseInt(frequency, 10);
        if (isNaN(freqNum) || freqNum < 0) {
          res.status(400).json({ 
            error: "frequency must be a positive integer or null" 
          });
          return;
        }
        whale.frequency = freqNum;
      }
    }
    
    if (label !== undefined) whale.label = label;
    if (description !== undefined) whale.description = description;
    if (category !== undefined) whale.category = category;
    if (isActive !== undefined) whale.isActive = isActive;
    if (metadata !== undefined) whale.metadata = metadata;
    
    const updatedWhale = await whaleRepository.save(whale);
    res.json(updatedWhale);
  } catch (error) {
    res.status(500).json({ error: "Failed to update whale", message: String(error) });
  }
});

/**
 * @swagger
 * /api/whales/{id}:
 *   delete:
 *     summary: Delete a tracked whale
 *     tags: [Whales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Whale deleted successfully
 *       404:
 *         description: Whale not found
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    if (!req.params.id) {
      res.status(400).json({ error: "Whale ID is required" });
      return;
    }
    const result = await whaleRepository.delete(req.params.id);
    
    if (result.affected === 0) {
      res.status(404).json({ error: "Whale not found" });
      return;
    }
    
    res.json({ message: "Whale deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete whale", message: String(error) });
  }
});

/**
 * @swagger
 * /api/whales/frequency/status:
 *   get:
 *     summary: Get frequency status for all active whales
 *     tags: [Whales]
 *     responses:
 *       200:
 *         description: Frequency status for all active whales
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   whaleId:
 *                     type: string
 *                     format: uuid
 *                   remainingFrequency:
 *                     type: integer
 *                     description: Current remaining frequency count
 *                   frequencyLimit:
 *                     type: integer
 *                     description: Maximum frequency limit for this whale
 *                   resetTime:
 *                     type: string
 *                     format: date-time
 *                     description: When the frequency will reset
 *                   isCustom:
 *                     type: boolean
 *                     description: Whether this whale has a custom frequency set
 */
router.get("/frequency/status", async (req: Request, res: Response) => {
  try {
    const statuses = await tradePollingService.getAllWhalesFrequencyStatus();
    res.json(statuses);
  } catch (error) {
    res.status(500).json({ error: "Failed to get frequency status", message: String(error) });
  }
});

/**
 * @swagger
 * /api/whales/{id}/frequency/status:
 *   get:
 *     summary: Get frequency status for a specific whale
 *     tags: [Whales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Frequency status for the whale
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 whaleId:
 *                   type: string
 *                   format: uuid
 *                 remainingFrequency:
 *                   type: integer
 *                   description: Current remaining frequency count
 *                 frequencyLimit:
 *                   type: integer
 *                   description: Maximum frequency limit for this whale
 *                 resetTime:
 *                   type: string
 *                   format: date-time
 *                   description: When the frequency will reset
 *                 isCustom:
 *                   type: boolean
 *                   description: Whether this whale has a custom frequency set
 *       404:
 *         description: Whale not found
 */
router.get("/:id/frequency/status", async (req: Request, res: Response) => {
  try {
    const whaleId = req.params.id;
    
    if (!whaleId) {
      res.status(400).json({ error: "Whale ID is required" });
      return;
    }
    
    const status = await tradePollingService.getWhaleFrequencyStatus(whaleId);
    
    if (!status) {
      res.status(404).json({ error: "Whale not found" });
      return;
    }
    
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: "Failed to get frequency status", message: String(error) });
  }
});

export default router;

