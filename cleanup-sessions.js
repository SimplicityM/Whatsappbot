// cleanup-sessions.js
const mongoose = require('mongoose');
const Session = require('./models/Session');
require('dotenv').config();

async function cleanupSessions() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsappbot');
        
        // Delete old sessions for your user
        const result = await Session.deleteMany({
            userId: '68f8cc03463c75fb02668fd1',
            status: { $in: ['waiting_qr', 'connecting', 'failed'] }
        });
        
        console.log(`✅ Cleaned up ${result.deletedCount} old sessions`);
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
}

cleanupSessions();