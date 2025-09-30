# Void Bot

<div align="center" style="position: relative;">

![Banner](src/graphics/bg.jpg)

<img src="src/graphics/void.png" 
     alt="Void Bot Avatar" 
     width="150" 
     style="border-radius: 50%; 
            border: 5px solid #1a1a1a; 
            position: absolute; 
            top: 60px; 
            left: 50%; 
            transform: translateX(-50%);" />

**Version:** 1.0.0-beta  
**License:** Apache-2.0  
**Author:** Zenzxnse

*Enterprise-grade Discord moderation bot with automatic sharding and comprehensive moderation tools*

[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue.svg)](https://discord.js.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D.svg)](https://redis.io/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[Features](#features) • [Installation](#installation) • [Configuration](#configuration) • [Commands](COMMANDS.md) • [Contributing](#contributing)

</div>

---

## Overview

Void Bot is a feature-rich Discord moderation bot built with Discord.js v14, featuring automatic sharding, persistent components, comprehensive moderation tools, and enterprise-grade architecture. Designed for servers of all sizes, it provides transaction-based operations, job scheduling, and distributed state management.

**Current Status:** Beta (v1.0.0-beta)

> **Note:** AI moderation and utilities will be added in future releases.

---

## Table of Contents

- [Features](#features)
- [Quality of Life Commands](#quality-of-life-commands)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Docker Setup](#docker-setup)
- [Development](#development)
- [Health & Monitoring](#health--monitoring)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Production Deployment](#production-deployment)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### Core Architecture

#### 🚀 Sharding & Scalability
- **Automatic Sharding** with dynamic shard count calculation
- **Per-Shard Health Monitoring** with WebSocket ping tracking
- **IPC Communication** between manager and shards
- **Graceful Restarts** with exponential backoff retry logic
- **Process Isolation** - Each shard runs in its own process
- **Shard Routing** for cross-shard operations

#### 💾 Database & State Management
- **PostgreSQL 16** with full ACID compliance
- **Connection Pooling** (configurable max connections)
- **Atomic Transactions** for critical operations (warns, bans, config)
- **Automatic Migrations** on startup
- **Redis 7 Caching** for distributed state
- **Limp Mode** - Graceful degradation when Redis unavailable
- **Query Parameterization** for SQL injection prevention

#### 🎨 Component System
- **HMAC-Signed Custom IDs** with expiry validation
- **Persistent Components** - Buttons/selects survive restarts
- **Anti-Replay Protection** prevents duplicate submissions
- **Database-Backed State** for component data
- **Middleware Integration** - Permissions, cooldowns built-in
- **Type Support** - Buttons, select menus (all types), modals
- **Context Validation** ensures components used correctly

#### ⏰ Job Scheduling System
- **Delayed Action Execution** (unbans, unlocks, timeout renewals)
- **Priority Queuing** (unbans > timeouts > unlocks)
- **Automatic Retry** with exponential backoff
- **Batch Processing** for efficiency (configurable batch size)
- **Job Cleanup** - Auto-removal of completed/failed jobs
- **Idempotency Keys** prevent duplicate execution
- **Job Cancellation** when actions manually reversed

#### 📊 Monitoring & Health
- **Prometheus Metrics** export on `/metrics`
- **Health Endpoints** - liveness, readiness, deep health checks
- **JSON Stats API** at `/metrics.json`
- **Per-Shard Metrics** - guilds, ping, ready status
- **Command Statistics** - execution count, errors
- **IPC Latency Tracking**
- **Maintenance Mode** toggle

---

### Moderation Features

#### ⚖️ Infraction System
- **Warning System** with UUID case tracking
- **Threshold Auto-Actions** - Escalate at configurable warn counts
- **Temporary Punishments** - All actions support duration
- **Warn Decay** - Configurable expiry (e.g., 30 days)
- **Case Management** - Full audit trail with search
- **Hierarchy Validation** - Cannot moderate higher ranks
- **DM Notifications** - User notification with failure tracking
- **Revocation Support** - Remove infractions with audit

#### 🔨 Punishment Actions
- **Ban** - Temporary (10s-365d) or permanent with scheduled unban
- **Unban** - Username or ID search with job cancellation
- **Timeout** - Discord native timeout (max 28 days)
- **Kick** - Immediate removal from server
- **Warn** - Issue warnings with auto-escalation
- **Softban** - Ban + immediate unban (message deletion)
- **Mute** - Timeout alias for familiarity

#### 🛡️ AutoMod Engine
**Rule Types:**
- **Spam Detection** - Message frequency (5 msgs/5s default)
- **Channel Spam** - Cross-channel abuse (3 channels/10s)
- **Mention Spam** - Excessive mentions (4+/5s)
- **Caps Lock** - Excessive capitals (70% threshold)
- **Invite Links** - Discord invite detection
- **External Links** - URL detection (excludes Discord)
- **Keyword Filter** - Custom word/phrase blocking
- **Regex Patterns** - Advanced pattern matching

**Features:**
- **Multiple Actions** per rule (delete + warn + timeout)
- **Role Exemptions** (max 10 per rule)
- **Channel Exemptions** (max 20 per rule)
- **Quarantine System** - Auto-disable problematic rules
- **Error Tracking** - Disable after 3 consecutive errors
- **Version Control** - Track rule changes
- **Redis State** - Distributed checking across shards
- **Violation Logging** - Full analytics

#### 📁 Channel Management
- **Lock/Unlock** - Temporary or permanent with auto-unlock
- **Slowmode** - Rate limits (0-6 hours) with auto-removal
- **Archive** - Export messages (JSON + CSV) and move to archive
- **Thread Support** - Lock, unlock, archive threads
- **Permission Sync** - Category inheritance tracking

#### 🗑️ Bulk Operations
- **Message Purge** (1-100 messages):
  - Filter by user
  - Exclude specific user
  - Keyword search (comma-separated, ALL required)
  - Bots only
  - Attachments only
  - Exclude pinned
  - Handles >14-day-old messages
  
- **Reaction Purge** (1-500 messages):
  - Filter by user
  - Filter by emoji (unicode or custom)
  - Optimized bulk removal
  
- **Invite Purge**:
  - Delete all invites
  - Delete invites older than N days
  - Never touches vanity URL
  - Confirmation prompt with preview

#### 📝 Configuration
- **Warn Thresholds** - Auto-actions at specific counts
- **Guild Settings** - Per-guild configuration
- **Config Snapshots** - Version tracking
- **DM Preferences** - Toggle user notifications
- **Role Management** - Bulk add/clear with hierarchy check

---

## Quality of Life Commands

> For full command documentation, see [COMMANDS.md](COMMANDS.md)

| Command | Description | Key Features |
|---------|-------------|--------------|
| `/purge` | Bulk delete messages | Filter by user, exclude user, keywords (comma-separated), bots, attachments |
| `/warns` | View user warnings | Shows case IDs, relative timestamps, moderator names |
| `/case` | View case details | Search by ID or user+number (1 = most recent) |
| `/history` | Recent mod actions | Filter by action type, actor; shows compact timeline |
| `/backup` | Export audit logs | CSV/JSON format, custom action filters |
| `/archive` | Export & archive channel | JSON + CSV export, auto-categorize, lock channel |
| `/membercount` | Server statistics | Online/offline breakdown, visual presence bar, join stats |
| `/channelinfo` | Channel details | Permissions, sync status, last activity |
| `/messageinfo` | Message inspector | Jump button, edit history, attachment details |
| `/perms` | Check permissions | Permission matrix, missing perms, explicit denies |
| `/can` | Self-permission check | Quick yes/no answer with details |
| `/roleinfo` | Role information | Member count, permissions, hierarchy position |
| `/serverinfo` | Server statistics | Members, channels, boosts, features |
| `/userinfo` | User/member info | Badges, join date, roles, permissions |
| `/avatar` | Get user avatar | PNG/JPG/WEBP/GIF download links, 1024px |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  ShardingManager (void.js)                   │
│          Process Manager & Health Server (:3001)             │
│                                                              │
│  Features:                                                   │
│  • Automatic shard count calculation                         │
│  • Health monitoring & metrics collection                    │
│  • IPC message routing                                       │
│  • Graceful shutdown handling                                │
│  • Prometheus metrics export                                 │
└────────────┬────────────────────────────────────────────────┘
             │ Spawns & Monitors
             │
             ├──────────────┬──────────────┬──────────────┬────────────
             ▼              ▼              ▼              ▼
        ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
        │ Shard 0 │   │ Shard 1 │   │ Shard 2 │   │ Shard N │
        │         │   │         │   │         │   │         │
        │ Events  │   │ Events  │   │ Events  │   │ Events  │
        │ Commands│   │ Commands│   │ Commands│   │ Commands│
        │ Jobs    │   │ Jobs    │   │ Jobs    │   │ Jobs    │
        │ AutoMod │   │ AutoMod │   │ AutoMod │   │ AutoMod │
        └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘
             │             │             │             │
             └─────────────┴─────────────┴─────────────┘
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
         ┌─────────────┐       ┌──────────┐
         │ PostgreSQL  │       │  Redis   │
         │   (Docker)  │       │ (Docker) │
         │             │       │          │
         │ • Infractions      │ • Guild Configs    │
         │ • Guild Config     │ • AutoMod State    │
         │ • Scheduled Jobs   │ • Rate Limits      │
         │ • Audit Logs       │ • Component Cache  │
         │ • User Notes       │ • Session Data     │
         └─────────────┘       └──────────┘
```

### Data Flow

1. **Discord Event** → Shard → Event Handler
2. **Command Execution** → Middleware Check → Database Transaction
3. **AutoMod Trigger** → Redis State Check → Action Application
4. **Job Schedule** → Database Insert → Worker Pickup → Execution
5. **Component Interaction** → HMAC Validation → Handler Execution

---

## Installation

### Prerequisites

- **Node.js** v18 or higher (v20+ recommended)
- **Docker** & **Docker Compose**
- **Discord Bot Token** from [Discord Developer Portal](https://discord.com/developers/applications)

### Quick Start

```bash
# 1. Clone repository
git clone https://github.com/Zenzxnse/void-bot.git
cd void-bot

# 2. Install dependencies
npm install

# 3. Start Docker services (PostgreSQL & Redis)
docker-compose up -d

# 4. Wait for database to be ready
docker-compose logs -f db
# Wait for "database system is ready to accept connections"

# 5. Copy environment template
cp example.env .env

# 6. Edit .env with your configuration
nano .env  # or your preferred editor

# 7. Register slash commands
npm run register

# 8. Start the bot
npm run dev  # Development mode
# or
npm start    # Production mode
```

---

## Configuration

### Basic Configuration

Edit `src/core/config.js`:

```javascript
export default {
  // Folder structure
  COMMANDS_FOLDER: "commands",
  EVENTS_FOLDER: "events",
  BUTTONS_FOLDER: "buttons",
  
  // Command registration
  GLOBAL: false,  // Set to true for global commands (1 hour cache)
  GUILD_IDS: [    // Test guild IDs (instant updates)
    "123456789012345678",
  ],
  
  // Logging
  LOG_LEVEL: "info",  // debug|info|warn|error|silent
  LOG_REDACT: "token,authorization,headers.authorization,env.VOID_TOKEN",
  
  // Component system
  BUTTON_IMPORT_CONCURRENCY: 10,
  FAIL_ON_EMPTY_BUTTONS: false,
  BUTTON_DM_FALLBACK: false,
  
  // Environment
  NODE_ENV: "development",  // 'production' or 'development'
};
```

---

## Environment Variables

Create a `.env` file in the project root:

### Required Variables

```env
# Discord Configuration (REQUIRED)
VOID_TOKEN=your_discord_bot_token_here
APP_ID=your_discord_application_id_here
OWNER_IDS=your_user_id_here

# Database (REQUIRED - Docker defaults work out of box)
DATABASE_URL=postgres://void:voidpassword@localhost:5432/voiddb
PG_MAX=10                    # Connection pool size
PGSSL=false                  # Set to 'require' in production

# Component Security (REQUIRED)
COMPONENT_SECRET=$(openssl rand -hex 32)  # Generate with: openssl rand -hex 32
```

### Optional Variables

```env
# Redis Configuration (Optional but recommended)
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_KEY_PREFIX=void:
REDIS_LIMP_MODE=1           # Continue without Redis if unavailable

# Sharding
SHARDING=1                  # Enable sharding (0 to disable)
TOTAL_SHARDS=auto           # Auto-calculate or specify number
SHARD_SPAWN_DELAY=7500      # Delay between shard spawns (ms)
SHARD_RESPAWN_DELAY=5000    # Delay before respawn on crash (ms)
MAX_RESPAWN_ATTEMPTS=5      # Max auto-restart attempts

# Health & Monitoring
HEALTH_PORT=3001            # Health endpoint port
METRICS_INTERVAL=30000      # Metrics collection interval (ms)

# Job System
JOB_INTERVAL=30000          # Job check interval (ms)
JOB_BATCH_SIZE=10           # Jobs to process per batch

# Logging Configuration
LOG_LEVEL=info              # debug|info|warn|error|silent
LOG=1                       # 0 = disable all logging
LOG_PRETTY=1                # 1 = pretty print (development)
LOG_JSON=0                  # 1 = JSON format (production)
LOG_COLOR=1                 # 1 = colored output
```

### AI Configuration (Future Feature)

```env
# AI Configuration (Not yet implemented)
AI_ENABLED=false
AI_MODEL=llama-3.1-70b-versatile
AI_TEMPERATURE=0.7
AI_MAX_TOKENS=2048
GROQ_API_KEY=your_groq_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here

# AI Access Control
AI_ALLOWED_USERS=comma_separated_user_ids
AI_OWNERS=your_owner_id_here

# AI Rate Limits (Groq defaults)
AI_RATE_LIMIT_RPM=30        # Requests per minute
AI_RATE_LIMIT_TPM=30000     # Tokens per minute
AI_RATE_LIMIT_RPD=1000      # Requests per day
AI_RATE_LIMIT_TPD=500000    # Tokens per day

# AI Queue Configuration
AI_QUEUE_CONCURRENCY=5
AI_QUEUE_MAX_RETRIES=3
```

### Environment Variable Details

| Variable | Default | Description |
|----------|---------|-------------|
| `VOID_TOKEN` | - | Discord bot token (required) |
| `APP_ID` | - | Discord application ID (required) |
| `OWNER_IDS` | - | Comma-separated bot owner IDs |
| `DATABASE_URL` | - | PostgreSQL connection string |
| `PG_MAX` | 10 | Max database connections |
| `PGSSL` | false | Enable SSL for database (`require` in production) |
| `REDIS_URL` | - | Redis connection string |
| `REDIS_KEY_PREFIX` | `void:` | Prefix for Redis keys |
| `REDIS_LIMP_MODE` | 1 | Continue without Redis |
| `COMPONENT_SECRET` | - | HMAC secret for component signing (32+ chars) |
| `TOTAL_SHARDS` | `auto` | Number of shards or 'auto' |
| `SHARD_SPAWN_DELAY` | 7500 | MS between shard spawns |
| `HEALTH_PORT` | 3001 | Health endpoint port |
| `METRICS_INTERVAL` | 30000 | Metrics collection interval (MS) |
| `JOB_INTERVAL` | 30000 | Job check interval (MS) |
| `JOB_BATCH_SIZE` | 10 | Jobs to process per batch |
| `LOG_LEVEL` | info | Logging level |
| `LOG_PRETTY` | 0 | Pretty print logs (development) |
| `NODE_ENV` | development | Environment mode |

---

## Docker Setup

The bot uses Docker Compose for PostgreSQL and Redis. The bot itself runs on the host (or can be containerized).

### Docker Compose Services

```yaml
services:
  db:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: void
      POSTGRES_PASSWORD: voidpassword
      POSTGRES_DB: voiddb
    volumes:
      - db_data:/var/lib/postgresql/data
      - ./schema:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U void -d voiddb"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
```

### Docker Commands

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f db
docker-compose logs -f redis

# Stop services
docker-compose down

# Reset database (WARNING: deletes all data)
docker-compose down -v
docker-compose up -d

# Database backup
docker exec void_pg pg_dump -U void voiddb > backup_$(date +%Y%m%d).sql

# Database restore
docker exec -i void_pg psql -U void voiddb < backup.sql

# Redis CLI
docker exec -it void-redis redis-cli

# Check service health
docker-compose ps
```

---

## Development

### Project Structure

```
void-bot/
├── src/
│   ├── commands/              # Slash commands
│   │   ├── moderation/        # Moderation commands
│   │   │   ├── ban.js
│   │   │   ├── warn.js
│   │   │   ├── automod.js
│   │   │   └── ...
│   │   ├── utility/           # Utility commands
│   │   │   ├── serverinfo.js
│   │   │   ├── userinfo.js
│   │   │   └── ...
│   │   ├── ai/                # AI commands (future)
│   │   ├── bot/               # Bot management
│   │   └── fun/               # Fun/game commands
│   │
│   ├── components/            # Interactive components
│   │   ├── buttons/           # Button handlers
│   │   ├── games/             # Game components
│   │   ├── ComponentRouter.js # Component routing system
│   │   └── init.js            # Component initialization
│   │
│   ├── core/                  # Core systems
│   │   ├── db/                # Database layer
│   │   │   ├── index.js       # Connection pool & queries
│   │   │   ├── guild.js       # Guild config helpers
│   │   │   ├── jobs.js        # Job scheduling
│   │   │   └── migrations/    # SQL migrations
│   │   │
│   │   ├── loaders/           # Dynamic loaders
│   │   │   ├── commandLoader.js
│   │   │   └── eventLoader.js
│   │   │
│   │   ├── middleware/        # Middleware system
│   │   │   ├── middleware.js  # Permission checks
│   │   │   └── cooldown.js    # Cooldown system
│   │   │
│   │   ├── VoidApp.js         # Extended Client
│   │   ├── logger.js          # Pino logging
│   │   ├── config.js          # Bot config
│   │   └── env-config.js      # Env validation
│   │
│   ├── events/                # Discord events
│   │   ├── ready.js
│   │   ├── interactionCreate.js
│   │   ├── on_message.js      # AutoMod trigger
│   │   └── ...
│   │
│   ├── infra/                 # Infrastructure
│   │   ├── ipc.js             # Inter-process comm
│   │   ├── redis.js           # Redis client
│   │   ├── shard-routing.js   # Shard routing
│   │   └── reply-guard.js     # Anti-replay
│   │
│   ├── utils/                 # Utilities
│   │   ├── automod/
│   │   │   ├── autoMod.js     # AutoMod engine
│   │   │   └── redis-state.js # Distributed state
│   │   │
│   │   ├── moderation/
│   │   │   ├── mod-actions.js # Apply actions
│   │   │   ├── mod-db.js      # Database helpers
│   │   │   ├── mod.js         # Utility functions
│   │   │   └── duration.js    # Duration parsing
│   │   │
│   │   └── helpers/
│   │       ├── persistence.js # Component state
│   │       └── rateLimiter.js # Rate limiting
│   │
│   ├── bootstrap/             # Bootstrap scripts
│   │   ├── error-traps.js     # Global error handlers
│   │   └── singleton-lock.js  # Process locking
│   │
│   ├── graphics/              # Visual assets
│   │   ├── void.jpg
│   │   └── bg.jpg
│   │
│   ├── shard.js               # Shard process entry
│   ├── void.js                # Manager process entry
│   └── commandRegistry.js     # Command registration
│
├── schema/                    # Database migrations
│   ├── 001_init.sql
│   ├── 002_fix_automod_schema.sql
│   ├── 003_ai_system.sql
│   └── 004_rolemenu_system.sql
│
├── docs/                      # Documentation
│   └── component-router.md
│
├── docker-compose.yml         # Docker Compose config
├── Dockerfile                 # Bot container (optional)
├── .env.example               # Environment template
├── .gitignore
├── package.json
├── README.md
├── COMMANDS.md                # Command documentation
└── LICENSE
```

### Adding Commands

1. Create `src/commands/<category>/<name>.js`:

```javascript
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';

export default {
  data: new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('My awesome command')
    .addStringOption(o => o
      .setName('input')
      .setDescription('Some input')
      .setRequired(true))
    .setDMPermission(false),
  
  // Middleware
  requiredPerms: [PermissionFlagsBits.ManageMessages],
  requiredBotPerms: [PermissionFlagsBits.SendMessages],
  cooldownMs: 3000,
  guildOnly: true,
  
  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const input = interaction.options.getString('input', true);
    
    // Your logic here
    
    return safeReply(interaction, {
      content: `You said: ${input}`,
      ephemeral: true
    });
  }
};
```

2. Register commands: `npm run register`

### Adding Events

Create `src/events/<eventName>.js`:

```javascript
import { Events } from 'discord.js';

export default {
  name: Events.MessageCreate,
  once: false,
  
  async execute(message, client) {
    // Handle event
    if (message.author.bot) return;
    
    // Your logic
  }
};
```

### Adding Components

Register in `src/components/init.js`:

```javascript
router.button('mymodule:action', {
  persistent: true,
  defer: 'update',
  permissions: [PermissionFlagsBits.ManageMessages],
  
  async execute(interaction, context) {
    const { parsed, client, log } = context;
    
    await interaction.update({
      content: 'Action completed!',
      components: []
    });
  }
});
```

---

## Health & Monitoring

### Health Endpoints

The manager process exposes endpoints on port 3001 (configurable via `HEALTH_PORT`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health/live` | GET | Liveness check - Is process running? |
| `/health/ready` | GET | Readiness check - Are all shards ready? |
| `/health/deep` | GET | Deep health - WebSocket, database, Redis |
| `/metrics` | GET | Prometheus metrics (text format) |
| `/metrics.json` | GET | JSON stats format |
| `/maintenance/on` | POST | Enable maintenance mode |
| `/maintenance/off` | POST | Disable maintenance mode |
| `/jobs/process` | POST | Manually trigger job processing |

### Example Health Checks

```bash
# Liveness (basic process check)
curl http://localhost:3001/health/live
# Response: {"status":"ok","uptime":123.45}

# Readiness (all shards ready?)
curl http://localhost:3001/health/ready
# Response: {"ready":true,"shards":{"0":"ready","1":"ready"}}

# Deep health (comprehensive check)
curl http://localhost:3001/health/deep
# Response: {
#   "status":"healthy",
#   "checks":{
#     "websocket":{"status":"ok","ping":42},
#     "database":{"status":"ok","latency":5},
#     "redis":{"status":"ok","latency":2}
#   }
# }

# Prometheus metrics
curl http://localhost:3001/metrics
# Returns Prometheus-format metrics

# JSON stats
curl http://localhost:3001/metrics.json
# Response: {"shards":[...],"commands":{...},"system":{...}}
```

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `discord_shard_status` | Gauge | Shard ready state (1=ready, 0=not ready) |
| `discord_shard_guilds` | Gauge | Number of guilds per shard |
| `discord_shard_ping_ms` | Gauge | WebSocket ping per shard |
| `discord_commands_executed_total` | Counter | Total command executions |
| `discord_command_errors_total` | Counter | Total command errors |
| `discord_ipc_duration_seconds` | Histogram | IPC message latency |

### Maintenance Mode

```bash
# Enable maintenance (stops job processing)
curl -X POST http://localhost:3001/maintenance/on

# Disable maintenance
curl -X POST http://localhost:3001/maintenance/off
```

---

## Troubleshooting

### Common Issues

#### Shards Not Spawning

```bash
# Check logs
tail -f void-bot.log

# Verify token
node -e "console.log(process.env.VOID_TOKEN ? 'Token OK' : 'Token missing')"

# Test bot connection
npm run test:connection
```

**Possible causes:**
- Invalid token
- Bot not invited to any guilds
- Rate limited by Discord
- Network issues

#### Database Connection Failed

```bash
# Check Docker services
docker-compose ps

# Check database logs
docker-compose logs db

# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Restart database
docker-compose restart db
```

**Common fixes:**
- Wait for database health check to pass
- Check `DATABASE_URL` format
- Verify credentials match docker-compose.yml
- Ensure port 5432 not in use

#### Redis Connection Issues

```bash
# Check Redis status
docker-compose logs redis

# Test connection
redis-cli -u $REDIS_URL ping

# Restart Redis
docker-compose restart redis
```

**Note:** Bot continues with `REDIS_LIMP_MODE=1` if Redis unavailable.

#### Components Not Working

```bash
# Verify secret is set
echo $COMPONENT_SECRET | wc -c
# Should be 64+ characters

# Clean expired components
psql $DATABASE_URL -c "SELECT cleanup_expired_components()"

# Check component logs
grep "component" void-bot.log
```

**Common issues:**
- Missing or weak `COMPONENT_SECRET`
- Component ID signature mismatch
- Expired component state

#### Jobs Not Running

```bash
# Check job stats
psql $DATABASE_URL -c "
  SELECT type, status, COUNT(*) 
  FROM scheduled_jobs 
  GROUP BY type, status
"

# Manually trigger processing
curl -X POST http://localhost:3001/jobs/process

# Clean failed jobs
psql $DATABASE_URL -c "
  DELETE FROM scheduled_jobs 
  WHERE status = 'failed' 
    AND updated_at < NOW() - INTERVAL '7 days'
"
```

#### High Memory Usage

```bash
# Check shard stats
curl http://localhost:3001/metrics.json

# Reduce connection pool
export PG_MAX=5

# Enable Redis cache
export REDIS_URL=redis://localhost:6379/0

# Restart shards
npm run restart
```

#### Command Not Found

```bash
# Re-register commands
npm run register

# Check command files
ls -la src/commands/

# Verify guild IDs in config.js
node -e "import('./src/core/config.js').then(c => console.log(c.default.GUILD_IDS))"
```

---

## Production Deployment

### Pre-Deployment Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use strong `COMPONENT_SECRET` (64+ chars)
- [ ] Enable database SSL (`PGSSL=require`)
- [ ] Configure Redis persistence (AOF or RDB)
- [ ] Set up log aggregation (e.g., Loki, ELK)
- [ ] Configure automated database backups
- [ ] Set up monitoring (Prometheus + Grafana)
- [ ] Configure alerting (Discord webhook, PagerDuty, etc.)
- [ ] Set resource limits (PM2, systemd, or Docker)
- [ ] Enable rate limiting at reverse proxy
- [ ] Configure firewall rules
- [ ] Set up SSL/TLS for health endpoints
- [ ] Document runbooks for common issues
- [ ] Test disaster recovery procedures

### Recommended Specs

| Server Size | Guilds | Specs | Shards |
|-------------|--------|-------|--------|
| Small | <100 | 1GB RAM, 1 CPU | 1 |
| Medium | 100-1000 | 2GB RAM, 2 CPU | 2-4 |
| Large | 1000-5000 | 4GB RAM, 4 CPU | 4-8 |
| X-Large | 5000+ | 8GB+ RAM, 8+ CPU | 8+ |

### Process Management

#### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start bot
pm2 start src/void.js --name void-bot

# Monitor
pm2 monit

# Logs
pm2 logs void-bot

# Restart
pm2 restart void-bot

# Auto-start on boot
pm2 startup
pm2 save
```

#### Using systemd

Create `/etc/systemd/system/void-bot.service`:

```ini
[Unit]
Description=Void Bot
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=void
WorkingDirectory=/opt/void-bot
Environment="NODE_ENV=production"
EnvironmentFile=/opt/void-bot/.env
ExecStart=/usr/bin/node src/void.js
Restart=always
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl enable void-bot
sudo systemctl start void-bot

# Check status
sudo systemctl status void-bot

# View logs
sudo journalctl -u void-bot -f
```

---

## Contributing

Contributions are welcome! Please follow these guidelines:

### Development Workflow

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/yourusername/void-bot.git`
3. **Create** a feature branch: `git checkout -b feature/amazing-feature`
4. **Commit** your changes: `git commit -m 'Add amazing feature'`
5. **Push** to branch: `git push origin feature/amazing-feature`
6. **Open** a Pull Request

### Code Standards

- Use ESLint configuration (Airbnb base)
- Write JSDoc comments for public APIs
- Prefer `async/await` over `.then()`
- Use named exports
- Keep functions focused and small
- Add tests for new features (when test suite is available)
- Follow existing code style

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new purge filter
fix: correct hierarchy check in ban command
docs: update README installation steps
refactor: simplify AutoMod state management
test: add tests for component router
chore: update dependencies
```

### Pull Request Guidelines

- Include description of changes
- Reference related issues
- Update documentation if needed
- Add screenshots for UI changes
- Ensure all checks pass

---

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.

```
Copyright 2024 Zenzxnse

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## Acknowledgments

- **Discord.js** - Powerful Discord library
- **PostgreSQL** - Reliable database system
- **Redis** - Fast in-memory data store
- **Pino** - High-performance logging
- **Prom-client** - Prometheus metrics

---

## Support

- **Documentation**: [Full command reference](COMMANDS.md)
- **Issues**: [GitHub Issues](https://github.com/Zenzxnse/void-bot/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Zenzxnse/void-bot/discussions)

---

<div align="center">

**[⬆ Back to Top](#void-bot)**

Made with ❤️ by Zenzxnse

</div>
