const User = require('../models/User');
const BlacklistedNumber = require('../models/BlacklistedNumber');
const Session = require('../models/Session');

async function checkExpiredTrials() {
    try {
        const now = new Date();
        
        // Find users whose trial/subscription has expired
        const expiredUsers = await User.find({
            subscriptionExpiry: { $lt: now },
            paymentStatus: { $ne: 'paid' },
            exemptFromPayment: { $ne: true },
            whatsappNumber: { $exists: true, $ne: null }
        });

        for (const user of expiredUsers) {
            // Check if already blacklisted
            const existing = await BlacklistedNumber.findOne({
                whatsappNumber: user.whatsappNumber
            });

            if (!existing) {
                // Add to blacklist
                await BlacklistedNumber.create({
                    whatsappNumber: user.whatsappNumber,
                    reason: 'trial_expired',
                    originalUserId: user._id,
                    originalEmail: user.email,
                    trialUsedAt: user.createdAt,
                    expiresAt: null, // Permanent unless manually removed
                    canReactivate: false,
                    notes: `Trial expired on ${user.subscriptionExpiry}`
                });

                console.log(`🔒 Blacklisted number: ${user.whatsappNumber} (${user.email})`);

                // Disconnect all active sessions for this user
                const activeSessions = await Session.find({
                    userId: user._id,
                    status: 'connected'
                });

                for (const session of activeSessions) {
                    await Session.findByIdAndUpdate(session._id, {
                        status: 'expired',
                        errorMessage: 'Trial period ended',
                        updatedAt: new Date()
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error checking expired trials:', error);
    }
}

// Run every hour
setInterval(checkExpiredTrials, 60 * 60 * 1000);



module.exports = { checkExpiredTrials };