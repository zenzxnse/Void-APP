// src/events/on_error.js
import { logger } from '../core/logger.js';
export default { name: 'error', once: false, execute(err) { logger.error('[CLIENT ERROR]', err); } };
