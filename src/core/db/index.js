import { Pool } from 'pg';
import { createLogger } from '../logger.js';

const log = createLogger({ mod: 'db' });

// --- Configuration with validation ---
class DatabaseConfig {
  constructor(env = process.env) {
    // Default for local development
    const defaultUrl = 'postgres://void:voidpassword@localhost:5432/voiddb';
    
    this.url = env.DATABASE_URL || defaultUrl;
    this.ssl = this.parseSSL(env.PGSSL);
    this.maxConnections = this.parseNumber(env.PG_MAX, 10, 1, 100);
    this.idleTimeoutMs = this.parseNumber(env.PG_IDLE_MS, 30000, 1000, 300000);
    this.connectionTimeoutMs = this.parseNumber(env.PG_CONN_MS, 5000, 1000, 30000);
    this.statementTimeout = this.parseNumber(env.PG_STATEMENT_TIMEOUT, 30000, 1000, 120000);
    this.queryTimeout = this.parseNumber(env.PG_QUERY_TIMEOUT, 30000, 1000, 120000);
    
    // Validation
    if (!this.url) {
      log.fatal('DATABASE_URL is not configured');
      throw new Error('DATABASE_URL is required');
    }
    
    // Parse and validate connection string
    try {
      const parsed = new URL(this.url);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch (err) {
      log.fatal({ err }, 'Invalid DATABASE_URL format');
      throw new Error('DATABASE_URL must be a valid PostgreSQL connection string');
    }
  }
  
  parseSSL(value) {
    if (!value) return false;
    const str = String(value).toLowerCase().trim();
    // Support various truthy values
    return ['true', '1', 'yes', 'on', 'require'].includes(str);
  }
  
  parseNumber(value, defaultVal, min, max) {
    const num = Number(value) || defaultVal;
    return Math.max(min, Math.min(max, num));
  }
  
  toPoolConfig() {
    const config = {
      connectionString: this.url,
      max: this.maxConnections,
      idleTimeoutMillis: this.idleTimeoutMs,
      connectionTimeoutMillis: this.connectionTimeoutMs,
      statement_timeout: this.statementTimeout,
      query_timeout: this.queryTimeout,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    };
    
    // SSL configuration
    if (this.ssl) {
      config.ssl = {
        rejectUnauthorized: process.env.NODE_ENV === 'production',
        // Allow self-signed certs in development
        ...(process.env.PGSSL_CA && { ca: process.env.PGSSL_CA }),
        ...(process.env.PGSSL_CERT && { cert: process.env.PGSSL_CERT }),
        ...(process.env.PGSSL_KEY && { key: process.env.PGSSL_KEY }),
      };
    }
    
    return config;
  }
}

// --- Pool Management ---
class DatabasePool {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.isShuttingDown = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 30;
    
    // Track query stats
    this.stats = {
      totalQueries: 0,
      totalErrors: 0,
      slowQueries: 0,
      activeConnections: 0,
      waitingCount: 0,
    };
  }
  
  async init() {
    if (this.pool) {
      log.warn('Database pool already initialized');
      return;
    }
    
    const poolConfig = this.config.toPoolConfig();
    this.pool = new Pool(poolConfig);
    
    // Set up event handlers
    this.setupEventHandlers();
    
    // Wait for connection
    await this.waitForReady();
    
    // Apply session defaults
    await this.applySessionDefaults();
    
    log.info({
      max: this.config.maxConnections,
      ssl: this.config.ssl,
    }, 'Database pool initialized');
  }
  
  setupEventHandlers() {
    this.pool.on('error', (err, client) => {
      log.error({ err }, 'Unexpected pool error on idle client');
      this.stats.totalErrors++;
    });
    
    this.pool.on('connect', (client) => {
      this.stats.activeConnections++;
      log.debug('New client connected to pool');
    });
    
    this.pool.on('remove', (client) => {
      this.stats.activeConnections--;
      log.debug('Client removed from pool');
    });
    
    // Track pool statistics
    if (process.env.NODE_ENV !== 'production') {
      setInterval(() => {
        const { totalCount, idleCount, waitingCount } = this.pool;
        this.stats.waitingCount = waitingCount;
        log.debug({
          total: totalCount,
          idle: idleCount,
          waiting: waitingCount,
          stats: this.stats,
        }, 'Pool statistics');
      }, 60000); // Every minute in development
    }
  }
  
  async waitForReady(attempts = this.maxConnectionAttempts, delayMs = 1000) {
    let lastErr;
    
    for (let i = 1; i <= attempts; i++) {
      if (this.isShuttingDown) {
        throw new Error('Shutdown in progress');
      }
      
      try {
        await this.pool.query('SELECT 1');
        this.connectionAttempts = 0;
        return;
      } catch (err) {
        lastErr = err;
        this.connectionAttempts = i;
        
        if (i === 1) {
          log.warn({ err: err.message, attempt: i, maxAttempts: attempts }, 
            'Database not ready, retrying...');
        } else if (i % 5 === 0) {
          log.warn({ attempt: i, maxAttempts: attempts }, 
            'Still waiting for database...');
        }
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    log.fatal({ err: lastErr, attempts }, 'Failed to connect to database');
    throw new Error(`Database connection failed after ${attempts} attempts: ${lastErr.message}`);
  }
  
async applySessionDefaults() {
  try {
    // Set timezone to UTC for consistency
    await this.pool.query("SET TIME ZONE 'UTC'");
    
    // Set application name for debugging
    // Note: Can't use parameters with SET, must escape manually
    const appName = (process.env.APP_NAME || 'void-bot').replace(/'/g, "''");
    await this.pool.query(`SET application_name TO '${appName}'`);
    
    // Additional session settings
    if (process.env.NODE_ENV === 'production') {
      // More aggressive timeouts in production
      await this.pool.query('SET statement_timeout TO 30000'); // 30s
      await this.pool.query('SET lock_timeout TO 10000'); // 10s
    }
    
    log.debug('Session defaults applied');
  } catch (err) {
    log.warn({ err }, 'Failed to apply some session defaults');
  }
}
  
  async query(text, params) {
    if (this.isShuttingDown) {
      throw new Error('Database is shutting down');
    }
    
    if (!this.pool) {
      throw new Error('Database not initialized. Call initDb() first.');
    }
    
    const start = Date.now();
    
    try {
      const result = await this.pool.query(text, params);
      
      const duration = Date.now() - start;
      this.stats.totalQueries++;
      
      // Log slow queries
      if (duration > 1000) {
        this.stats.slowQueries++;
        log.warn({ query: text.slice(0, 100), duration }, 'Slow query detected');
      }
      
      return result;
    } catch (err) {
      this.stats.totalErrors++;
      
      // Enhanced error logging
      log.error({
        err,
        query: text.slice(0, 200),
        params: params?.slice(0, 5), // Log first 5 params only
        duration: Date.now() - start,
      }, 'Query failed');
      
      // Add more context to error
      err.query = text;
      err.queryParams = params;
      throw err;
    }
  }
  
  async withTransaction(fn, options = {}) {
    if (this.isShuttingDown) {
      throw new Error('Database is shutting down');
    }
    
    const client = await this.pool.connect();
    const isolationLevel = options.isolationLevel || 'READ COMMITTED';
    const readonly = options.readonly || false;
    
    try {
      // Start transaction with options
      await client.query('BEGIN');
      
      if (isolationLevel !== 'READ COMMITTED') {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
      }
      
      if (readonly) {
        await client.query('SET TRANSACTION READ ONLY');
      }
      
      // Execute function with client
      const result = await fn(client);
      
      // Commit transaction
      await client.query('COMMIT');
      return result;
      
    } catch (err) {
      // Rollback on error
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error({ err: rollbackErr }, 'Rollback failed');
      }
      
      throw err;
    } finally {
      // Always release client
      client.release();
    }
  }
  
  // Shorter alias for common use
  async tx(fn, options) {
    return this.withTransaction(fn, options);
  }
  
  async getClient() {
    if (this.isShuttingDown) {
      throw new Error('Database is shutting down');
    }
    return this.pool.connect();
  }
  
  async shutdown() {
    if (this.isShuttingDown) {
      log.warn('Shutdown already in progress');
      return;
    }
    
    this.isShuttingDown = true;
    log.info('Starting database shutdown...');
    
    try {
      // Stop accepting new queries
      if (this.pool) {
        // Wait for active queries to complete (with timeout)
        const shutdownTimeout = setTimeout(() => {
          log.warn('Force closing pool due to timeout');
        }, 5000);
        
        await this.pool.end();
        clearTimeout(shutdownTimeout);
        
        log.info({
          totalQueries: this.stats.totalQueries,
          totalErrors: this.stats.totalErrors,
          slowQueries: this.stats.slowQueries,
        }, 'Database pool closed successfully');
      }
    } catch (err) {
      log.error({ err }, 'Error during database shutdown');
      throw err;
    }
  }
  
  // Health check
  async isHealthy() {
    try {
      const result = await this.query('SELECT 1 as health');
      return result.rows[0]?.health === 1;
    } catch {
      return false;
    }
  }
  
  getStats() {
    if (!this.pool) {
      return { ...this.stats, poolInitialized: false };
    }
    
    const { totalCount, idleCount, waitingCount } = this.pool;
    return {
      ...this.stats,
      poolInitialized: true,
      totalConnections: totalCount,
      idleConnections: idleCount,
      waitingRequests: waitingCount,
    };
  }
}

// --- Singleton Instance ---
const config = new DatabaseConfig();
const db = new DatabasePool(config);

// Public API
export const pool = db.pool; // For backward compatibility
export const query = (text, params) => db.query(text, params);
export const withTransaction = (fn, options) => db.withTransaction(fn, options);
export const tx = (fn, options) => db.tx(fn, options);
export const getClient = () => db.getClient();
export const initDb = () => db.init();
export const isHealthy = () => db.isHealthy();
export const getDbStats = () => db.getStats();

// Graceful shutdown handlers
async function handleShutdown(signal) {
  log.info({ signal }, 'Shutdown signal received');
  
  try {
    await db.shutdown();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'Shutdown failed');
    process.exit(1);
  }
}

// Register shutdown handlers
process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));
process.once('exit', () => {
  if (!db.isShuttingDown) {
    log.warn('Process exiting without graceful shutdown');
  }
});

// Export default for backward compatibility
export default {
  pool: db.pool,
  query,
  withTransaction,
  tx,
  initDb,
  isHealthy,
  getDbStats,
};