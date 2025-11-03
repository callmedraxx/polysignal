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
import type { TrackedWhale } from "./TrackedWhale.js";

const require = createRequire(import.meta.url);

@Entity("whale_activity")
export class WhaleActivity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  whaleId!: string;

  @ManyToOne("TrackedWhale", "activities", {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "whaleId" })
  whale!: TrackedWhale;

  @Column({ type: "varchar", length: 100 })
  activityType!: string; // e.g., "transfer", "swap", "stake", etc.

  @Column({ type: "varchar", length: 255, nullable: true })
  transactionHash?: string;

  @Column({ type: "decimal", precision: 36, scale: 18, nullable: true })
  amount?: string;

  @Column({ type: "varchar", length: 50, nullable: true })
  tokenSymbol?: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  fromAddress?: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  toAddress?: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  blockchain?: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  category?: string; // Market category from Polymarket

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: "timestamp", nullable: true })
  activityTimestamp?: Date;

  @Column({ type: "varchar", length: 50, nullable: true })
  status?: string; // "open" or "closed"

  @Column({ type: "varchar", length: 255, nullable: true })
  discordMessageId?: string; // Store Discord message ID for updates

  @Column({ type: "decimal", precision: 36, scale: 18, nullable: true })
  realizedPnl?: string; // PnL when position is closed

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  percentPnl?: number; // Percentage PnL when position is closed

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

