import { DataSource } from "typeorm";
import dotenv from "dotenv";
import { TrackedWhale } from "../entities/TrackedWhale.js";
import { WhaleActivity } from "../entities/WhaleActivity.js";

dotenv.config();

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DATABASE_HOST || "localhost",
  port: parseInt(process.env.DATABASE_PORT || "5432"),
  username: process.env.DATABASE_USER || "polysignal",
  password: process.env.DATABASE_PASSWORD || "polysignal123",
  database: process.env.DATABASE_NAME || "polysignal_db",
  synchronize: true, // Set to false in production, use migrations instead
  logging: process.env.NODE_ENV === "development",
  entities: [TrackedWhale, WhaleActivity],
  migrations: ["src/migrations/**/*.ts"],
  subscribers: [],
});

