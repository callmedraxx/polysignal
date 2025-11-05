import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from "typeorm";
import { createRequire } from "module";
import type { WhaleActivity } from "./WhaleActivity.js";

const require = createRequire(import.meta.url);

@Entity("tracked_whales")
export class TrackedWhale {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 255, unique: true })
  walletAddress!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  label?: string;

  @Column({ type: "text", nullable: true })
  description?: string;

  @Column({ type: "varchar", length: 50, default: "regular" })
  category!: string; // e.g., "regular", "whale", "mega_whale", etc.

  @Column({ type: "varchar", length: 50, default: "free" })
  subscriptionType!: string; // "free" or "paid"

  @Column({ type: "decimal", precision: 10, scale: 2, default: 500 })
  minUsdValue!: number; // Minimum USD value threshold for storing initial BUY trades (fixed values: 500, 1000, 2000, 3000, 4000, 5000)

  @Column({ type: "integer", nullable: true })
  frequency?: number | null; // Custom frequency limit for initial buy trades per reset period (null = use default based on subscriptionType)

  @Column({ type: "boolean", default: true })
  isActive!: boolean;

  @Column({ type: "boolean", default: false })
  isCopytrade!: boolean; // If true, also track for copytrade simulation

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  copytradeInvestment?: number; // USD value to simulate per trade for copytrade (default $500 if isCopytrade is true)

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany("WhaleActivity", "whale")
  activities!: WhaleActivity[];
}

