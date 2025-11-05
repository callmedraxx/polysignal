import swaggerJsdoc from "swagger-jsdoc";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine the correct path based on environment
// Since JSDoc comments are in source TypeScript files, we need source files
// In production (running from dist/), we need to look up to src/
// In development (running from src/), we look relative to src/
const isProduction = process.env.NODE_ENV === "production";
const routesPath = isProduction
  ? path.join(process.cwd(), "src/routes/*.ts") // In production from dist/, go to project root then src/
  : path.join(__dirname, "../routes/*.ts"); // In development, look relative to src

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "PolySignal API",
      version: "1.0.0",
      description: "Whale activity tracking system API documentation",
      contact: {
        name: "API Support",
      },
    },
    servers: [
      {
        url: process.env.APP_URL || `http://localhost:${process.env.APP_PORT || 3000}`,
        description: process.env.NODE_ENV === "production" ? "Production server" : "Development server",
      },
    ],
    components: {
      schemas: {
        TrackedWhale: {
          type: "object",
          required: ["walletAddress"],
          properties: {
            id: {
              type: "string",
              format: "uuid",
              description: "Unique identifier",
            },
            walletAddress: {
              type: "string",
              description: "Wallet address of the whale",
            },
            label: {
              type: "string",
              description: "Optional label for the whale",
            },
            description: {
              type: "string",
              description: "Optional description",
            },
            isActive: {
              type: "boolean",
              description: "Whether tracking is active",
            },
            category: {
              type: "string",
              description: "Category/type of whale (e.g., 'regular', 'whale', 'mega_whale')",
            },
            subscriptionType: {
              type: "string",
              description: "Subscription type (e.g., 'free', 'paid')",
              enum: ["free", "paid"],
              default: "free",
            },
            minUsdValue: {
              type: "number",
              description: "Minimum USD value threshold for storing initial BUY trades",
              enum: [500, 1000, 2000, 3000, 4000, 5000],
              default: 500,
            },
            metadata: {
              type: "object",
              description: "Additional metadata",
            },
            createdAt: {
              type: "string",
              format: "date-time",
            },
            updatedAt: {
              type: "string",
              format: "date-time",
            },
          },
        },
        WhaleActivity: {
          type: "object",
          required: ["whaleId", "activityType"],
          properties: {
            id: {
              type: "string",
              format: "uuid",
            },
            whaleId: {
              type: "string",
              format: "uuid",
              description: "Reference to tracked whale",
            },
            activityType: {
              type: "string",
              description: "Type of activity (transfer, swap, stake, etc.)",
            },
            transactionHash: {
              type: "string",
              description: "Transaction hash",
            },
            amount: {
              type: "string",
              description: "Transaction amount",
            },
            tokenSymbol: {
              type: "string",
              description: "Token symbol",
            },
            fromAddress: {
              type: "string",
              description: "Source address",
            },
            toAddress: {
              type: "string",
              description: "Destination address",
            },
            blockchain: {
              type: "string",
              description: "Blockchain network",
            },
            metadata: {
              type: "object",
              description: "Additional metadata",
            },
            activityTimestamp: {
              type: "string",
              format: "date-time",
            },
            createdAt: {
              type: "string",
              format: "date-time",
            },
            updatedAt: {
              type: "string",
              format: "date-time",
            },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: {
              type: "string",
            },
            message: {
              type: "string",
            },
          },
        },
      },
    },
  },
  apis: [routesPath],
};

export const swaggerSpec = swaggerJsdoc(options);

