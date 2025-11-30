const express = require('express');
const User = require('../models/User');
const Session = require('../models/Session');
const { authenticate, checkSubscription } = require('../../middleware/auth');
const router = express.Router();

// Get user dashboard data
router.get('/dashboard', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password');
        const session = await Session.findOne({ userId: user._id }).sort({ createdAt: -1 });

        const dashboardData = {
            user: {
                fullName: user.fullName,
                email: user.email,
                subscription: user.subscription,
                subscriptionExpiry: user.subscriptionExpiry,
                status: user.status,
                paymentStatus: user.paymentStatus,
                usage: user.usage,
                isSubscriptionActive: user.isSubscriptionActive(),
                subscriptionLimits: user.getSubscriptionLimits()
            },
            session: session ? {
                sessionId: session.sessionId,
                status: session.status,
                whatsappNumber: session.whatsappNumber,
                connectedAt: session.connectedAt,
                lastActive: session.lastActive,
                uptime: session.getUptime(),
                usage: session.usage,
                qrCode: session.qrCode,
                isQRExpired: session.isQRExpired()
            } : null,
            stats: {
                commandsUsed: user.usage.commandsUsed,
                groupsTagged: user.usage.groupsTagged,
                contactsSaved: user.usage.contactsSaved,
                messagesProcessed: user.usage.messagesProcessed,
                sessionUptime: session ? session.getUptime() : 0
            }
        };

        res.json({
            success: true,
            data: dashboardData
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching dashboard data.'
        });
    }
});

// Connect WhatsApp (create new session)
router.post('/connect-whatsapp', authenticate, checkSubscription, async (req, res) => {
    try {
        const user = req.user;

        // Check if user already has an active session
        const existingSession = await Session.findOne({ 
            userId: user._id, 
            status: { $in: ['connecting', 'connected'] }
        });

        if (existingSession) {
            return res.status(400).json({
                success: false,
                message: 'You already have an active WhatsApp session.',
                data: { sessionId: existingSession.sessionId }
            });
        }

        // Check subscription limits
        const limits = user.getSubscriptionLimits();
        if (limits.sessions !== -1) {
            const userSessions = await Session.countDocuments({ 
                userId: user._id,
                status: 'connected'
            });

            if (userSessions >= limits.sessions) {
                return res.status(403).json({
                    success: false,
                    message: `Session limit reached. Your ${user.subscription} plan allows ${limits.sessions} sessions.`
                });
            }
        }

        // Generate unique session ID
        const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

        // Create new session
        const session = new Session({
            sessionId,
            userId: user._id,
            status: 'connecting'
        });

        await session.save();

        // Update user session ID
        user.sessionId = sessionId;
        await user.save();

        // Here you would integrate with your bot system to create the actual WhatsApp session
        // For now, we'll simulate it
        try {
            // Call your bot API to create session
            // const botResponse = await createBotSession(sessionId, user._id);
            
            // Simulate QR code generation
            setTimeout(async () => {
                try {
                    const qrCode = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`; // Placeholder
                    session.qrCode = qrCode;
                    session.qrCodeExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
                    await session.save();
                } catch (err) {
                    console.error('Error updating QR code:', err);
                }
            }, 2000);

        } catch (botError) {
            console.error('Bot integration error:', botError);
            session.status = 'error';
            session.errorMessage = 'Failed to create bot session';
            await session.save();
        }

        res.json({
            success: true,
            message: 'WhatsApp connection initiated. QR code will be generated shortly.',
            data: {
                sessionId: session.sessionId,
                status: session.status
            }
        });

    } catch (error) {
        console.error('Connect WhatsApp error:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating WhatsApp connection.'
        });
    }
});

// Get session status
router.get('/session-status', authenticate, async (req, res) => {
    try {
        const session = await Session.findOne({ userId: req.user._id }).sort({ createdAt: -1 });

        if (!session) {
            return res.json({
                success: true,
                data: { status: 'no_session' }
            });
        }

        res.json({
            success: true,
            data: {
                sessionId: session.sessionId,
                status: session.status,
                whatsappNumber: session.whatsappNumber,
                qrCode: session.qrCode,
                isQRExpired: session.isQRExpired(),
                connectedAt: session.connectedAt,
                lastActive: session.lastActive,
                uptime: session.getUptime(),
                usage: session.usage,
                errorMessage: session.errorMessage
            }
        });

    } catch (error) {
        console.error('Session status error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching session status.'
        });
    }
});

// Refresh QR code
router.post('/refresh-qr', authenticate, async (req, res) => {
    try {
        const session = await Session.findOne({ 
            userId: req.user._id,
            status: 'connecting'
        }).sort({ createdAt: -1 });

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'No active connection session found.'
            });
        }

        // Here you would call your bot API to refresh QR code
        // For now, simulate it
        const qrCode = `data:image/png;base64,${Buffer.from(Date.now().toString()).toString('base64')}`;
        session.qrCode = qrCode;
        session.qrCodeExpiry = new Date(Date.now() + 5 * 60 * 1000);
        await session.save();

        res.json({
            success: true,
            message: 'QR code refreshed successfully.',
            data: {
                qrCode: session.qrCode,
                expiresAt: session.qrCodeExpiry
            }
        });

    } catch (error) {
        console.error('Refresh QR error:', error);
        res.status(500).json({
            success: false,
            message: 'Error refreshing QR code.'
        });
    }
});

// Disconnect WhatsApp
router.post('/disconnect-whatsapp', authenticate, async (req, res) => {
    try {
        const session = await Session.findOne({ 
            userId: req.user._id,
            status: { $in: ['connecting', 'connected'] }
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'No active session found.'
            });
        }

        // Here you would call your bot API to disconnect session
        // For now, simulate it
        await session.markDisconnected('User requested disconnection');

        // Clear user session ID
        req.user.sessionId = null;
        await req.user.save();

        res.json({
            success: true,
            message: 'WhatsApp disconnected successfully.'
        });

    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({
            success: false,
            message: 'Error disconnecting WhatsApp.'
        });
    }
});

// Get user usage statistics
router.get('/usage', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        const sessions = await Session.find({ userId: user._id });

        const totalUsage = sessions.reduce((acc, session) => {
            acc.commandsExecuted += session.usage.commandsExecuted;
            acc.messagesProcessed += session.usage.messagesProcessed;
            acc.groupsTagged += session.usage.groupsTagged;
            return acc;
        }, { commandsExecuted: 0, messagesProcessed: 0, groupsTagged: 0 });

        const limits = user.getSubscriptionLimits();

        res.json({
            success: true,
            data: {
                usage: {
                    ...user.usage,
                    ...totalUsage
                },
                limits,
                subscription: user.subscription,
                subscriptionExpiry: user.subscriptionExpiry,
                isSubscriptionActive: user.isSubscriptionActive()
            }
        });

    } catch (error) {
        console.error('Usage stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching usage statistics.'
        });
    }
});

// Update user subscription
router.put('/subscription', authenticate, async (req, res) => {
    try {
        const { subscription } = req.body;
        const validSubscriptions = ['starter', 'professional', 'business', 'enterprise'];

        if (!validSubscriptions.includes(subscription)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid subscription type.'
            });
        }

        req.user.subscription = subscription;
        req.user.subscriptionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
        await req.user.save();

        res.json({
            success: true,
            message: 'Subscription updated successfully.',
            data: {
                subscription: req.user.subscription,
                subscriptionExpiry: req.user.subscriptionExpiry,
                limits: req.user.getSubscriptionLimits()
            }
        });

    } catch (error) {
        console.error('Update subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating subscription.'
        });
    }
});

// Get user's available commands
router.get('/commands', authenticate, async (req, res) => {
    try {
        const User = require('../models/User');
        const CommandGrant = require('../../models/CommandGrant');
        const { subscriptionPlans } = require('../server');
        
        const user = await User.findById(req.user.id);
        const plan = subscriptionPlans[user.subscription] || subscriptionPlans.free;
        
        // Get plan commands
        const planCommands = getPlanCommandDetails(plan.allowedCommands);
        
        // Get custom granted commands
        let customGrants = [];
            try {
            customGrants = await CommandGrant.find({
                $and: [
                {
                    $or: [
                    { userId: req.user.id, isActive: true },
                    { planType: user.subscription, isActive: true }
                    ]
                },
                {
                    $or: [
                    { expiresAt: null },
                    { expiresAt: { $gt: new Date() } }
                    ]
                }
                ]
            }).lean();
            } catch (err) {
            console.error('CommandGrant find error (non-fatal):', err && err.message ? err.message : err);
            // return empty array as fallback so UI doesn't fail
            customGrants = [];
            }

        
        res.json({
            success: true,
            data: {
                planName: plan.name,
                planCommands: planCommands,
                customCommands: customGrants
            }
        });
    } catch (error) {
        console.error('Error fetching commands:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching commands'
        });
    }
});

// Get user notifications
router.get('/notifications', authenticate, async (req, res) => {
    try {
        const Notification = require('../../models/Notification');
        
        const notifications = await Notification.find({
            userId: req.user.id
        })
        .sort({ createdAt: -1 })
        .limit(50);
        
        const unreadCount = await Notification.countDocuments({
            userId: req.user.id,
            isRead: false
        });
        
        res.json({
            success: true,
            data: {
                notifications,
                unreadCount
            }
        });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching notifications'
        });
    }
});

// Mark notification as read
router.put('/notifications/:id/read', authenticate, async (req, res) => {
    try {
        const Notification = require('../../models/Notification');
        
        await Notification.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.id },
            { isRead: true, readAt: new Date() }
        );
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error updating notification'
        });
    }
});

// Helper function
function getPlanCommandDetails(allowedCommands) {
    const commandDetails = {
        ping: {
            name: 'ping',
            description: 'Check if bot is online',
            usage: '!ping',
            category: 'Basic'
        },
        help: {
            name: 'help',
            description: 'Show available commands',
            usage: '!help',
            category: 'Basic'
        },
        tag: {
            name: 'tag',
            description: 'Tag all members in a group',
            usage: '!tag [message]',
            category: 'Group'
        },
        tagexcept: {
            name: 'tagexcept',
            description: 'Tag all except specified members',
            usage: '!tagexcept @user1 @user2 [message]',
            category: 'Group'
        },
        list: {
            name: 'list',
            description: 'List all group members',
            usage: '!list',
            category: 'Group'
        },
        broadcast: {
            name: 'broadcast',
            description: 'Send message to multiple groups',
            usage: '!broadcast [message]',
            category: 'Messaging'
        },
        auto_reply: {
            name: 'auto_reply',
            description: 'Set up automatic replies',
            usage: '!auto_reply [keyword] [response]',
            category: 'Automation'
        },
        scheduler: {
            name: 'scheduler',
            description: 'Schedule messages',
            usage: '!scheduler [time] [message]',
            category: 'Automation'
        },
        analytics: {
            name: 'analytics',
            description: 'View usage analytics',
            usage: '!analytics',
            category: 'Statistics'
        }
    };
    
    if (allowedCommands === 'all') {
        return Object.values(commandDetails);
    }
    
    return allowedCommands.map(cmd => commandDetails[cmd]).filter(Boolean);
}

module.exports = router;