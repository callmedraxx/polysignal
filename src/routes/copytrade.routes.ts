import { Router, type Request, type Response } from "express";
import { AppDataSource } from "../config/database.js";
import { CopyTradeWallet } from "../entities/CopyTradeWallet.js";
import { CopyTradePosition } from "../entities/CopyTradePosition.js";
import { TrackedWhale } from "../entities/TrackedWhale.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";
import { googleSheetsService } from "../services/google-sheets.service.js";
import { IsNull, In } from "typeorm";

const router = Router();
const copytradeWalletRepository = AppDataSource.getRepository(CopyTradeWallet);
const copytradePositionRepository = AppDataSource.getRepository(CopyTradePosition);
const whaleRepository = AppDataSource.getRepository(TrackedWhale);
const activityRepository = AppDataSource.getRepository(WhaleActivity);

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
    const where: any = {
      trackedWhaleId: IsNull(), // Exclude virtual wallets created for tracked whales
    };
    
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

    // Normalize wallet address to lowercase for comparison (Ethereum addresses are case-insensitive)
    const normalizedAddress = walletAddress.toLowerCase().trim();

    // Check if wallet already exists in copytrade wallets (case-insensitive comparison)
    const existingCopytradeWallet = await copytradeWalletRepository
      .createQueryBuilder("wallet")
      .where("LOWER(wallet.walletAddress) = LOWER(:address)", { address: normalizedAddress })
      .getOne();

    if (existingCopytradeWallet) {
      return res.status(409).json({ error: "Wallet address already exists in copytrade wallets" });
    }

    // Check if wallet already exists in tracked whales with isCopytrade = true (case-insensitive comparison)
    const existingWhaleInCopytrade = await whaleRepository
      .createQueryBuilder("whale")
      .where("LOWER(whale.walletAddress) = LOWER(:address)", { address: normalizedAddress })
      .andWhere("whale.isCopytrade = :isCopytrade", { isCopytrade: true })
      .getOne();

    if (existingWhaleInCopytrade) {
      return res.status(409).json({ error: "Wallet address already exists in tracked whales in copytrade" });
    }

    const wallet = copytradeWalletRepository.create({
      walletAddress: normalizedAddress,
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

    // Normalize whale wallet address for case-insensitive comparison
    const normalizedWhaleAddress = whale.walletAddress.toLowerCase().trim();

    // Check if this whale's wallet address already exists in copytrade wallets (case-insensitive comparison)
    // Exclude virtual wallets (those with trackedWhaleId set) - they will be recreated if needed
    const existingCopytradeWallet = await copytradeWalletRepository
      .createQueryBuilder("wallet")
      .where("LOWER(wallet.walletAddress) = LOWER(:address)", { address: normalizedWhaleAddress })
      .andWhere("wallet.trackedWhaleId IS NULL") // Only check copytrade-only wallets, not virtual wallets
      .getOne();

    if (existingCopytradeWallet) {
      return res.status(409).json({ error: "Wallet address already exists in copytrade wallets" });
    }

    // Check if there's an existing virtual wallet for this whale (shouldn't exist if properly removed)
    // If it exists, delete it first so we can recreate it
    const existingVirtualWallet = await copytradeWalletRepository.findOne({
      where: { trackedWhaleId: whaleId },
    });

    if (existingVirtualWallet) {
      await copytradeWalletRepository.remove(existingVirtualWallet);
      console.log(`🗑️  Removed stale virtual wallet before re-adding whale to copytrade: ${whale.label || whale.walletAddress}`);
    }

    // Check if whale is already in copytrade
    if (whale.isCopytrade) {
      return res.status(409).json({ error: "Whale is already in copytrade" });
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

    // Find and delete the virtual CopyTradeWallet for this whale
    const virtualWallet = await copytradeWalletRepository.findOne({
      where: { trackedWhaleId: whaleId },
    });

    if (virtualWallet) {
      await copytradeWalletRepository.remove(virtualWallet);
      console.log(`🗑️  Deleted virtual CopyTradeWallet for whale: ${whale.label || whale.walletAddress}`);
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
    const { walletId, status, limit = "100", offset = "0" } = req.query;

    const queryBuilder = copytradePositionRepository
      .createQueryBuilder("position")
      .leftJoinAndSelect("position.copyTradeWallet", "wallet")
      .orderBy("position.entryDate", "DESC")
      .take(parseInt(limit as string))
      .skip(parseInt(offset as string));

    if (walletId) {
      queryBuilder.andWhere("position.copyTradeWalletId = :walletId", { walletId });
    }

    // By default, only show "open" and "closed" positions (exclude "added" if any exist)
    if (status) {
      queryBuilder.andWhere("position.status = :status", { status });
    } else {
      // Default: only show open and closed positions (not "added" which are tracked separately)
      queryBuilder.andWhere("position.status IN (:...statuses)", { statuses: ["open", "closed"] });
    }

    // Clone query builder for count (without pagination)
    const countBuilder = queryBuilder.clone();
    const total = await countBuilder.getCount();
    
    const positions = await queryBuilder.getMany();
    
    res.json({
      positions,
      pagination: {
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
        hasMore: parseInt(offset as string) + positions.length < total,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch copytrade positions", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/positions/by-trader:
 *   get:
 *     summary: Get positions grouped by trader/wallet
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of positions per trader to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset for pagination
 *     responses:
 *       200:
 *         description: Positions grouped by trader
 */
router.get("/positions/by-trader", async (req: Request, res: Response) => {
  try {
    const { limit = "50", offset = "0" } = req.query;

    // Get all active copytrade-only wallets (exclude virtual wallets for tracked whales)
    const wallets = await copytradeWalletRepository.find({
      where: { 
        isActive: true,
        trackedWhaleId: IsNull(), // Exclude virtual wallets - they're shown via whales below
      },
      relations: ["positions"],
      order: { createdAt: "DESC" },
    });

    // Filter positions to only include "open" and "closed" (exclude "added" if any exist)
    wallets.forEach(wallet => {
      if (wallet.positions) {
        wallet.positions = wallet.positions.filter(p => p.status === "open" || p.status === "closed");
      }
    });

    // Get tracked whales in copytrade
    const whalesInCopytrade = await whaleRepository.find({
      where: { isCopytrade: true, isActive: true },
    });

    // For each whale, get their virtual wallet
    const whaleWallets = await Promise.all(
      whalesInCopytrade.map(async (whale) => {
        const wallet = await copytradeWalletRepository.findOne({
          where: { trackedWhaleId: whale.id },
        });
        if (wallet) {
          // Only get "open" and "closed" positions (exclude "added" if any exist)
          const positions = await copytradePositionRepository.find({
            where: { 
              copyTradeWalletId: wallet.id,
              status: In(["open", "closed"]), // Only show actual positions
            },
            order: { entryDate: "DESC" },
            take: parseInt(limit as string),
            skip: parseInt(offset as string),
          });
          return { wallet, positions };
        }
        return null;
      })
    );

    const traders = wallets.map((wallet) => ({
      walletId: wallet.id,
      walletAddress: wallet.walletAddress,
      label: wallet.label || wallet.walletAddress.slice(0, 8),
      subscriptionType: wallet.subscriptionType,
      isWhale: !!wallet.trackedWhaleId,
      positions: wallet.positions.slice(
        parseInt(offset as string),
        parseInt(offset as string) + parseInt(limit as string)
      ),
    })).filter(t => t.positions.length > 0);

    // Add whale wallets
    whaleWallets.forEach((whaleWallet) => {
      if (whaleWallet && whaleWallet.positions.length > 0) {
        traders.push({
          walletId: whaleWallet.wallet.id,
          walletAddress: whaleWallet.wallet.walletAddress,
          label: whaleWallet.wallet.label || whaleWallet.wallet.walletAddress.slice(0, 8),
          subscriptionType: whaleWallet.wallet.subscriptionType,
          isWhale: true,
          positions: whaleWallet.positions,
        });
      }
    });

    res.json({ traders });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch positions by trader", message: String(error) });
  }
});

/**
 * @swagger
 * /api/copytrade/positions/grouped/{walletId}:
 *   get:
 *     summary: Get positions grouped by position group for a specific trader
 *     tags: [CopyTrade]
 *     parameters:
 *       - in: path
 *         name: walletId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Positions grouped by position group
 */
router.get("/positions/grouped/:walletId", async (req: Request, res: Response) => {
  try {
    const { walletId } = req.params;

    // Only get "open" and "closed" positions (exclude "added" if any exist)
    const positions = await copytradePositionRepository.find({
      where: { 
        copyTradeWalletId: walletId,
        status: In(["open", "closed"]), // Only show actual positions
      },
      relations: ["copyTradeWallet"],
      order: { entryDate: "ASC" },
    });

    // Group positions by conditionId + outcomeIndex + entryDate (position group)
    const groupedPositions = new Map<string, typeof positions>();

    positions.forEach((position) => {
      if (position.conditionId && position.outcomeIndex !== undefined) {
        // Find the original open position for this group
        const openPosition = positions.find(
          (p) =>
            p.conditionId === position.conditionId &&
            p.outcomeIndex === position.outcomeIndex &&
            p.status === "open" &&
            p.entryDate <= position.entryDate
        );

        const groupKey = openPosition
          ? `${position.conditionId}-${position.outcomeIndex}-${openPosition.entryDate.toISOString()}`
          : `${position.conditionId}-${position.outcomeIndex}-${position.entryDate.toISOString()}`;

        if (!groupedPositions.has(groupKey)) {
          groupedPositions.set(groupKey, []);
        }
        groupedPositions.get(groupKey)!.push(position);
      } else {
        // Positions without conditionId/outcomeIndex are standalone
        const standaloneKey = `standalone-${position.id}`;
        groupedPositions.set(standaloneKey, [position]);
      }
    });

    // Convert to array format with hierarchy
    const grouped = Array.from(groupedPositions.entries()).map(([groupKey, groupPositions]) => {
      // Sort positions: open first, then by date
      groupPositions.sort((a, b) => {
        if (a.status === "open" && b.status !== "open") return -1;
        if (a.status !== "open" && b.status === "open") return 1;
        return new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime();
      });

      // Find the first open position (original)
      const openPosition = groupPositions.find((p) => p.status === "open");
      
      // Only include open and closed positions (ignore "added" and "partially_closed")
      const closedPositions = groupPositions.filter((p) => p.status === "closed");
      
      // If no open position but there are closed positions, use the first closed position as the main position
      const mainPosition = openPosition || (closedPositions.length > 0 ? closedPositions[0] : null);

      return {
        groupKey,
        openPosition: openPosition || null,
        mainPosition, // Main position to display (open if exists, otherwise first closed)
        closedPositions,
        allPositions: groupPositions.filter((p) => p.status === "open" || p.status === "closed"),
      };
    });

    res.json({ grouped, wallet: positions[0]?.copyTradeWallet });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch grouped positions", message: String(error) });
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
    // Count only copytrade-only wallets (exclude virtual wallets for tracked whales)
    const totalWallets = await copytradeWalletRepository.count({ 
      where: { 
        isActive: true,
        trackedWhaleId: IsNull(), // Exclude virtual wallets
      },
    });
    const totalWhales = await whaleRepository.count({ where: { isCopytrade: true, isActive: true } });
    
    // Only count "open" and "closed" positions (actual positions)
    // "added" buys don't create separate positions - they're tracked separately
    const openPositions = await copytradePositionRepository.count({ where: { status: "open" } });
    const closedPositions = await copytradePositionRepository.count({ where: { status: "closed" } });
    const totalPositions = openPositions + closedPositions;

    // Count "added" buy trades separately (these are additional buys on existing positions)
    // Get all whales in copytrade
    const whalesInCopytrade = await whaleRepository.find({
      where: { isCopytrade: true, isActive: true },
      select: ["id"],
    });
    
    const whaleIds = whalesInCopytrade.map(w => w.id);
    let addedTradesCount = 0;
    
    if (whaleIds.length > 0) {
      // Count "added" BUY trades for whales in copytrade
      addedTradesCount = await activityRepository.count({
        where: {
          whaleId: In(whaleIds),
          activityType: "POLYMARKET_BUY",
          status: "added",
        },
      });
    }

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
      addedTrades: {
        total: addedTradesCount,
        description: "Additional buys on existing positions (not counted as separate positions)",
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

