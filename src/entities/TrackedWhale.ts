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

  @Column({ type: "boolean", default: true })
  isActive!: boolean;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany("WhaleActivity", "whale")
  activities!: WhaleActivity[];
}

