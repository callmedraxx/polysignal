import { Router, Request, Response } from "express";
import { AppDataSource } from "../config/database.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";

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
    const { isActive } = req.query;
    const where = isActive !== undefined ? { isActive: isActive === "true" } : {};
    
    const whales = await whaleRepository.find({
      where,
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
    const { walletAddress, label } = req.body;
    
    if (!walletAddress) {
      res.status(400).json({ error: "walletAddress is required" });
      return;
    }
    
    if (!label) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    
    const whale = whaleRepository.create({
      walletAddress,
      label,
      isActive: true,
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
    
    const { label, description, isActive, metadata } = req.body;
    
    if (label !== undefined) whale.label = label;
    if (description !== undefined) whale.description = description;
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

export default router;

