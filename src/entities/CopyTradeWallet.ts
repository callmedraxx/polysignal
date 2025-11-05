import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from "typeorm";
import { createRequire } from "module";
import type { CopyTradePosition } from "./CopyTradePosition.js";

const require = createRequire(import.meta.url);

@Entity("copy_trade_wallets")
export class CopyTradeWallet {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 255, unique: true })
  walletAddress!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  label?: string;

  @Column({ type: "varchar", length: 50, default: "free" })
  subscriptionType!: string; // "free" or "paid"

  @Column({ type: "decimal", precision: 10, scale: 2, default: 500 })
  simulatedInvestment!: number; // USD value to simulate per trade (default $500)

  @Column({ type: "integer", default: 24 })
  durationHours!: number; // Duration to track: 12 or 24 hours (default 24)

  @Column({ type: "decimal", precision: 5, scale: 2, default: 100 })
  partialClosePercentage!: number; // Percentage of partial closes to copy (default 100% = copy 100% of the sell)

  @Column({ type: "text", nullable: true })
  description?: string;

  @Column({ type: "boolean", default: true })
  isActive!: boolean;

  @Column({ type: "uuid", nullable: true })
  trackedWhaleId?: string; // If this is also a tracked whale, link to it

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany("CopyTradePosition", "copyTradeWallet")
  positions!: CopyTradePosition[];
}

