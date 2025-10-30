import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { TrackedWhale } from "./TrackedWhale.js";

@Entity("whale_activity")
export class WhaleActivity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  whaleId!: string;

  @ManyToOne(() => TrackedWhale, (whale) => whale.activities, {
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

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: "timestamp", nullable: true })
  activityTimestamp?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

