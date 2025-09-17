import { logger } from '../core/logger.js';
export default { name: 'warn', once: false, execute(msg) { logger.warn('[CLIENT WARN]', msg); } };