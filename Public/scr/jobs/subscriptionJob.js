// src/jobs/subscriptionJob.js
// Auto-checks for expired subscriptions daily (Africa/Lagos timezone)

const cron = require('node-cron');
const moment = require('moment-timezone');
const User = require('../../models/User');
const { clients } = require('../../sessionManager');

async function checkExpiredSubscriptions(io) {
  try {
    const now = moment.tz('Africa/Lagos');
    const expiredUsers = await User.find({
      'subscription.active': true,
      'subscription.expiresAt': { $lt: now.toDate() }
    });

    for (const user of expiredUsers) {
      user.subscription.active = false;
      await user.save();

      io.to(`user-${user._id}`).emit('subscriptionExpired', {
        message: 'Subscription expired. Bot access paused until renewal.'
      });

      // Try to logout all sessions owned by this user
      for (const [sessionId, client] of clients.entries()) {
        if (client?.ownerUserId === user._id.toString()) {
          try {
            await client.sock.logout();
            clients.delete(sessionId);
            console.log(`🔒 Logged out session ${sessionId} for expired user ${user._id}`);
          } catch (err) {
            console.error(`Error logging out session ${sessionId}:`, err.message);
          }
        }
      }

      // Optionally notify via WhatsApp (from their own number)
      for (const [sessionId, client] of clients.entries()) {
        if (client?.ownerUserId === user._id.toString()) {
          try {
            await client.sock.sendMessage(client.sock.user.id, {
              text: '⚠️ *Subscription Expired*\nYour bot has been paused. Please renew your payment to reactivate your WhatsApp bot.'
            });
          } catch (err) {
            console.error('Failed to send expiry message:', err.message);
          }
        }
      }
    }

    if (expiredUsers.length > 0)
      console.log(`🕛 Subscription check: ${expiredUsers.length} users expired and were deactivated.`);
    else console.log('🕛 Subscription check: No expired users found.');
  } catch (err) {
    console.error('Subscription job error:', err.message);
  }
}

function startSubscriptionJob(io) {
  console.log('⏳ Subscription job scheduled for 00:00 Africa/Lagos daily.');
  cron.schedule('0 0 * * *', () => checkExpiredSubscriptions(io), {
    timezone: 'Africa/Lagos'
  });
}

module.exports = { startSubscriptionJob };
