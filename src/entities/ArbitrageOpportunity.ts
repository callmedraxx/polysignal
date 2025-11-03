import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

@Entity("arbitrage_opportunities")
@Index(["polymarketId", "kalshiTicker"], { unique: true })
export class ArbitrageOpportunity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // Polymarket market info
  @Column({ type: "varchar", length: 255 })
  polymarketId!: string;

  @Column({ type: "varchar", length: 500 })
  polymarketQuestion!: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  polymarketSlug?: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  polymarketConditionId?: string;

  @Column({ type: "varchar", length: 1000, nullable: true })
  polymarketLink?: string;

  @Column({ type: "decimal", precision: 10, scale: 6 })
  polymarketYesPrice!: number;

  @Column({ type: "decimal", precision: 10, scale: 6 })
  polymarketNoPrice!: number;

  @Column({ type: "decimal", precision: 15, scale: 2, nullable: true })
  polymarketLiquidity?: number;

  @Column({ type: "timestamp", nullable: true })
  polymarketEndDate?: Date;

  // Kalshi market info
  @Column({ type: "varchar", length: 255 })
  kalshiTicker!: string;

  @Column({ type: "varchar", length: 500 })
  kalshiTitle!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  kalshiEventTicker?: string;

  @Column({ type: "varchar", length: 1000, nullable: true })
  kalshiLink?: string;

  @Column({ type: "integer" })
  kalshiYesBid!: number; // in cents

  @Column({ type: "integer" })
  kalshiYesAsk!: number; // in cents

  @Column({ type: "integer" })
  kalshiNoBid!: number; // in cents

  @Column({ type: "integer" })
  kalshiNoAsk!: number; // in cents

  @Column({ type: "decimal", precision: 15, scale: 2, nullable: true })
  kalshiLiquidity?: number;

  @Column({ type: "timestamp", nullable: true })
  kalshiCloseTime?: Date;

  // Arbitrage calculations
  @Column({ type: "decimal", precision: 10, scale: 4 })
  yesPolymarketPlusNoKalshi!: number; // Should be < 100 for arbitrage

  @Column({ type: "decimal", precision: 10, scale: 4 })
  noPolymarketPlusYesKalshi!: number; // Should be < 100 for arbitrage

  @Column({ type: "decimal", precision: 10, scale: 4 })
  bestArbitrageMargin!: number; // The better of the two opportunities

  @Column({ type: "varchar", length: 50 })
  arbitrageType!: string; // "yes_poly_no_kalshi" or "no_poly_yes_kalshi"

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  similarityScore?: number; // How similar the markets are (0-1)

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>; // Store additional info like matching keywords, etc.

  @Column({ type: "boolean", default: false })
  isVerified?: boolean; // Manual verification flag

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

