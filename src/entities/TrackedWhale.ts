import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from "typeorm";
import { WhaleActivity } from "./WhaleActivity.js";

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

  @Column({ type: "boolean", default: true })
  isActive!: boolean;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => WhaleActivity, (activity) => activity.whale)
  activities!: WhaleActivity[];
}

