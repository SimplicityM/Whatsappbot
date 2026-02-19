// worker/config.js
// Centralized configuration for worker process

module.exports = {
    // ========================================
    // SESSION RESTORATION CONFIGURATION
    // ========================================
    restoration: {
        // Batch processing
        BATCH_SIZE: parseInt(process.env.RESTORE_BATCH_SIZE || '10'),
        BATCH_DELAY_MS: parseInt(process.env.RESTORE_BATCH_DELAY_MS || '2000'),
        
        // Session initialization
        SESSION_INIT_DELAY_MS: parseInt(process.env.RESTORE_SESSION_DELAY_MS || '500'),
        MAX_CONCURRENT_RESTORES: parseInt(process.env.RESTORE_MAX_CONCURRENT || '5'),
        
        // Timeouts
        PRIORITY_RESTORE_TIMEOUT_MS: parseInt(process.env.RESTORE_PRIORITY_TIMEOUT_MS || '30000'),
        REGULAR_RESTORE_TIMEOUT_MS: parseInt(process.env.RESTORE_REGULAR_TIMEOUT_MS || '60000'),
        
        // Priorities
        RECENTLY_ACTIVE_HOURS: parseInt(process.env.RESTORE_RECENT_HOURS || '24'),
        
        // Cleanup
        AUTO_CLEANUP_FAILED: process.env.RESTORE_AUTO_CLEANUP === 'true',
        CLEANUP_AFTER_DAYS: parseInt(process.env.RESTORE_CLEANUP_DAYS || '7')
    },

    // ========================================
    // MEMBER CACHE CONFIGURATION
    // ========================================
    memberCache: {
        CACHE_TTL_MS: parseInt(process.env.MEMBERS_CACHE_TTL_MS || '300000'), // 5m
        CACHE_REFRESH_AFTER_MS: parseInt(process.env.MEMBERS_CACHE_REFRESH_AFTER_MS || '240000'), // 4m
    },

    // ========================================
    // TAGGING CONFIGURATION
    // ========================================
    tagging: {
        CHUNK_SIZE: parseInt(process.env.TAG_CHUNK_SIZE || '100'), // mentions/chunk
        CONCURRENCY: parseInt(process.env.TAG_CONCURRENCY || '3'), // parallel chunk senders
        CHUNK_DELAY_MS: parseInt(process.env.TAG_CHUNK_DELAY_MS || '400'), // polite pause
        MAX_RETRIES: 3,
    },

    // ========================================
    // RATE LIMITING CONFIGURATION
    // ========================================
    rateLimit: {
        TOKENS: parseInt(process.env.RATE_LIMIT_TOKENS || '2'), // tokens per window
        WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'), // 1m
    },

    // ========================================
    // REDIS CONFIGURATION
    // ========================================
    redis: {
        ENABLED: process.env.REDIS_ENABLED !== 'false',
        URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
        CONNECT_TIMEOUT_MS: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '10000'),
    },

    // ========================================
    // WHATSAPP CLIENT CONFIGURATION
    // ========================================
    client: {
        COMMAND_PREFIX: process.env.COMMAND_PREFIX || '!',
        MAX_SESSIONS: parseInt(process.env.MAX_SESSIONS || '1000'),
    },

    // ========================================
    // PUPPETEER CONFIGURATION
    // ========================================
    puppeteer: {
        SKIP_DOWNLOAD: process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD === 'true',
        EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        HEADLESS: process.env.PUPPETEER_HEADLESS !== 'false',
        ARGS: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
};
