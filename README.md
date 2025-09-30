# Void Bot

**Version:** 1.0.0-beta  
**License:** Apache-2.0  
**Author:** Zenzxnse

A feature-rich Discord moderation and utility bot built with Discord.js, featuring automatic sharding, comprehensive moderation tools.

---

## Table of Contents

- [Features](#features)
- [Commands](#commands)
  - [Moderation](#moderation-commands)
  - [Utility](#utility-commands)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Development](#development)
- [Docker Setup](#docker-setup)
- [Health & Monitoring](#health--monitoring)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### Core Systems
- **Automatic Sharding** with health monitoring
- **PostgreSQL Database** with connection pooling and migrations
- **Redis Caching** for distributed state management
- **Job Scheduling** for delayed actions (unbans, unlocks, etc.)
- **Component Router** with HMAC-signed persistent components
- **Health Endpoints** with Prometheus metrics
- **Transaction Support** for atomic operations
- **(AI moderation/Utilities)** will be added in future

### Moderation
- Comprehensive infraction system (warns, timeouts, bans, kicks)
- Warning thresholds with auto-escalation
- Temporary punishments with automatic removal
- Channel management (lock, slowmode, archive)
- Bulk operations (purge messages, reactions, invites)
- Role management with hierarchy validation
- AutoMod with multiple rule types
- Full audit logging

### Utility
- Server and user information commands
- Permission checking and validation
- Channel and message inspection
- Member statistics and analytics
- Archive and export functionality

---

## Commands

### Moderation Commands

| Command | Description |
|---------|-------------|
| `/ban` | Ban a user (temporary or permanent) |
| `/unban` | Unban a user and cancel scheduled unbans |
| `/timeout` | Timeout a member (Discord native, max 28 days) |
| `/warn` | Issue a warning with optional auto-escalation |
| `/warns` | List a user's active warnings |
| `/unwarn` | Remove a specific warning |
| `/lock` | Lock a channel (temporary or permanent) |
| `/unlock` | Unlock a channel and cancel scheduled unlocks |
| `/slowmode` | Set or remove slowmode |
| `/purge` | Bulk delete messages with filters |
| `/purge-invites` | Delete server invite links |
| `/purge-reactions` | Remove reactions from messages |
| `/roles` | Add or clear roles from members |
| `/automod` | Configure auto-moderation rules |
| `/config warn` | Configure warning threshold actions |
| `/note` | Add, list, edit, or delete staff notes |
| `/case` | View infraction case details |
| `/history` | View recent moderation history |
| `/backup` | Export audit logs to CSV/JSON |

### Utility Commands

| Command | Description |
|---------|-------------|
| `/archive` | Export messages and archive a channel |
| `/avatar` | Get a user's avatar in multiple formats |
| `/channelinfo` | Detailed channel information |
| `/membercount` | Server member statistics |
| `/messageinfo` | Get details about a specific message |
| `/perms` | Check user permissions in a channel |
| `/can` | Check your own permissions |
| `/roleinfo` | Display role information |
| `/serverinfo` | Comprehensive server statistics |
| `/userinfo` | User and member information |

### AI Features

- `/ask` - Chat with AI (Groq or Gemini integration)
- Configurable rate limits (RPM, TPM, RPD, TPD)
- Access control with allowlists
- Queue system with retry logic

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                ShardingManager (void.js)                 │
│        Process Manager & Health Server (port 3001)       │
└────────────┬────────────────────────────────────────────┘
             │ Spawns & Monitors
             ├──────────────┬──────────────┬──────────────┐
             ▼              ▼              ▼              ▼
        ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
        │ Shard 0 │   │ Shard 1 │   │ Shard 2 │   │ Shard N │
        │(shard.js)│  │(shard.js)│  │(shard.js)│  │(shard.js)│
        └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘
             │             │             │             │
             └─────────────┴─────────────┴─────────────┘
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
         ┌─────────────┐       ┌──────────┐
         │ PostgreSQL  │       │  Redis   │
         │   (Docker)  │       │ (Docker) │
         └─────────────┘       └──────────┘
```

### Key Components

- **Manager** (`void.js`) - Spawns shards, collects metrics, serves health endpoints
- **Shard** (`shard.js`) - Discord gateway connection, event handling, job processing
- **VoidApp** (`VoidApp.js`) - Extended Discord.js Client
- **Component Router** - Handles persistent buttons, select menus, and modals
- **AutoMod Engine** - Message scanning with Redis-backed state
- **Job Worker** - Processes scheduled tasks (unbans, unlocks, etc.)

---

## Installation

### Prerequisites

- **Node.js** v18 or higher
- **Docker** & **Docker Compose**
- **Discord Bot Token** from [Discord Developer Portal](https://discord.com/developers/applications)

### Setup

1. **Clone the repository**
```bash
git clone https://github.com/Zenzxnse/void-bot.git
cd void-bot
```

2. **Install dependencies**
```bash
npm install
```

3. **Start Docker services** (PostgreSQL & Redis)
```bash
docker-compose up -d
```

4. **Configure environment** (see [Configuration](#configuration))

5. **Run database migrations** (automatic on first start)

6. **Register slash commands**
```bash
npm run register
```

7. **Start the bot**
```bash
# Development
npm run dev

# Production
npm start
```

---

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Discord
VOID_TOKEN=your_bot_token_here
APP_ID=your_application_id_here
OWNER_IDS=your_user_id_here

# Database (Docker defaults)
DATABASE_URL=postgres://void:voidpassword@localhost:5432/voiddb

# Redis (Docker defaults)
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_KEY_PREFIX=void:
REDIS_LIMP_MODE=1

# Component System
COMPONENT_SECRET=$(openssl rand -hex 32)

# AI Configuration
AI_ENABLED=true
AI_MODEL=llama-3.1-70b-versatile
GROQ_API_KEY=your_groq_api_key
GEMINI_API_KEY=your_gemini_api_key
AI_ALLOWED_USERS=comma_separated_user_ids
AI_RATE_LIMIT_RPM=30
AI_RATE_LIMIT_TPM=30000

# Logging
LOG_LEVEL=info
LOG_PRETTY=1
NODE_ENV=development

# Sharding
TOTAL_SHARDS=auto

# Health & Metrics
HEALTH_PORT=3001
METRICS_INTERVAL=30000
```

### Bot Configuration

Edit `src/core/config.js`:

```javascript
export default {
  COMMANDS_FOLDER: "commands",
  EVENTS_FOLDER: "events",
  BUTTONS_FOLDER: "buttons",
  GLOBAL: false, // Set to true for global commands
  GUILD_IDS: ["your_test_guild_id"], // For testing
  LOG_LEVEL: "info",
  NODE_ENV: "development",
};
```

---

## Development

### Project Structure

```
void-bot/
├── src/
│   ├── commands/           # Slash commands
│   │   ├── moderation/     # Moderation commands
│   │   ├── utility/        # Utility commands
│   │   ├── ai/             # AI commands
│   │   ├── bot/            # Bot management commands
│   │   └── fun/            # Fun/game commands
│   ├── components/         # Buttons, select menus, modals
│   │   ├── buttons/
│   │   ├── games/
│   │   ├── ComponentRouter.js
│   │   └── init.js
│   ├── core/
│   │   ├── db/             # Database utilities
│   │   │   ├── index.js
│   │   │   ├── guild.js
│   │   │   ├── jobs.js
│   │   │   └── migrations/
│   │   ├── loaders/        # Command & event loaders
│   │   ├── middleware/     # Permission & cooldown checks
│   │   ├── VoidApp.js      # Extended Discord.js Client
│   │   ├── logger.js       # Pino logging
│   │   └── config.js       # Bot configuration
│   ├── events/             # Discord event handlers
│   ├── infra/              # Infrastructure
│   │   ├── ipc.js
│   │   ├── redis.js
│   │   ├── shard-routing.js
│   │   └── reply-guard.js
│   ├── utils/
│   │   ├── automod/        # AutoMod engine
│   │   ├── moderation/     # Moderation utilities
│   │   └── helpers/
│   ├── shard.js            # Shard process entry
│   └── void.js             # Manager process entry
├── schema/                 # Database migrations
├── docker-compose.yml
├── Dockerfile
└── package.json
```

### Adding Commands

Create a new file in `src/commands/<category>/<command>.js`:

```javascript
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('yourcommand')
    .setDescription('Description'),
  
  // Optional middleware
  requiredPerms: [PermissionFlagsBits.ManageMessages],
  cooldownMs: 5000,
  guildOnly: true,
  
  async execute(interaction) {
    await interaction.reply('Hello!');
  }
};
```

### Adding Components

Register persistent components in `src/components/init.js`:

```javascript
router.button('namespace:action', {
  persistent: true,
  defer: 'update',
  
  async execute(interaction, context) {
    await interaction.update({ content: 'Done!' });
  }
});
```

---

## Docker Setup

The bot uses Docker Compose for PostgreSQL and Redis:

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Reset database
docker-compose down -v
docker-compose up -d
```

The bot itself can run outside Docker (development) or inside (production).

---

## Health & Monitoring

### Endpoints

The manager process exposes health endpoints on port 3001:

```bash
# Liveness check
curl http://localhost:3001/health/live

# Readiness check (all shards ready?)
curl http://localhost:3001/health/ready

# Deep health check (websocket, db, redis)
curl http://localhost:3001/health/deep

# Prometheus metrics
curl http://localhost:3001/metrics

# JSON stats
curl http://localhost:3001/metrics.json
```

### Metrics

- `discord_shard_status` - Shard ready state
- `discord_shard_guilds` - Guilds per shard
- `discord_shard_ping_ms` - WebSocket latency
- `discord_commands_executed_total` - Command execution count
- `discord_command_errors_total` - Command errors

---

## Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use strong `COMPONENT_SECRET` (32+ chars)
- [ ] Enable SSL for database (`PGSSL=require`)
- [ ] Configure Redis persistence
- [ ] Set up log aggregation
- [ ] Configure automated backups
- [ ] Set resource limits (memory, CPU)
- [ ] Enable rate limiting
- [ ] Set up monitoring (Prometheus/Grafana)

---

## Troubleshooting

### Shards Not Spawning
```bash
# Check logs
tail -f void-bot.log

# Verify token
node -e "console.log(process.env.VOID_TOKEN ? 'Token set' : 'Missing token')"
```

### Database Connection Issues
```bash
# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check Docker
docker-compose ps
```

### Components Not Working
```bash
# Verify secret is set
echo $COMPONENT_SECRET

# Clean expired components
psql $DATABASE_URL -c "SELECT cleanup_expired_components()"
```

---

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- Built with [discord.js](https://discord.js.org/)
- Database: [node-postgres](https://node-postgres.com/)
- Caching: [ioredis](https://github.com/luin/ioredis)
- Logging: [pino](https://getpino.io/)
- Metrics: [prom-client](https://github.com/siimon/prom-client)

---

**Note:** This is a beta release (v1.0.0-beta). Features and APIs may change before the stable 1.0.0 release.