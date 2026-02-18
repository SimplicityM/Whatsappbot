// server/utils/sessionCleanup.js
const Session = require('../models/Session');

/**
 * Clean up orphaned or stuck sessions
 */
async function cleanupOrphanedSessions() {
    try {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        
        // Find sessions stuck in waiting_qr for more than 5 minutes
        const orphanedSessions = await Session.find({
            status: 'waiting_qr',
            createdAt: { $lt: fiveMinutesAgo }
        });

        if (orphanedSessions.length > 0) {
            console.log(`🧹 Found ${orphanedSessions.length} orphaned sessions`);
            
            for (const session of orphanedSessions) {
                await Session.findByIdAndUpdate(session._id, {
                    status: 'failed',
                    errorMessage: 'Session creation timeout - please try again',
                    updatedAt: new Date()
                });
            }
            
            console.log(`✅ Cleaned up ${orphanedSessions.length} orphaned sessions`);
        }
    } catch (error) {
        console.error('❌ Session cleanup error:', error);
    }
}

// Run cleanup every 2 minutes
function startSessionCleanup() {
    // setInterval(cleanupOrphanedSessions, 2 * 60 * 1000);
    cleanupOrphanedSessions(); // Run immediately on start
    console.log('🧹 Session cleanup job started');
}

module.exports = { startSessionCleanup, cleanupOrphanedSessions };