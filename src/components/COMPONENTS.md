# Component Router Documentation

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Setup](#setup)
4. [Basic Usage](#basic-usage)
5. [Component Types](#component-types)
6. [Secure Custom IDs](#secure-custom-ids)
7. [Persistence](#persistence)
8. [Middleware & Security](#middleware--security)
9. [Advanced Features](#advanced-features)
10. [API Reference](#api-reference)
11. [FAQ](#faq)
12. [Best Practices](#best-practices)

---

## Overview

The Component Router is a production-ready system for handling Discord.js interactions (buttons, select menus, modals) with built-in security, persistence, and middleware support.

**Key Benefits:**
- 🔒 Cryptographically signed custom IDs prevent tampering
- 🔄 Automatic anti-replay protection
- 💾 Optional persistence across bot restarts
- 🛡️ Integrated middleware (cooldowns, permissions, hierarchy)
- 🚀 Simple registration API
- 📊 Built-in telemetry and stats

---

## Features

- **Secure Custom IDs**: HMAC-signed IDs with expiry and context validation
- **Anti-Replay**: Prevents duplicate submissions (configurable scope)
- **Guild Config Caching**: Automatic caching with invalidation
- **Middleware Integration**: Uses existing permission/cooldown system
- **Persistence**: Store components in database for restart recovery
- **Auto-Defer**: Smart deferral strategies (update/reply/auto)
- **Access Control**: Caller-only, role-based, user-based restrictions
- **Telemetry**: Execution counts, denial tracking, error logging

---

## Setup

### 1. Environment Variables

```bash
# Required: Secret for signing component IDs
COMPONENT_SECRET=your-random-secret-here-min-32-chars

# Recommended: Generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Initialize Router

```javascript
// src/components/init.js
import createComponentRouter from './ComponentRouter.js';

export async function initializeComponents(client) {
  const router = createComponentRouter(client);
  
  // Store on client for access elsewhere
  client.components = router;
  
  // Register your components
  registerMyComponents(router);
  
  return router;
}
```

### 3. Call During Startup

```javascript
// In your bot's ready event or startup
client.once('ready', async () => {
  await initializeComponents(client);
  console.log('Components ready!');
});
```

---

## Basic Usage

### Simple Button

```javascript
// Register a button
router.button('game:join', {
  async execute(interaction, context) {
    await interaction.reply({
      content: `${interaction.user} joined the game!`,
      ephemeral: true
    });
  }
});

// Create the button in a command
import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { makeId } from './ComponentRouter.js';

const button = new ButtonBuilder()
  .setCustomId(makeId('game', 'join', interaction))
  .setLabel('Join Game')
  .setStyle(ButtonStyle.Primary);

await interaction.reply({
  content: 'Click to join:',
  components: [new ActionRowBuilder().addComponents(button)]
});
```

---

## Component Types

### 1. Buttons

```javascript
router.button('poll:vote', {
  defer: 'update', // Don't show "thinking" message
  callerOnly: false, // Anyone can click
  
  async execute(interaction, context) {
    const { parsed } = context;
    const option = parsed.data.custom.option; // From makeId
    
    await interaction.update({
      content: `You voted for: ${option}`
    });
  }
});

// Creating the button with data
const customId = makeId('poll', 'vote', interaction, { option: 'yes' });
```

### 2. String Select Menu

```javascript
router.stringSelect('ticket:category', {
  defer: 'reply',
  ephemeral: true,
  
  async execute(interaction, context) {
    const selected = interaction.values[0];
    
    await interaction.editReply({
      content: `Creating ${selected} ticket...`
    });
    
    // Create ticket logic here
  }
});

// Creating the select menu
import { StringSelectMenuBuilder } from 'discord.js';

const select = new StringSelectMenuBuilder()
  .setCustomId(makeId('ticket', 'category', interaction))
  .setPlaceholder('Choose ticket type')
  .addOptions([
    { label: 'Bug Report', value: 'bug' },
    { label: 'Feature Request', value: 'feature' },
    { label: 'Support', value: 'support' }
  ]);
```

### 3. User Select Menu

```javascript
router.userSelect('mod:target', {
  requiredPerms: [PermissionFlagsBits.ModerateMembers],
  guildOnly: true,
  
  async execute(interaction, context) {
    const targetUser = interaction.users.first();
    
    await interaction.reply({
      content: `Selected: ${targetUser}`,
      ephemeral: true
    });
  }
});
```

### 4. Role Select Menu

```javascript
router.roleSelect('config:muterole', {
  requiredPerms: [PermissionFlagsBits.ManageRoles],
  
  async execute(interaction, context) {
    const role = interaction.roles.first();
    
    // Update guild config
    await query(
      'UPDATE guild_config SET mute_role_id = $1 WHERE guild_id = $2',
      [role.id, interaction.guildId]
    );
    
    await interaction.reply({
      content: `✅ Mute role set to ${role}`,
      ephemeral: true
    });
  }
});
```

### 5. Channel Select Menu

```javascript
router.channelSelect('config:logchannel', {
  requiredPerms: [PermissionFlagsBits.ManageGuild],
  
  async execute(interaction, context) {
    const channel = interaction.channels.first();
    
    await query(
      'UPDATE guild_config SET log_channel_id = $1 WHERE guild_id = $2',
      [channel.id, interaction.guildId]
    );
    
    await interaction.reply({
      content: `✅ Log channel set to ${channel}`,
      ephemeral: true
    });
  }
});
```

### 6. Modals

```javascript
router.modal('feedback:submit', {
  async execute(interaction, context) {
    const title = interaction.fields.getTextInputValue('title');
    const description = interaction.fields.getTextInputValue('description');
    
    // Store feedback
    await query(
      'INSERT INTO feedback (user_id, title, description) VALUES ($1, $2, $3)',
      [interaction.user.id, title, description]
    );
    
    await interaction.reply({
      content: '✅ Feedback submitted!',
      ephemeral: true
    });
  }
});

// Showing the modal (from a button click)
import { ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

const modal = new ModalBuilder()
  .setCustomId(makeId('feedback', 'submit', interaction))
  .setTitle('Submit Feedback')
  .addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
    )
  );

await interaction.showModal(modal);
```

---

## Secure Custom IDs

### Basic Usage

```javascript
import { makeId } from './ComponentRouter.js';

// Simple ID (expires in 15 minutes by default)
const id = makeId('namespace', 'action', interaction);

// With custom data
const id = makeId('game', 'move', interaction, { 
  x: 0, 
  y: 1, 
  gameId: 'abc123' 
});

// With custom TTL (seconds)
const id = makeId('vote', 'submit', interaction, { pollId: '123' }, 3600);
```

### Manual Builder (Advanced)

```javascript
import { SecureCustomId } from './ComponentRouter.js';

const id = new SecureCustomId('game', 'tictactoe', 'v1')
  .setContext(interaction)
  .setData({ 
    gameId: 'abc123',
    position: 4 
  })
  .setTTL(1800) // 30 minutes
  .build();
```

### Parsing in Handler

```javascript
router.button('game:move', {
  async execute(interaction, context) {
    const { parsed } = context;
    
    // Parsed structure:
    // {
    //   namespace: 'game',
    //   action: 'move',
    //   version: 'v1',
    //   prefix: 'game:move',
    //   versionedPrefix: 'game:move:v1',
    //   data: {
    //     userId: '12345',
    //     guildId: '67890',
    //     channelId: '11111',
    //     messageId: '22222',
    //     expires: 1234567890,
    //     nonce: 'abc123def456',
    //     custom: { gameId: 'abc123', position: 4 }
    //   }
    // }
    
    const gameId = parsed.data.custom.gameId;
    const position = parsed.data.custom.position;
    
    // Your logic here
  }
});
```

---

## Persistence

Persistence allows components to survive bot restarts by storing metadata in the database.

### Enable Persistence

```javascript
router.button('ticket:close', {
  persistent: true, // Enable persistence
  defer: 'update',
  
  async execute(interaction, context) {
    const ticketId = context.parsed.data.custom.ticketId;
    
    await closeTicket(ticketId);
    
    await interaction.update({
      content: '🔒 Ticket closed',
      components: [] // Remove buttons
    });
  }
});
```

### How It Works

1. **On First Click**: Component metadata is stored in `persistent_components` table
2. **On Restart**: Components are automatically restored from database
3. **Automatic Cleanup**: Expired components are removed every hour

### What Gets Stored

```sql
-- persistent_components table
{
  message_id: '123456789',
  channel_id: '987654321',
  guild_id: '555666777',
  component_type: 'game:move',      -- Namespace:action (unversioned)
  component_key: 'game:move:v1:...',-- Unique dedup key
  component_data: {                 -- JSON metadata
    version: 'v1',
    custom: { gameId: 'abc', position: 4 },
    handler: 'button'
  },
  expires_at: '2025-01-15T12:00:00Z',
  created_at: '2025-01-15T11:00:00Z'
}
```

### Persistence Best Practices

```javascript
// ❌ BAD: Too much data
makeId('game', 'state', interaction, {
  board: [[0,1,2], [0,1,2], [0,1,2]], // Heavy data
  history: [/* 100 moves */]
}, 86400);

// ✅ GOOD: Store ID, fetch from DB
makeId('game', 'move', interaction, {
  gameId: 'abc123' // Look up game state by ID
}, 86400);
```

---

## Middleware & Security

All component handlers support the same middleware as commands:

### Permission Checks

```javascript
router.button('mod:warn', {
  requiredPerms: [PermissionFlagsBits.ModerateMembers],
  requiredBotPerms: [PermissionFlagsBits.ModerateMembers],
  guildOnly: true,
  
  async execute(interaction, context) {
    // Only users with ModerateMembers can click
    // Bot must also have ModerateMembers
  }
});
```

### Cooldowns

```javascript
router.button('economy:daily', {
  cooldownMs: 86400000, // 24 hours
  
  async execute(interaction, context) {
    // Can only be clicked once per 24h per user
    await giveDailyReward(interaction.user.id);
  }
});
```

### Owner Only

```javascript
router.button('admin:reboot', {
  ownerOnly: true,
  
  async execute(interaction, context) {
    // Only bot owner can click
    await interaction.reply('Rebooting...');
    process.exit(0);
  }
});
```

### Caller Restrictions

```javascript
router.button('game:forfeit', {
  callerOnly: true, // Only original message author
  
  async execute(interaction, context) {
    // Verified: interaction.user.id === parsed.data.userId
  }
});
```

### Role/User Whitelist

```javascript
router.button('premium:feature', {
  allowedRoles: ['1234567890', '0987654321'], // Premium role IDs
  
  async execute(interaction, context) {
    // Only users with premium roles
  }
});

router.button('mod:panel', {
  allowedUsers: ['111111111', '222222222'], // Specific user IDs
  
  async execute(interaction, context) {
    // Only these users
  }
});
```

---

## Advanced Features

### Anti-Replay Configuration

```javascript
router.button('vote:submit', {
  replayScope: 'user', // 'id' | 'user' | 'channel' | 'none'
  // id: Block exact component instance (default)
  // user: Block per-user across message
  // channel: Block per-channel
  // none: Allow multiple clicks
  
  async execute(interaction, context) {
    // User can only vote once
  }
});
```

### Defer Strategies

```javascript
// Update the message (no "thinking" state)
router.button('ui:toggle', {
  defer: 'update',
  async execute(interaction, context) {
    await interaction.update({ content: 'Toggled!' });
  }
});

// Show "thinking" state
router.button('slow:task', {
  defer: 'reply',
  ephemeral: true,
  async execute(interaction, context) {
    await doSlowTask();
    await interaction.editReply('Done!');
  }
});

// No deferral (respond immediately)
router.button('instant:action', {
  defer: 'none',
  async execute(interaction, context) {
    await interaction.reply({ content: 'Fast!', ephemeral: true });
  }
});

// Auto-detect (default)
router.button('auto:defer', {
  defer: 'auto', // Uses 'update' for components, 'reply' for modals
  async execute(interaction, context) {
    // Automatically deferred
  }
});
```

### Guild Config Access

```javascript
router.button('config:toggle', {
  skipGuildConfig: false, // Default: loads config
  
  async execute(interaction, context) {
    const { guildConfig } = context;
    
    // guildConfig is cached guild_config row
    const muteRoleId = guildConfig.mute_role_id;
    const dmOnAction = guildConfig.dm_on_action;
  }
});
```

### Custom Context

```javascript
router.button('game:info', {
  async execute(interaction, context) {
    const { 
      parsed,      // Parsed custom ID
      client,      // Discord client
      log,         // Logger (bound to interaction)
      router,      // Component router instance
      guildConfig  // Guild config (if !skipGuildConfig)
    } = context;
    
    // Add your own data
    const gameData = await fetchGameData(parsed.data.custom.gameId);
    
    // Pass to helper functions
    await handleGameAction(interaction, gameData, context);
  }
});
```

### Pattern Matching (Legacy Support)

```javascript
// Register by regex pattern
router.registries.get('button').registerPattern(
  /^legacy_button_\w+$/,
  {
    async execute(interaction, context) {
      // Handles all: legacy_button_abc, legacy_button_123, etc.
      const id = interaction.customId;
      await interaction.reply(`Matched: ${id}`);
    }
  }
);
```

---

## API Reference

### ComponentRouter Class

#### Methods

```javascript
// Registration
router.button(key, handler)
router.stringSelect(key, handler)
router.userSelect(key, handler)
router.roleSelect(key, handler)
router.mentionableSelect(key, handler)
router.channelSelect(key, handler)
router.modal(key, handler)

// Utilities
router.invalidateGuildCache(guildId)
router.getDetailedStats()
```

### Handler Structure

```typescript
interface Handler {
  // Required
  execute: (interaction, context) => Promise<void>;
  
  // Middleware (same as commands)
  cooldownMs?: number;
  requiredPerms?: PermissionResolvable[];
  requiredBotPerms?: PermissionResolvable[];
  guildOnly?: boolean;
  dmPermission?: boolean;
  ownerOnly?: boolean;
  ownerBypass?: boolean;
  
  // Component-specific
  defer?: 'auto' | 'update' | 'reply' | 'none' | false;
  replayScope?: 'id' | 'user' | 'channel' | 'none';
  ephemeral?: boolean;
  callerOnly?: boolean;
  allowedUsers?: string[];
  allowedRoles?: string[];
  skipGuildConfig?: boolean;
  persistent?: boolean;
}
```

### makeId Function

```javascript
makeId(
  namespace: string,    // Component namespace
  action: string,       // Action identifier
  interaction: Interaction,  // Current interaction
  customData?: object,  // Custom data to embed
  ttlSeconds?: number   // Expiry in seconds (default: 900)
) => string
```

### Context Object

```typescript
interface Context {
  parsed: ParsedCustomId;
  client: Client;
  log: Logger;
  router: ComponentRouter;
  guildConfig?: GuildConfig;
}

interface ParsedCustomId {
  namespace: string;
  action: string;
  version: string;
  prefix: string;              // 'namespace:action'
  versionedPrefix: string;     // 'namespace:action:version'
  data: {
    userId: string;
    guildId: string | null;
    channelId: string;
    messageId: string | null;
    expires: number;
    nonce: string;
    custom: object;
  };
  raw: string;
}
```

---

## FAQ

### Q: Why are my components not working after restart?

**A:** Enable persistence:
```javascript
router.button('my:button', {
  persistent: true, // Add this
  async execute(interaction, context) { }
});
```

### Q: How do I pass data between command and button?

```javascript
// In command
const customId = makeId('game', 'join', interaction, {
  gameId: 'abc123',
  mode: 'ranked'
});

// In handler
router.button('game:join', {
  async execute(interaction, context) {
    const { gameId, mode } = context.parsed.data.custom;
    // Use gameId and mode
  }
});
```

### Q: Can different users click the same button?

```javascript
// Yes - set callerOnly: false
router.button('poll:vote', {
  callerOnly: false, // Anyone can click
  async execute(interaction, context) { }
});

// No - restrict to original user
router.button('account:delete', {
  callerOnly: true, // Only command author
  async execute(interaction, context) { }
});
```

### Q: How do I handle errors in components?

```javascript
router.button('risky:action', {
  async execute(interaction, context) {
    try {
      await riskyOperation();
      await interaction.reply('Success!');
    } catch (error) {
      context.log.error({ error }, 'Operation failed');
      
      await interaction.reply({
        content: '❌ An error occurred',
        ephemeral: true
      });
    }
  }
});
```

### Q: How long do custom IDs last?

Default: **15 minutes** (900 seconds)

```javascript
// Custom expiry
makeId('namespace', 'action', interaction, {}, 3600); // 1 hour
makeId('namespace', 'action', interaction, {}, 86400); // 24 hours
```

### Q: What if my custom ID is too long?

Discord limit: 100 characters

```javascript
// ❌ Too much data
makeId('game', 'state', interaction, {
  veryLongString: 'a'.repeat(100),
  hugeArray: [1,2,3,4,5,6,7,8,9,10]
});

// ✅ Store ID, fetch data separately
makeId('game', 'move', interaction, {
  gameId: 'abc123' // Compact reference
});
```

### Q: How do I invalidate guild config cache?

```javascript
// Manually
client.components.invalidateGuildCache(guildId);

// Automatic on guild update
client.on('guildUpdate', (old, updated) => {
  client.components.invalidateGuildCache(updated.id);
});
```

---

## Best Practices

### ✅ DO

```javascript
// Use semantic namespaces
makeId('moderation', 'warn', interaction);
makeId('economy', 'daily', interaction);
makeId('game', 'move', interaction);

// Store minimal data in custom IDs
makeId('ticket', 'close', interaction, { ticketId: '123' });

// Enable persistence for important components
router.button('ticket:close', {
  persistent: true,
  async execute() { }
});

// Use appropriate defer strategies
router.button('ui:toggle', {
  defer: 'update', // Fast, no thinking state
  async execute() { }
});

// Add proper error handling
async execute(interaction, context) {
  try {
    await operation();
  } catch (error) {
    context.log.error({ error });
    await safeReply(interaction, 'Error occurred');
  }
}

// Set reasonable TTLs
makeId('vote', 'cast', interaction, {}, 3600); // 1 hour for votes
makeId('ephemeral', 'ack', interaction, {}, 60); // 1 min for acknowledgments
```

### ❌ DON'T

```javascript
// Don't use generic namespaces
makeId('btn', 'click', interaction); // Too vague

// Don't store large data in custom IDs
makeId('game', 'state', interaction, {
  board: [[0,1,2,3,4,5,6,7,8,9]], // Store in DB instead
  players: [/* huge array */]
});

// Don't forget to defer long operations
router.button('slow:task', {
  defer: 'none', // ❌ Will timeout!
  async execute(interaction) {
    await sleep(10000);
    await interaction.reply('Done'); // Too late!
  }
});

// Don't skip error handling
async execute(interaction, context) {
  await mightFail(); // ❌ Uncaught error crashes handler
  await interaction.reply('Success');
}

// Don't use infinite TTLs
makeId('namespace', 'action', interaction, {}, 999999999); // Bad practice
```

---

## Complete Example: Tic-Tac-Toe

```javascript
// Register game components
export function registerTicTacToeComponents(router) {
  // Move button
  router.button('ttt:move', {
    persistent: true,
    defer: 'update',
    callerOnly: false,
    
    async execute(interaction, context) {
      const { gameId, position } = context.parsed.data.custom;
      
      // Fetch game state from DB
      const game = await getGame(gameId);
      
      // Validate move
      if (!canPlayerMove(game, interaction.user.id)) {
        return interaction.reply({
          content: 'Not your turn!',
          ephemeral: true
        });
      }
      
      // Make move
      game.board[position] = interaction.user.id;
      game.currentPlayer = getOtherPlayer(game);
      
      // Check win condition
      const winner = checkWinner(game.board);
      
      // Update game
      await updateGame(gameId, game);
      
      // Build new board
      const components = buildBoard(game, interaction);
      
      // Update message
      await interaction.update({
        content: winner 
          ? `🎉 <@${winner}> wins!`
          : `Current turn: <@${game.currentPlayer}>`,
        components: winner ? [] : components
      });
    }
  });
  
  // Forfeit button
  router.button('ttt:forfeit', {
    persistent: true,
    defer: 'update',
    callerOnly: true,
    
    async execute(interaction, context) {
      const { gameId } = context.parsed.data.custom;
      
      await deleteGame(gameId);
      
      await interaction.update({
        content: '🏳️ Game forfeited',
        components: []
      });
    }
  });
}

// Helper: Build game board
function buildBoard(game, interaction) {
  const rows = [];
  
  for (let i = 0; i < 9; i += 3) {
    const row = new ActionRowBuilder();
    
    for (let j = 0; j < 3; j++) {
      const pos = i + j;
      const cell = game.board[pos];
      
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(makeId('ttt', 'move', interaction, {
            gameId: game.id,
            position: pos
          }, 3600))
          .setLabel(cell ? (cell === game.player1 ? 'X' : 'O') : '·')
          .setStyle(cell ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(!!cell)
      );
    }
    
    rows.push(row);
  }
  
  // Add forfeit button
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(makeId('ttt', 'forfeit', interaction, {
          gameId: game.id
        }, 3600))
        .setLabel('Forfeit')
        .setStyle(ButtonStyle.Danger)
    )
  );
  
  return rows;
}
```

---

**Need Help?** Check the source code in `src/components/ComponentRouter.js` or ask in the project Discord.