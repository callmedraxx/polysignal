import "reflect-metadata";
import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import { AppDataSource } from "./config/database.js";
import { redisClient } from "./config/redis.js";
import { discordService } from "./services/discord.service.js";
import { swaggerSpec } from "./config/swagger.js";
import whalesRouter from "./routes/whales.routes.js";
import activitiesRouter from "./routes/activities.routes.js";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.APP_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    services: {
      database: AppDataSource.isInitialized,
      redis: redisClient.status === "ready",
    },
  });
});

// Swagger documentation
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// API routes
app.use("/api/whales", whalesRouter);
app.use("/api/activities", activitiesRouter);

// Root endpoint
app.get("/", (req: Request, res: Response) => {
  res.json({
    message: "PolySignal API v1.0.0",
    documentation: "/api-docs",
    endpoints: {
      whales: "/api/whales",
      activities: "/api/activities",
      health: "/health",
    },
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Initialize database and start server
const startServer = async () => {
  try {
    // Initialize database connection
    console.log("🔄 Initializing database connection...");
    await AppDataSource.initialize();
    console.log("✅ Database connection established");

    // Connect Discord bot
    console.log("🔄 Connecting Discord bot...");
    await discordService.connect();

    // Start Express server
    app.listen(PORT, () => {
      console.log(`\n🚀 Server is running on port ${PORT}`);
      console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
      console.log(`\n✨ Ready to track whale activities!\n`);
    });
  } catch (error) {
    console.error("❌ Error starting server:", error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  console.log("\n👋 Shutting down gracefully...");
  
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  
  redisClient.disconnect();
  discordService.disconnect();
  
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("\n👋 Shutting down gracefully...");
  
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  
  redisClient.disconnect();
  discordService.disconnect();
  
  process.exit(0);
});

// Start the server
startServer();

