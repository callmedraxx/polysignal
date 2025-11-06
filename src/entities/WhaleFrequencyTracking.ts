import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { createRequire } from "module";
import type { TrackedWhale } from "./TrackedWhale.js";

const require = createRequire(import.meta.url);

@Entity("whale_frequency_tracking")
export class WhaleFrequencyTracking {
  @PrimaryColumn({ type: "uuid" })
  whaleId!: string;

  @ManyToOne("TrackedWhale", {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "whaleId" })
  whale!: TrackedWhale;

  @Column({ type: "integer", default: 0 })
  remainingFrequency!: number; // Remaining frequency count for this reset period

  @Column({ type: "timestamp" })
  resetTime!: Date; // When the frequency should reset

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

