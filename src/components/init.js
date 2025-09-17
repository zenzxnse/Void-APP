// ============================================================================
// File: src/components/init.js
// Final initialization with all fixes
// ============================================================================

import createComponentRouter from './ComponentRouter.js';
import { createLogger } from '../core/logger.js';
import { query } from '../core/db/index.js';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTicTacToeComponents } from './games/tttComponent.js';

const log = createLogger({ mod: 'components:init' });

export async function initializeComponents(client) {
  const router = createComponentRouter(client);
  
  // Store on client
  client.components = router;
  
  // Register component modules
  try {
    registerTicTacToeComponents(router);
    // Add more modules here
    
  } catch (err) {
    log.error({ err }, 'Failed to register components');
    throw err;
  }
  
  // Load legacy components
  await loadLegacyComponents(router);
  
  // Clean up expired components
  await cleanupExpiredComponents();
  
  // Schedule periodic cleanup
  setInterval(() => {
    cleanupExpiredComponents().catch(err => {
      log.error({ err }, 'Component cleanup failed');
    });
  }, 3600000); // Every hour
  
  // Log statistics
  const stats = router.getDetailedStats();
  log.info({
    handlers: stats.handlers,
    total: Object.values(stats.handlers).reduce((a, b) => a + b, 0)
  }, 'Component system initialized');
  
  return router;
}

/**
 * Clean up expired components from database
 */
async function cleanupExpiredComponents() {
  try {
    const result = await query('SELECT cleanup_expired_components()');
    log.debug('Expired components cleaned up');
  } catch (err) {
    log.error({ err }, 'Failed to cleanup expired components');
  }
}

/**
 * Load legacy components with validation
 */
async function loadLegacyComponents(router) {
  const baseDir = fileURLToPath(new URL('./', import.meta.url));
  
  const dirs = [
    { path: 'buttons', type: 'button' },
    { path: 'selects', type: 'select' },
    { path: 'modals', type: 'modal' }
  ];
  
  for (const { path, type } of dirs) {
    try {
      await loadFromDirectory(router, join(baseDir, path), type);
    } catch (err) {
      log.debug({ path }, 'Legacy directory not found');
    }
  }
}

async function loadFromDirectory(router, dir, type) {
  const files = await readdir(dir);
  
  for (const file of files) {
    if (extname(file) !== '.js') continue;
    
    try {
      const mod = await import(`file://${join(dir, file)}`);
      const handler = mod.default || mod;
      
      if (!handler.execute) {
        log.warn({ file }, 'No execute function in legacy component');
        continue;
      }
      
      // Validate and extract key
      if (!handler.customId) {
        log.warn({ file }, 'No customId in legacy component');
        continue;
      }
      
      // Parse key properly
      const parts = handler.customId.split(':');
      if (parts.length < 2) {
        log.warn({ file, customId: handler.customId }, 'Invalid customId format');
        continue;
      }
      
      const key = `${parts[0]}:${parts[1]}`;
      
      // Detect type if provided
      const componentType = handler.type || type;
      
      // Register based on type
      switch (componentType) {
        case 'button':
          router.button(key, handler);
          break;
        case 'select':
        case 'string_select':
          router.stringSelect(key, handler);
          break;
        case 'user_select':
          router.userSelect(key, handler);
          break;
        case 'role_select':
          router.roleSelect(key, handler);
          break;
        case 'channel_select':
          router.channelSelect(key, handler);
          break;
        case 'modal':
          router.modal(key, handler);
          break;
        default:
          log.warn({ file, type: componentType }, 'Unknown component type');
      }
      
      log.debug({ file, key, type: componentType }, 'Migrated legacy component');
      
    } catch (err) {
      log.warn({ err, file }, 'Failed to load legacy component');
    }
  }
}
