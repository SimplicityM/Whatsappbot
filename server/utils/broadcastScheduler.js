const Broadcast = require('../models/Broadcast');
const Session = require('../models/Session');
const BroadcastLog = require('../models/BroadcastLog');

async function processPendingBroadcasts(workerSocket) {
    try {
        const now = new Date();
        
        // Find broadcasts that are scheduled and due
        const dueBroadcasts = await Broadcast.find({
            status: 'scheduled',
            scheduleTime: { $lte: now }
        }).populate('targetUserIds');

        for (const broadcast of dueBroadcasts) {
            broadcast.status = 'sending';
            await broadcast.save();

            let sent = 0;
            let failed = 0;

            for (const user of broadcast.targetUserIds) {
                try {
                    const userSessions = await Session.find({ 
                        userId: user._id, 
                        status: 'connected' 
                    });

                    if (userSessions.length === 0) {
                        failed++;
                        continue;
                    }

                    const session = userSessions[0];
                    
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);

                        workerSocket.emit('worker:send_broadcast', {
                            sessionId: session.sessionId,
                            message: broadcast.message,
                            userId: user._id.toString()
                        }, (err, result) => {
                            clearTimeout(timeout);
                            if (err) reject(err);
                            else resolve(result);
                        });
                    });

                    sent++;
                } catch (error) {
                    console.error(`Error sending scheduled broadcast to user ${user._id}:`, error);
                    failed++;
                }
            }

            broadcast.status = 'completed';
            broadcast.sent = sent;
            broadcast.failed = failed;
            broadcast.sentAt = new Date();
            await broadcast.save();

            // Log the broadcast
            await BroadcastLog.create({
                adminId: broadcast.adminId,
                message: broadcast.message,
                target: broadcast.target,
                totalTargets: broadcast.targetUserIds.length,
                sent,
                failed,
                sentAt: new Date()
            });
        }
    } catch (error) {
        console.error('Error processing pending broadcasts:', error);
    }
}

// Run every minute
function startBroadcastScheduler(workerSocket) {
    setInterval(() => {
        processPendingBroadcasts(workerSocket);
    }, 60000); // Check every minute

    console.log('📢 Broadcast scheduler started');
}

module.exports = { startBroadcastScheduler, processPendingBroadcasts };