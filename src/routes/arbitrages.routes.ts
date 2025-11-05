import { Router, type Request, type Response } from "express";
import { AppDataSource } from "../config/database.js";
import { ArbitrageOpportunity } from "../entities/ArbitrageOpportunity.js";

const router = Router();
const arbitrageRepository = AppDataSource.getRepository(ArbitrageOpportunity);

/**
 * @swagger
 * components:
 *   schemas:
 *     ArbitrageOpportunity:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique identifier for the arbitrage opportunity
 *         polymarketId:
 *           type: string
 *           description: Polymarket market ID
 *         polymarketQuestion:
 *           type: string
 *           description: Polymarket market question/title
 *         polymarketSlug:
 *           type: string
 *           nullable: true
 *           description: Polymarket market slug
 *         polymarketConditionId:
 *           type: string
 *           nullable: true
 *           description: Polymarket condition ID
 *         polymarketLink:
 *           type: string
 *           nullable: true
 *           description: Link to Polymarket market
 *         polymarketYesPrice:
 *           type: number
 *           format: decimal
 *           description: Yes price on Polymarket (0-1)
 *         polymarketNoPrice:
 *           type: number
 *           format: decimal
 *           description: No price on Polymarket (0-1)
 *         polymarketLiquidity:
 *           type: number
 *           format: decimal
 *           nullable: true
 *           description: Polymarket market liquidity
 *         polymarketEndDate:
 *           type: string
 *           format: date-time
 *           nullable: true
 *           description: Polymarket market end date
 *         kalshiTicker:
 *           type: string
 *           description: Kalshi market ticker
 *         kalshiTitle:
 *           type: string
 *           description: Kalshi market title
 *         kalshiEventTicker:
 *           type: string
 *           nullable: true
 *           description: Kalshi event ticker
 *         kalshiLink:
 *           type: string
 *           nullable: true
 *           description: Link to Kalshi market
 *         kalshiYesBid:
 *           type: integer
 *           description: Yes bid price on Kalshi (in cents)
 *         kalshiYesAsk:
 *           type: integer
 *           description: Yes ask price on Kalshi (in cents)
 *         kalshiNoBid:
 *           type: integer
 *           description: No bid price on Kalshi (in cents)
 *         kalshiNoAsk:
 *           type: integer
 *           description: No ask price on Kalshi (in cents)
 *         kalshiLiquidity:
 *           type: number
 *           format: decimal
 *           nullable: true
 *           description: Kalshi market liquidity
 *         kalshiCloseTime:
 *           type: string
 *           format: date-time
 *           nullable: true
 *           description: Kalshi market close time
 *         yesPolymarketPlusNoKalshi:
 *           type: number
 *           format: decimal
 *           description: Combined cost for yes on Polymarket + no on Kalshi (should be < 100 for arbitrage)
 *         noPolymarketPlusYesKalshi:
 *           type: number
 *           format: decimal
 *           description: Combined cost for no on Polymarket + yes on Kalshi (should be < 100 for arbitrage)
 *         bestArbitrageMargin:
 *           type: number
 *           format: decimal
 *           description: The best arbitrage margin percentage (100 - combined cost)
 *         arbitrageType:
 *           type: string
 *           enum: [yes_poly_no_kalshi, no_poly_yes_kalshi]
 *           description: Type of arbitrage opportunity
 *         similarityScore:
 *           type: number
 *           format: decimal
 *           nullable: true
 *           description: Similarity score between the two markets (0-1)
 *         metadata:
 *           type: object
 *           nullable: true
 *           description: Additional metadata
 *         isVerified:
 *           type: boolean
 *           description: Whether the arbitrage has been manually verified
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: When the arbitrage opportunity was created
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: When the arbitrage opportunity was last updated
 */

/**
 * @swagger
 * /api/arbitrages:
 *   get:
 *     summary: Get all arbitrage opportunities
 *     tags: [Arbitrages]
 *     parameters:
 *       - in: query
 *         name: minMargin
 *         schema:
 *           type: number
 *           format: decimal
 *         description: Minimum arbitrage margin (0-100) to filter results
 *       - in: query
 *         name: maxMargin
 *         schema:
 *           type: number
 *           format: decimal
 *         description: Maximum arbitrage margin (0-100) to filter results
 *       - in: query
 *         name: arbitrageType
 *         schema:
 *           type: string
 *           enum: [yes_poly_no_kalshi, no_poly_yes_kalshi]
 *         description: Filter by arbitrage type
 *       - in: query
 *         name: verified
 *         schema:
 *           type: boolean
 *         description: Filter by verification status
 *       - in: query
 *         name: minSimilarity
 *         schema:
 *           type: number
 *           format: decimal
 *           minimum: 0
 *           maximum: 1
 *         description: Minimum similarity score (0-1)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 1000
 *         description: Maximum number of results to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip for pagination
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [bestArbitrageMargin, createdAt, updatedAt, similarityScore]
 *           default: bestArbitrageMargin
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [ASC, DESC]
 *           default: DESC
 *         description: Sort order
 *     responses:
 *       200:
 *         description: List of arbitrage opportunities
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ArbitrageOpportunity'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const {
      minMargin,
      maxMargin,
      arbitrageType,
      verified,
      minSimilarity,
      limit = "100",
      offset = "0",
      sortBy = "bestArbitrageMargin",
      sortOrder = "DESC",
    } = req.query;

    const queryBuilder = arbitrageRepository.createQueryBuilder("arbitrage");

    // Apply filters
    if (minMargin !== undefined) {
      const minMarginNum = parseFloat(minMargin as string);
      queryBuilder.andWhere("arbitrage.bestArbitrageMargin >= :minMargin", {
        minMargin: minMarginNum,
      });
    }

    if (maxMargin !== undefined) {
      const maxMarginNum = parseFloat(maxMargin as string);
      queryBuilder.andWhere("arbitrage.bestArbitrageMargin <= :maxMargin", {
        maxMargin: maxMarginNum,
      });
    }

    if (arbitrageType) {
      queryBuilder.andWhere("arbitrage.arbitrageType = :arbitrageType", {
        arbitrageType,
      });
    }

    if (verified !== undefined) {
      // Parse verified parameter - can be string, boolean, or array from query params
      const verifiedValue = Array.isArray(verified) ? verified[0] : verified;
      const verifiedStr = String(verifiedValue).toLowerCase();
      const isVerified = verifiedStr === "true" || verifiedStr === "1";
      queryBuilder.andWhere("arbitrage.isVerified = :verified", {
        verified: isVerified,
      });
    }

    if (minSimilarity !== undefined) {
      const minSimilarityNum = parseFloat(minSimilarity as string);
      queryBuilder.andWhere("arbitrage.similarityScore >= :minSimilarity", {
        minSimilarity: minSimilarityNum,
      });
    }

    // Get total count for pagination
    const total = await queryBuilder.getCount();

    // Apply sorting
    const validSortFields = [
      "bestArbitrageMargin",
      "createdAt",
      "updatedAt",
      "similarityScore",
    ];
    const sortField =
      validSortFields.includes(sortBy as string) ? sortBy : "bestArbitrageMargin";
    const sortDirection = sortOrder === "ASC" ? "ASC" : "DESC";

    queryBuilder.orderBy(`arbitrage.${sortField}`, sortDirection);

    // Apply pagination
    const limitNum = Math.min(parseInt(limit as string, 10), 1000);
    const offsetNum = parseInt(offset as string, 10);
    queryBuilder.take(limitNum).skip(offsetNum);

    // Execute query
    const arbitrages = await queryBuilder.getMany();

    res.json({
      data: arbitrages,
      pagination: {
        total,
        limit: limitNum,
        offset: offsetNum,
        hasMore: offsetNum + limitNum < total,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch arbitrage opportunities",
      message: String(error),
    });
  }
});

/**
 * @swagger
 * /api/arbitrages/{id}:
 *   get:
 *     summary: Get a specific arbitrage opportunity by ID
 *     tags: [Arbitrages]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Arbitrage opportunity ID
 *     responses:
 *       200:
 *         description: Arbitrage opportunity details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ArbitrageOpportunity'
 *       404:
 *         description: Arbitrage opportunity not found
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const arbitrage = await arbitrageRepository.findOne({
      where: { id },
    });

    if (!arbitrage) {
      res.status(404).json({ error: "Arbitrage opportunity not found" });
      return;
    }

    res.json(arbitrage);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch arbitrage opportunity",
      message: String(error),
    });
  }
});

/**
 * @swagger
 * /api/arbitrages/{id}/verify:
 *   patch:
 *     summary: Mark an arbitrage opportunity as verified/unverified
 *     tags: [Arbitrages]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Arbitrage opportunity ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isVerified:
 *                 type: boolean
 *                 description: Whether to mark as verified
 *     responses:
 *       200:
 *         description: Arbitrage opportunity updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ArbitrageOpportunity'
 *       404:
 *         description: Arbitrage opportunity not found
 */
router.patch("/:id/verify", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isVerified } = req.body;

    if (typeof isVerified !== "boolean") {
      res.status(400).json({
        error: "isVerified must be a boolean value",
      });
      return;
    }

    const arbitrage = await arbitrageRepository.findOne({
      where: { id },
    });

    if (!arbitrage) {
      res.status(404).json({ error: "Arbitrage opportunity not found" });
      return;
    }

    arbitrage.isVerified = isVerified;
    const updated = await arbitrageRepository.save(arbitrage);

    res.json(updated);
  } catch (error) {
    res.status(500).json({
      error: "Failed to update arbitrage opportunity",
      message: String(error),
    });
  }
});

/**
 * @swagger
 * /api/arbitrages/stats:
 *   get:
 *     summary: Get statistics about arbitrage opportunities
 *     tags: [Arbitrages]
 *     responses:
 *       200:
 *         description: Arbitrage statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                   description: Total number of arbitrage opportunities
 *                 verified:
 *                   type: integer
 *                   description: Number of verified opportunities
 *                 averageMargin:
 *                   type: number
 *                   format: decimal
 *                   description: Average arbitrage margin
 *                 bestMargin:
 *                   type: number
 *                   format: decimal
 *                   description: Best arbitrage margin found
 *                 averageSimilarity:
 *                   type: number
 *                   format: decimal
 *                   description: Average similarity score
 *                 byType:
 *                   type: object
 *                   properties:
 *                     yes_poly_no_kalshi:
 *                       type: integer
 *                     no_poly_yes_kalshi:
 *                       type: integer
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const total = await arbitrageRepository.count();
    const verified = await arbitrageRepository.count({
      where: { isVerified: true },
    });

    // Calculate average margin
    const avgMarginResult = await arbitrageRepository
      .createQueryBuilder("arbitrage")
      .select("AVG(arbitrage.bestArbitrageMargin)", "avgMargin")
      .getRawOne();
    const averageMargin = avgMarginResult?.avgMargin
      ? parseFloat(avgMarginResult.avgMargin)
      : 0;

    // Get best margin
    const bestMarginResult = await arbitrageRepository
      .createQueryBuilder("arbitrage")
      .select("MAX(arbitrage.bestArbitrageMargin)", "bestMargin")
      .getRawOne();
    const bestMargin = bestMarginResult?.bestMargin
      ? parseFloat(bestMarginResult.bestMargin)
      : 0;

    // Calculate average similarity
    const avgSimilarityResult = await arbitrageRepository
      .createQueryBuilder("arbitrage")
      .select("AVG(arbitrage.similarityScore)", "avgSimilarity")
      .where("arbitrage.similarityScore IS NOT NULL")
      .getRawOne();
    const averageSimilarity = avgSimilarityResult?.avgSimilarity
      ? parseFloat(avgSimilarityResult.avgSimilarity)
      : null;

    // Count by type
    const yesPolyNoKalshi = await arbitrageRepository.count({
      where: { arbitrageType: "yes_poly_no_kalshi" },
    });
    const noPolyYesKalshi = await arbitrageRepository.count({
      where: { arbitrageType: "no_poly_yes_kalshi" },
    });

    res.json({
      total,
      verified,
      averageMargin: parseFloat(averageMargin.toFixed(4)),
      bestMargin: parseFloat(bestMargin.toFixed(4)),
      averageSimilarity: averageSimilarity
        ? parseFloat(averageSimilarity.toFixed(4))
        : null,
      byType: {
        yes_poly_no_kalshi: yesPolyNoKalshi,
        no_poly_yes_kalshi: noPolyYesKalshi,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch arbitrage statistics",
      message: String(error),
    });
  }
});

export default router;

