// src/void.dev.js
import { runShard } from './shard.js';
import { acquireLock } from './bootstrap/singleton-lock.js';

await acquireLock('manager');
runShard({ shardId: 0, shardCount: 1, managerMode: false });
