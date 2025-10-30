import swaggerJsdoc from "swagger-jsdoc";

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
        url: "http://localhost:3000",
        description: "Development server",
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
  apis: ["./src/routes/*.ts"],
};

export const swaggerSpec = swaggerJsdoc(options);

