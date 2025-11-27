const { AuthStrategy } = require('whatsapp-web.js');
const SessionAuth = require('../models/SessionAuth');

class MongoDBAuth extends AuthStrategy {
    constructor(sessionId) {
        super();
        this.sessionId = sessionId;
    }

    async beforeBrowserInitialized() {
        // Load auth data from MongoDB before browser starts
        try {
            const sessionAuth = await SessionAuth.findOne({ sessionId: this.sessionId });
            
            if (sessionAuth && sessionAuth.authData) {
                // Restore auth data
                const authData = JSON.parse(sessionAuth.authData);
                this.authData = authData;
                console.log(`✅ Restored auth data for session: ${this.sessionId}`);
            } else {
                console.log(`📭 No auth data found for session: ${this.sessionId}`);
            }
        } catch (error) {
            console.error(`❌ Failed to load auth data for ${this.sessionId}:`, error);
        }
    }

    async logout() {
        // Delete auth data from MongoDB on logout
        try {
            await SessionAuth.deleteOne({ sessionId: this.sessionId });
            console.log(`🗑️ Deleted auth data for session: ${this.sessionId}`);
        } catch (error) {
            console.error(`❌ Failed to delete auth data for ${this.sessionId}:`, error);
        }
    }

    async destroy() {
        // Clean up on destroy
        await this.logout();
    }

    async afterAuthReady() {
        // Save auth data to MongoDB after successful authentication
        try {
            const authDataString = JSON.stringify(this.authData || {});
            
            await SessionAuth.findOneAndUpdate(
                { sessionId: this.sessionId },
                { 
                    authData: authDataString,
                    updatedAt: new Date()
                },
                { upsert: true, new: true }
            );
            
            console.log(`💾 Saved auth data for session: ${this.sessionId}`);
        } catch (error) {
            console.error(`❌ Failed to save auth data for ${this.sessionId}:`, error);
        }
    }
}

module.exports = MongoDBAuth;