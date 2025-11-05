import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { createRequire } from "module";
import type { CopyTradeWallet } from "./CopyTradeWallet.js";

const require = createRequire(import.meta.url);

@Entity("copy_trade_positions")
export class CopyTradePosition {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  copyTradeWalletId!: string;

  @ManyToOne("CopyTradeWallet", "positions", {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "copyTradeWalletId" })
  copyTradeWallet!: CopyTradeWallet;

  @Column({ type: "uuid", nullable: true })
  whaleActivityId?: string; // Link to the original WhaleActivity that triggered this position

  @Column({ type: "varchar", length: 255, nullable: true })
  conditionId?: string; // Market condition ID

  @Column({ type: "varchar", length: 255, nullable: true })
  asset?: string; // Asset ID

  @Column({ type: "varchar", length: 255, nullable: true })
  marketName?: string; // Market name for display

  @Column({ type: "varchar", length: 255, nullable: true })
  marketSlug?: string; // Market slug for link

  @Column({ type: "varchar", length: 255, nullable: true })
  outcome?: string; // Outcome chosen

  @Column({ type: "integer", nullable: true })
  outcomeIndex?: number; // Outcome index

  @Column({ type: "varchar", length: 255, nullable: true })
  realizedOutcome?: string; // Actual winning outcome (based on PNL)

  @Column({ type: "decimal", precision: 10, scale: 2 })
  simulatedInvestment!: number; // USD invested (e.g., $500)

  @Column({ type: "decimal", precision: 36, scale: 18 })
  sharesBought!: string; // Shares bought = simulatedInvestment / entryPrice

  @Column({ type: "decimal", precision: 36, scale: 18 })
  entryPrice!: string; // Entry price from BUY trade

  @Column({ type: "timestamp" })
  entryDate!: Date; // When position was opened

  @Column({ type: "varchar", length: 255, nullable: true })
  entryTransactionHash?: string; // Transaction hash of entry

  @Column({ type: "decimal", precision: 36, scale: 18, nullable: true })
  exitPrice?: string; // Exit price when position closed

  @Column({ type: "timestamp", nullable: true })
  exitDate?: Date; // When position was closed

  @Column({ type: "varchar", length: 255, nullable: true })
  exitTransactionHash?: string; // Transaction hash of exit

  @Column({ type: "decimal", precision: 36, scale: 18, nullable: true })
  sharesSold?: string; // Shares sold (usually same as sharesBought for fully closed)

  @Column({ type: "decimal", precision: 36, scale: 18, nullable: true })
  realizedPnl?: string; // Realized PnL in USD

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  percentPnl?: number; // Percentage PnL

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  finalValue?: number; // Final value = simulatedInvestment + realizedPnl

  @Column({ type: "varchar", length: 50, default: "open" })
  status!: string; // "open", "closed", "partially_closed"

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>; // Additional metadata

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

