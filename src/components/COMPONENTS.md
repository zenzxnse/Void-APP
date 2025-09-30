# Component Router & Persistence (with Non-Expiring Components)

This document explains how our component router works, how persistence is handled, and how to build **non-expiring** components that continue to work across restarts and deploys.

## TL;DR

* Discord **messages and their components** persist. What *doesn’t* persist is your bot’s in-memory state (and by default our signed `custom_id`s have a TTL).
* The router gives you three patterns:

  1. **Ephemeral IDs (default):** signed, short-lived, anti-replay → safest for most buttons.
  2. **Refresh-on-use / refresh-on-ready:** rebuild buttons with **fresh IDs** after clicks or after a deploy.
  3. **Non-expiring (permanent) IDs:** deterministic, **no TTL**, still secure via server-side checks (role/perm/hierarchy/idempotency).

Choose the pattern per component.

---

## Architecture Overview

* `ComponentRouter`:

  * Registers handlers by **namespace:action(:version)**.
  * Verifies and parses `custom_id`, runs middleware (cooldowns, perms), supports **anti-replay** scopes (`id | user | channel | none`), and can **persist** component metadata to DB if the handler sets `persistent: true`.
* `SecureCustomId`:

  * Builds and verifies HMAC-signed custom IDs.
  * Encodes minimal context (`user`, `guild`, `channel`, `message`, `nonce`, `expires`) + your **custom payload**.
* `persistent_components` table (optional but recommended):

  * Stores a tiny blob per message/component instance so you can **rehydrate** controls with new IDs or introspect usage later.

---

## Quick Start

### Register a handler

```js
// somewhere in your module registration (e.g. registerTicTacToeComponents)
router.button('ttt:move', {
  defer: 'update',
  replayScope: 'id',       // or 'none' for non-expiring behavior (see below)
  callerOnly: true,
  persistent: true,        // store metadata after successful handle
  async execute(interaction, ctx) {
    // ... your logic, and usually interaction.editReply({ components: newRows })
  }
});
```

### Build an ID (default, expiring)

```js
import { makeId } from './ComponentRouter.js';

const customId = makeId('ttt', 'move', interaction, { i: 0, j: 2 }, /*ttl*/ 900);
// attach to a ButtonBuilder().setCustomId(customId)
```

---

## Non-Expiring Components

Some controls (e.g., **“Open Menu”**, **“Request Help”**, **“Resend Panel”**, or admin dashboards) should **work forever**, even after restarts and deploys.

You have two options:

### Option A — **Permanent IDs** (no TTL)

Add support for an “infinite”/permanent mode in `SecureCustomId`. We already accept a numeric `e` (expiry). We’ll treat `e:0` (or `e` omitted) as **no expiry**.

**Patch (tiny):**

```diff
// in SecureCustomId
  setTTL(seconds) {
-   this.data.e = Math.floor(Date.now() / 1000) + seconds;
+   if (seconds === 0 || seconds === null || seconds === undefined) {
+     // 0 => permanent
+     this.data.e = 0;
+   } else {
+     this.data.e = Math.floor(Date.now() / 1000) + seconds;
+   }
    return this;
  }

  static parse(customId, interaction = null) {
    // ...
      // Check expiry with clock skew tolerance
      const now = Math.floor(Date.now() / 1000);
-     if (data.e) {
+     // e === 0 => permanent
+     if (typeof data.e === 'number' && data.e > 0) {
        if (now > data.e + CONFIG.CLOCK_SKEW_TOLERANCE) {
          log.debug('Custom ID expired');
          return null;
        }
      }
    // ...
  }
```

**Builder helper for permanent IDs:**

```js
export function makePermanentId(ns, action, interaction, custom = {}) {
  return new SecureCustomId(ns, action)
    .setContext(interaction)
    .setData(custom)
    .setTTL(0) // permanent
    .build();
}
```

**Security & correctness with permanent IDs:**

* Set a sane **replay policy** on the handler:

  * `replayScope: 'none'` → allow multiple presses forever (e.g., a “Refresh” button). Make your **handler idempotent**.
  * `replayScope: 'user' | 'channel'` → allow repeats but only by same user or in same channel.
  * Keep `callerOnly: true` if the control is user-bound.
* Never trust client data. Re-check **permissions, role hierarchy**, and **message/channel** each click.
* If an action is destructive (e.g., “delete”), **record state** and refuse subsequent attempts (idempotency via DB).

**Example: a permanent “Open Panel” button**

```js
router.button('panel:open', {
  defer: 'update',
  replayScope: 'none',     // can be pressed any time
  callerOnly: false,
  persistent: false,
  async execute(interaction) {
    // Always re-check perms
    const me = interaction.guild?.members?.me;
    const canWrite = me?.permissionsIn(interaction.channelId)?.has('SendMessages');
    if (!canWrite) return interaction.followUp({ content: 'No perms here.', ephemeral: true });

    // Do your thing (idempotent)
    await interaction.editReply({ content: 'Panel opened.', components: /* rows */ [] });
  }
});

// building the button
const id = makePermanentId('panel', 'open', interaction, { section: 'main' });
```

### Option B — **Stateless + Server-Side State** (also permanent)

Instead of encoding “who/where/when” in the ID, encode only **routing + a minimal key** (e.g., `messageId`). The handler loads full state from DB **by message** and then acts. This is effectively permanent too.

* Set `replayScope: 'none'` and **do all gating server-side**:

  * Verify actor perms (& hierarchy utilities you already have).
  * Check that the message is still **attached to the resource** you think it is.
  * Enforce idempotency (e.g., if “claimed”, ignore further presses).

This approach looks like:

```js
const id = makePermanentId('ticket', 'claim', interaction, { mid: message.id });

router.button('ticket:claim', {
  defer: 'update',
  replayScope: 'none',
  async execute(interaction, ctx) {
    const { mid } = ctx.parsed.data.custom;
    // Load ticket by message id
    const ticket = await loadTicketByMessageId(mid);
    if (!ticket) return interaction.followUp({ content: 'Not found.', ephemeral: true });

    // Gate & idempotency
    if (ticket.claimed_by) return interaction.followUp({ content: 'Already claimed.', ephemeral: true });

    await claimTicket(ticket, interaction.user.id);
    await interaction.editReply({ content: `Claimed by <@${interaction.user.id}>` });
  }
});
```

---

## When to Use Which Pattern

| Use case                                                      | Recommended                                            |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| “Make a move”, “Submit”, actions that should be used **once** | Expiring ID (`replayScope:'id'`)                       |
| “Refresh”, “Open Panel”, “View Help” – safe to click any time | Permanent ID + `replayScope:'none'`                    |
| Admin dashboards that must survive restarts                   | Permanent ID + **strict server-side checks**           |
| Game boards that need turn state after deploy                 | Refresh-on-use or refresh-on-ready **+ persistent DB** |

---

## Refresh Patterns

Even for permanent IDs, it’s nice UX to **refresh** the components with newly minted IDs (or to reflect state).

### Refresh on Use

Inside your handler, after you process the click, `editReply` with **freshly built IDs** (or with updates like “It’s X’s turn”).

### Refresh on Ready (rehydrate after deploy)

On `ready`, scan a small set of rows in `persistent_components` (non-expired) and **rebuild** the component rows with fresh signed IDs. This prevents users from pressing very old IDs that your code has changed semantics for.

```js
// pseudo: run in a safe batch, rate-limit yourself
const { rows } = await query(`
  SELECT message_id, channel_id, component_type, component_data
  FROM persistent_components
  WHERE expires_at > NOW()
  LIMIT 200
`);

for (const r of rows) {
  const ch = await client.channels.fetch(r.channel_id).catch(() => null);
  const msg = await ch?.messages.fetch(r.message_id).catch(() => null);
  if (!msg) continue;

  const rowsNew = rebuildComponents(r.component_type, r.component_data /* -> build fresh IDs */);
  await msg.edit({ components: rowsNew }).catch(() => {});
}
```

---

## Persistence Table

The schema included in this repo:

```sql
CREATE TABLE IF NOT EXISTS persistent_components (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  guild_id        TEXT,
  component_type  TEXT NOT NULL,   -- namespace:action (unversioned)
  component_key   TEXT NOT NULL,   -- stable dedup key per component instance
  component_data  JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(component_data) = 'object'),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_count      INTEGER DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  last_used_by    TEXT,
  UNIQUE(message_id, component_key)
);
```

> You only need this if you want the **rehydrate / analytics / repair** features. For truly **stateless permanent** IDs, you can skip `persistent: true` entirely.

---

## Handler Options (recap)

* `defer`: `'auto' | 'reply' | 'update' | 'none'`
  Use `'update'` for message components.
* `replayScope`: `'id' | 'user' | 'channel' | 'none'`
  For non-expiring, prefer `'none'` plus robust server-side checks.
* `callerOnly`: `true` → only the original clicker can use it (or the user encoded in ID).
* `persistent`: `true` → store metadata for that message’s component instance (rehydration/audit).

---

## Security Checklist for Non-Expiring Components

* ✅ Always re-check **permissions/role hierarchy** on click (you already have utilities for this).
* ✅ Make handlers **idempotent** (use DB flags to ensure one-time actions don’t repeat).
* ✅ For sensitive actions, **encode minimal info** in the ID and **load all state** by message ID or a stable DB key.
* ✅ Consider limited **replayScope** (`user` / `channel`) when “forever multi-use” isn’t required.

---

## Examples

### Permanent “Help” button

```js
router.button('help:open', {
  defer: 'update',
  replayScope: 'none',
  async execute(interaction) {
    await interaction.editReply({
      content: 'Here’s how to use the bot…',
      components: []
    });
  }
});

// build
const id = makePermanentId('help', 'open', interaction);
```

### Permanent admin panel (role-gated)

```js
router.button('admin:panel', {
  defer: 'update',
  replayScope: 'none',
  async execute(interaction) {
    const isMod = interaction.member.permissions.has('ManageGuild');
    if (!isMod) return interaction.followUp({ content: 'Nope.', ephemeral: true });

    await interaction.editReply({ content: 'Admin panel', components: buildAdminRows(interaction) });
  }
});
```

---

## Migration Notes

* Existing expiring buttons keep working.
* For **non-expiring**: add `setTTL(0)` support (as shown), then use `makePermanentId` where needed and pick the right `replayScope`.

---

## Troubleshooting

* **“Unknown interaction”**: the interaction token expired before we deferred/replied—make sure handlers call the router’s defer strategy or respond quickly.
* **“This action was already used”**: anti-replay denied it. Use `replayScope:'none'` (or another scope) for permanent controls, and make your handler idempotent.

---

## See Also

* `src/components/ComponentRouter.js` — Router internals.
* `src/components/init.js` — Initialization, cleanup, optional legacy loader.
* `src/components/games/tttComponent.js` — Example handler module.
* `src/utils/helpers/persistence.js` — `componentKey` helper.
* `src/core/db/schema.sql` — DB schema (ensure the `persistent_components` table exists if you want rehydration).

---
