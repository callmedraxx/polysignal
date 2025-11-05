import { Router, type Request, type Response } from "express";
import { AppDataSource } from "../config/database.js";
import { CopyTradeWallet } from "../entities/CopyTradeWallet.js";
import { CopyTradePosition } from "../entities/CopyTradePosition.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";
import { googleSheetsService } from "../services/google-sheets.service.js";

const router = Router();
const copytradeWalletRepository = AppDataSource.getRepository(CopyTradeWallet);
const copytradePositionRepository = AppDataSource.getRepository(CopyTradePosition);
const whaleRepository = AppDataSource.getRepository(TrackedWhale);

/**
 * @swagger
 * /api/copytrade/wallets:
 *   get:
 *     summary: Get all copytrade wallets
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *         description: Filter by active status
 *     responses:
 *       200:
 *         description: List of copytrade wallets
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/CopyTradeWallet'
 */
router.get("/wallets", async (req: Request, res: Response) => {
  try {
    const { isActive } = req.query;
    const where: any = {};
    
    if (isActive !== undefined) {
      where.isActive = isActive === "true";
    }
    
    const wallets = await copytradeWalletRepository.find({
      where: Object.keys(where).length > 0 ? where : undefined,
      order: { createdAt: "DESC" },
    });
    
    res.json(wallets);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch copytrade wallets", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/wallets:
 *   post:
 *     summary: Add a new copytrade wallet
 *     tags: [CopyTrade]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - walletAddress
 *             properties:
 *               walletAddress:
 *                 type: string
 *                 description: Wallet address to track
 *               label:
 *                 type: string
 *                 description: Optional label for the wallet
 *               subscriptionType:
 *                 type: string
 *                 enum: [free, paid]
 *                 default: free
 *                 description: Subscription type
 *               simulatedInvestment:
 *                 type: number
 *                 default: 500
 *                 description: USD amount to simulate per trade
 *               durationHours:
 *                 type: integer
 *                 enum: [12, 24]
 *                 default: 24
 *                 description: Duration to track in hours (12 or 24)
 *               description:
 *                 type: string
 *                 description: Optional description
 *     responses:
 *       201:
 *         description: Copytrade wallet created successfully
 *       400:
 *         description: Invalid input
 *       409:
 *         description: Wallet already exists
 */
router.post("/wallets", async (req: Request, res: Response) => {
  try {
    const { walletAddress, label, subscriptionType = "free", simulatedInvestment = 500, durationHours = 24, description } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: "Wallet address is required" });
    }

    // Validate durationHours
    if (durationHours !== 12 && durationHours !== 24) {
      return res.status(400).json({ error: "durationHours must be 12 or 24" });
    }

    // Validate subscriptionType
    if (subscriptionType !== "free" && subscriptionType !== "paid") {
      return res.status(400).json({ error: "subscriptionType must be 'free' or 'paid'" });
    }

    // Check if wallet already exists
    const existing = await copytradeWalletRepository.findOne({
      where: { walletAddress },
    });

    if (existing) {
      return res.status(409).json({ error: "Wallet already exists in copytrade" });
    }

    const wallet = copytradeWalletRepository.create({
      walletAddress,
      label,
      subscriptionType,
      simulatedInvestment: parseFloat(simulatedInvestment) || 500,
      durationHours: parseInt(durationHours) || 24,
      description,
      isActive: true,
    });

    const saved = await copytradeWalletRepository.save(wallet);
    res.status(201).json(saved);
  } catch (error) {
    res.status(500).json({ error: "Failed to create copytrade wallet", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/wallets/{id}:
 *   get:
 *     summary: Get a specific copytrade wallet by ID
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Copytrade wallet details
 *       404:
 *         description: Wallet not found
 */
router.get("/wallets/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const wallet = await copytradeWalletRepository.findOne({
      where: { id },
      relations: ["positions"],
    });

    if (!wallet) {
      return res.status(404).json({ error: "Copytrade wallet not found" });
    }

    res.json(wallet);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch copytrade wallet", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/wallets/{id}:
 *   put:
 *     summary: Update a copytrade wallet
 *     tags: [CopyTrade]
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
 *               simulatedInvestment:
 *                 type: number
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Wallet updated successfully
 *       404:
 *         description: Wallet not found
 */
router.put("/wallets/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { label, subscriptionType, simulatedInvestment, durationHours, description, isActive } = req.body;

    const wallet = await copytradeWalletRepository.findOne({ where: { id } });

    if (!wallet) {
      return res.status(404).json({ error: "Copytrade wallet not found" });
    }

    if (label !== undefined) wallet.label = label;
    if (subscriptionType !== undefined) {
      if (subscriptionType !== "free" && subscriptionType !== "paid") {
        return res.status(400).json({ error: "subscriptionType must be 'free' or 'paid'" });
      }
      wallet.subscriptionType = subscriptionType;
    }
    if (description !== undefined) wallet.description = description;
    if (simulatedInvestment !== undefined) wallet.simulatedInvestment = parseFloat(simulatedInvestment);
    if (durationHours !== undefined) {
      if (durationHours !== 12 && durationHours !== 24) {
        return res.status(400).json({ error: "durationHours must be 12 or 24" });
      }
      wallet.durationHours = parseInt(durationHours);
    }
    if (isActive !== undefined) wallet.isActive = isActive === true || isActive === "true";

    const updated = await copytradeWalletRepository.save(wallet);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to update copytrade wallet", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/wallets/{id}:
 *   delete:
 *     summary: Delete a copytrade wallet
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Wallet deleted successfully
 *       404:
 *         description: Wallet not found
 */
router.delete("/wallets/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const wallet = await copytradeWalletRepository.findOne({ where: { id } });

    if (!wallet) {
      return res.status(404).json({ error: "Copytrade wallet not found" });
    }

    await copytradeWalletRepository.remove(wallet);
    res.json({ message: "Copytrade wallet deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete copytrade wallet", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/whales/{whaleId}:
 *   post:
 *     summary: Add a tracked whale to copytrade
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: path
 *         name: whaleId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               copytradeInvestment:
 *                 type: number
 *                 default: 500
 *                 description: USD amount to simulate per trade
 *     responses:
 *       200:
 *         description: Whale added to copytrade successfully
 *       404:
 *         description: Whale not found
 */
router.post("/whales/:whaleId", async (req: Request, res: Response) => {
  try {
    const { whaleId } = req.params;
    const { copytradeInvestment = 500 } = req.body;

    const whale = await whaleRepository.findOne({ where: { id: whaleId } });

    if (!whale) {
      return res.status(404).json({ error: "Whale not found" });
    }

    whale.isCopytrade = true;
    whale.copytradeInvestment = parseFloat(copytradeInvestment) || 500;

    const updated = await whaleRepository.save(whale);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to add whale to copytrade", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/whales/{whaleId}:
 *   delete:
 *     summary: Remove a tracked whale from copytrade
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: path
 *         name: whaleId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Whale removed from copytrade successfully
 *       404:
 *         description: Whale not found
 */
router.delete("/whales/:whaleId", async (req: Request, res: Response) => {
  try {
    const { whaleId } = req.params;

    const whale = await whaleRepository.findOne({ where: { id: whaleId } });

    if (!whale) {
      return res.status(404).json({ error: "Whale not found" });
    }

    whale.isCopytrade = false;
    whale.copytradeInvestment = undefined;

    const updated = await whaleRepository.save(whale);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to remove whale from copytrade", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/positions:
 *   get:
 *     summary: Get all copytrade positions
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: query
 *         name: walletId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by copytrade wallet ID
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by status (open, closed, partially_closed)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of results to return
 *     responses:
 *       200:
 *         description: List of copytrade positions
 */
router.get("/positions", async (req: Request, res: Response) => {
  try {
    const { walletId, status, limit = "100" } = req.query;

    const queryBuilder = copytradePositionRepository
      .createQueryBuilder("position")
      .leftJoinAndSelect("position.copyTradeWallet", "wallet")
      .orderBy("position.entryDate", "DESC")
      .take(parseInt(limit as string));

    if (walletId) {
      queryBuilder.andWhere("position.copyTradeWalletId = :walletId", { walletId });
    }

    if (status) {
      queryBuilder.andWhere("position.status = :status", { status });
    }

    const positions = await queryBuilder.getMany();
    res.json(positions);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch copytrade positions", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/positions/{id}:
 *   get:
 *     summary: Get a specific copytrade position by ID
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Position details
 *       404:
 *         description: Position not found
 */
router.get("/positions/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const position = await copytradePositionRepository.findOne({
      where: { id },
      relations: ["copyTradeWallet"],
    });

    if (!position) {
      return res.status(404).json({ error: "Copytrade position not found" });
    }

    res.json(position);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch copytrade position", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/whales:
 *   get:
 *     summary: Get tracked whales that are in copytrade
 *     tags: [CopyTrade]
 *     responses:
 *       200:
 *         description: List of tracked whales in copytrade
 */
router.get("/whales", async (req: Request, res: Response) => {
  try {
    const whales = await whaleRepository.find({
      where: { isCopytrade: true },
      order: { createdAt: "DESC" },
    });
    
    res.json(whales);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch whales in copytrade", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/stats:
 *   get:
 *     summary: Get copytrade statistics
 *     tags: [CopyTrade]
 *     responses:
 *       200:
 *         description: Copytrade statistics
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const totalWallets = await copytradeWalletRepository.count({ where: { isActive: true } });
    const totalWhales = await whaleRepository.count({ where: { isCopytrade: true, isActive: true } });
    
    const totalPositions = await copytradePositionRepository.count();
    const openPositions = await copytradePositionRepository.count({ where: { status: "open" } });
    const closedPositions = await copytradePositionRepository.count({ where: { status: "closed" } });

    const closedPositionsWithPnL = await copytradePositionRepository.find({
      where: { status: "closed" },
      select: ["realizedPnl", "simulatedInvestment"],
    });

    const totalInvested = closedPositionsWithPnL.reduce((sum, p) => sum + parseFloat(p.simulatedInvestment.toString()), 0);
    const totalPnL = closedPositionsWithPnL.reduce((sum, p) => sum + (parseFloat(p.realizedPnl?.toString() || "0")), 0);
    const overallROI = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

    const profitableTrades = closedPositionsWithPnL.filter(p => parseFloat(p.realizedPnl?.toString() || "0") > 0).length;
    const winRate = closedPositions > 0 ? (profitableTrades / closedPositions) * 100 : 0;

    res.json({
      wallets: {
        total: totalWallets,
        active: totalWallets,
      },
      whales: {
        total: totalWhales,
        active: totalWhales,
      },
      positions: {
        total: totalPositions,
        open: openPositions,
        closed: closedPositions,
      },
      performance: {
        totalInvested: totalInvested,
        totalPnL: totalPnL,
        overallROI: overallROI,
        winRate: winRate,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch copytrade statistics", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/spreadsheets:
 *   get:
 *     summary: Get Google Sheets spreadsheet URLs
 *     tags: [CopyTrade]
 *     responses:
 *       200:
 *         description: Spreadsheet URLs
 */
router.get("/spreadsheets", async (req: Request, res: Response) => {
  try {
    const urls = googleSheetsService.getSpreadsheetUrls();
    const ids = googleSheetsService.getSpreadsheetIds();
    
    res.json({
      urls,
      ids,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch spreadsheet info", message: String(error) });
  }
});

export default router;

