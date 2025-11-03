FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install PM2 globally
RUN npm install -g pm2

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy source files for Swagger documentation (JSDoc comments)
COPY --from=builder /app/src ./src

# Copy public directory for admin UI
COPY --from=builder /app/public ./public

# Copy ecosystem config for PM2
COPY ecosystem.config.cjs ./

# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 3000

# Start with PM2
CMD ["pm2-runtime", "start", "ecosystem.config.cjs", "--env", "production"]

