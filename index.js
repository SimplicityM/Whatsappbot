//import connectDB from './config/db.js';
const bot = require('./bot');
const fs = require('fs');
const path = require('path');

require('dotenv').config()

const connectDB = require('./config/db')
// Configuration
const CONFIG = {
  MAX_SESSIONS: process.env.MAX_SESSIONS || 1000,
  SESSION_DIR: './sessions',
  MEDIA_DIR: './media',
  LOG_FILE: './bot.log'
};

// Ensure required directories exist
if (!fs.existsSync(CONFIG.SESSION_DIR)) {
  fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
}

if (!fs.existsSync(CONFIG.MEDIA_DIR)) {
  fs.mkdirSync(CONFIG.MEDIA_DIR, { recursive: true });
  
 // Create placeholder files for media types if they don't exist
 const mediaTypes = {
  'image.jpg': Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), // 1x1 transparent GIF
  'audio.mp3': Buffer.alloc(0),
  'document.pdf': Buffer.alloc(0)
};

for (const [filename, content] of Object.entries(mediaTypes)) {
  const filePath = path.join(CONFIG.MEDIA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}
}


// Setup logging
const logger = {
  info: (message) => {
    const logMessage = `[${new Date().toISOString()}] INFO: ${message}`;
    console.log(logMessage);
    fs.appendFileSync(CONFIG.LOG_FILE, logMessage + '\n');
  },
  error: (message, error) => {
    const logMessage = `[${new Date().toISOString()}] ERROR: ${message} ${error ? error.stack || error : ''}`;
    console.error(logMessage);
    fs.appendFileSync(CONFIG.LOG_FILE, logMessage + '\n');
  }
};

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (err) => logger.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => logger.error('Unhandled Rejection at:', reason));

// Graceful shutdown handler
const handleShutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully...`);
  
  // Perform cleanup here if needed
  
  process.exit(0);
};

// Register shutdown handlers
process.once('SIGTERM', () => handleShutdown('SIGTERM'));
process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGHUP', () => handleShutdown('SIGHUP'));

// Main function to start the application
async function startApplication() {
  logger.info('Starting WhatsApp Web Bot...');
  
  try {
    // Connect to MongoDB
    logger.info('Connecting to MongoDB...');
    await connectDB();
    logger.info('MongoDB connection established');
    // Import and start the bot
    const bot = require('./bot');
    logger.info(`Starting bot with max ${CONFIG.MAX_SESSIONS} sessions`);
    bot.start(CONFIG.MAX_SESSIONS);
    
    logger.info('Bot started successfully');
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}



// Start the application
startApplication().catch(error => {
  console.error('Failed to start application:', error)
  process.exit(1)
})