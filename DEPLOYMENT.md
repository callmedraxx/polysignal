# Deployment Guide

This guide explains how to run PolySignal in both development and production modes.

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Application
NODE_ENV=development  # or "production"
APP_PORT=3000

# Database
DATABASE_HOST=postgres
DATABASE_PORT=5432
DATABASE_USER=polysignal
DATABASE_PASSWORD=polysignal123
DATABASE_NAME=polysignal_db

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Discord
DISCORD_BOT_TOKEN=your_discord_bot_token_here
DISCORD_CHANNEL_ID=your_channel_id
DISCORD_NOTIFICATION_CHANNEL_ID=your_notification_channel_id
```

## Development Mode

In development mode, the application runs with hot-reload using `tsx watch`.

### Start Development Environment

```bash
npm run docker:dev
```

Or manually:

```bash
docker compose up --build
```

### Stop Development Environment

```bash
npm run docker:down
```

Or manually:

```bash
docker compose down
```

**Features:**
- Hot-reload on code changes
- Source code mounted as volume
- Full development dependencies
- Debug-friendly

## Production Mode

In production mode, the application is compiled and runs with PM2 for process management.

### Start Production Environment

```bash
npm run docker:prod
```

Or manually:

```bash
docker compose -f docker compose.prod.yml up --build -d
```

### Stop Production Environment

```bash
npm run docker:down:prod
```

Or manually:

```bash
docker compose -f docker compose.prod.yml down
```

### View Production Logs

```bash
docker compose -f docker compose.prod.yml logs -f app
```

### Restart Production Application

```bash
docker compose -f docker compose.prod.yml restart app
```

**Features:**
- Optimized multi-stage Docker build
- Production dependencies only
- PM2 process management
- Auto-restart on crashes
- Memory limit protection
- Proper log management
- Runs in background (detached mode)

## Switching Between Environments

To switch between development and production:

1. **Stop current environment:**
   - Development: `npm run docker:down`
   - Production: `npm run docker:down:prod`

2. **Start new environment:**
   - Development: `npm run docker:dev`
   - Production: `npm run docker:prod`

## Architecture

### Development
- Uses `Dockerfile.dev`
- Runs `npm run dev` with `tsx watch`
- Source mounted as volume for live reloading
- All dependencies installed

### Production
- Uses multi-stage `Dockerfile`
- Builds TypeScript to JavaScript
- Installs only production dependencies
- Runs with PM2 (process manager)
- No source mounting
- Optimized image size

## PM2 Configuration

Production uses PM2 for:
- Process management
- Auto-restart on crashes
- Memory limit (1GB) with auto-restart
- Centralized logging
- Cluster mode support (ready to scale)

Configuration is in `ecosystem.config.cjs`.

## Database Migrations

Run migrations in both environments:

```bash
# In development container
docker compose exec app npm run migration:run

# In production container
docker compose -f docker compose.prod.yml exec app npm run migration:run
```

## Monitoring

### Check Application Status

```bash
# Development
docker compose ps

# Production
docker compose -f docker compose.prod.yml ps
```

### View Logs

```bash
# Development
docker compose logs -f app

# Production
docker compose -f docker compose.prod.yml logs -f app
```

### PM2 Status (Production only)

```bash
docker compose -f docker compose.prod.yml exec app pm2 status
```

## Troubleshooting

### Application won't start
- Check `.env` file exists and has all required variables
- Check logs: `docker compose logs app`
- Verify database and Redis are healthy

### Build fails
- Clear Docker cache: `docker system prune -a`
- Rebuild without cache: `docker compose build --no-cache`

### Port already in use
- Change `APP_PORT` in `.env` file
- Or stop the conflicting service

### Database connection errors
- Ensure postgres container is healthy
- Check database credentials in `.env`

## Admin Panel

A simple web-based admin interface is available for managing tracked whales:

**URL:** `http://localhost:${APP_PORT}/admin.html`

**Features:**
- Add new whales with required fields (wallet address, label, category)
- View all tracked whales with status indicators
- Delete whales with confirmation
- Success/error feedback
- Clean, intuitive UI

**Note:** The admin panel is accessible alongside the API documentation and uses the same API endpoints.

## Quick Reference

| Command | Description |
|---------|-------------|
| `npm run docker:dev` | Start development environment |
| `npm run docker:prod` | Start production environment |
| `npm run docker:down` | Stop development environment |
| `npm run docker:down:prod` | Stop production environment |
| `npm run build` | Build TypeScript (local) |
| `npm run start` | Start application (local) |
| `npm run dev` | Start with hot-reload (local) |

