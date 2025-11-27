const { Client } = require('whatsapp-web.js');
const SessionAuth = require('./models/SessionAuth');

class MongoStore {
    constructor(sessionId) {
        this.sessionId = sessionId;
    }

    async sessionExists() {
        try {
            const session = await SessionAuth.findOne({ sessionId: this.sessionId });
            return !!session;
        } catch (error) {
            console.error(`❌ [MongoStore] Error checking session existence:`, error);
            return false;
        }
    }

    async save(session) {
        try {
            const sessionData = JSON.stringify(session);
            await SessionAuth.findOneAndUpdate(
                { sessionId: this.sessionId },
                { 
                    authData: sessionData,
                    updatedAt: new Date()
                },
                { upsert: true, new: true }
            );
            console.log(`💾 [MongoStore] Saved session data for: ${this.sessionId}`);
        } catch (error) {
            console.error(`❌ [MongoStore] Failed to save session:`, error);
        }
    }

    async extract() {
        try {
            const session = await SessionAuth.findOne({ sessionId: this.sessionId });
            if (session && session.authData) {
                console.log(`✅ [MongoStore] Restored session data for: ${this.sessionId}`);
                return JSON.parse(session.authData);
            }
            console.log(`📭 [MongoStore] No session data found for: ${this.sessionId}`);
            return null;
        } catch (error) {
            console.error(`❌ [MongoStore] Failed to extract session:`, error);
            return null;
        }
    }

    async delete() {
        try {
            await SessionAuth.deleteOne({ sessionId: this.sessionId });
            console.log(`🗑️ [MongoStore] Deleted session data for: ${this.sessionId}`);
        } catch (error) {
            console.error(`❌ [MongoStore] Failed to delete session:`, error);
        }
    }
}

module.exports = MongoStore;