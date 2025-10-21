const express = require('express'); const User = require('../models/User'); const Session = require('../models/Session'); const { authenticateAdmin } = require('../middleware/auth'); const router = express.Router();

// Get admin dashboard stats router.get('/dashboard', authenticateAdmin, async (req, res) => { try { const totalUsers = await User.countDocuments(); const activeUsers = await User.countDocuments({ status: 'approved' }); const pendingUsers = await User.countDocuments({ status: 'pending' }); const totalSessions = await Session.countDocuments(); const activeSessions = await Session.countDocuments({ status: 'connected' }); const connectingSessions = await Session.countDocuments({ status: 'connecting' });

    // Get subscription breakdown
    const subscriptionStats = await User.aggregate([
        {
            $group: {
                _id: '$subscription',
                count: { $sum: 1 }
            }
        }
    ]);

    // Get recent activity
    const recentUsers = await User.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .select('fullName email status subscription createdAt');

    const recentSessions = await Session.find()
        .populate('userId', 'fullName email')
        .sort({ createdAt: -1 })
        .limit(10);

    // Calculate total usage
    const totalUsage = await Session.aggregate([
        {
            $group: {
                _id: null,
                totalCommands: { $sum: '$usage.commandsExecuted' },
                totalMessages: { $sum: '$usage.messagesProcessed' },
                totalGroups: { $sum: '$usage.groupsTagged' }
            }
        }
    ]);

    res.json({
        success: true,
        data: {
            stats: {
                users: {
                    total: totalUsers,
                    active: activeUsers,
                    pending: pendingUsers
                },
                sessions: {
                    total: totalSessions,
                    active: activeSessions,
                    connecting: connectingSessions
                },
                usage: totalUsage[0] || { totalCommands: 0, totalMessages: 0, totalGroups: 0 }
            },
            subscriptionStats,
            recentUsers,
            recentSessions
        }
    });

} catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({
        success: false,
        message: 'Error fetching admin dashboard data.'
    });
}
});

// Get all users with pagination router.get('/users', authenticateAdmin, async (req, res) => { try { const page = parseInt(req.query.page) || 1; const limit = parseInt(req.query.limit) || 20; const status = req.query.status; const subscription = req.query.subscription; const search = req.query.search;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (subscription) filter.subscription = subscription;
    if (search) {
        filter.$or = [
            { fullName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
        ];
    }

    const users = await User.find(filter)
        .select('-password')
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip((page - 1) * limit);

    const totalUsers = await User.countDocuments(filter);

    res.json({
        success: true,
        data: {
            users,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalUsers / limit),
                totalUsers,
                hasNextPage: page < Math.ceil(totalUsers / limit),
                hasPrevPage: page > 1
            }
        }
    });

} catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
        success: false,
        message: 'Error fetching users.'
    });
}
});

// Get user details router.get('/users/:userId', authenticateAdmin, async (req, res) => { try { const user = await User.findById(req.params.userId).select('-password'); if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }

    const sessions = await Session.find({ userId: user._id }).sort({ createdAt: -1 });

    res.json({
        success: true,
        data: {
            user,
            sessions
        }
    });

} catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({
        success: false,
        message: 'Error fetching user details.'
    });
}
});

// Approve user router.put('/users/:userId/approve', authenticateAdmin, async (req, res) => { try { const user = await User.findById(req.params.userId); if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }

    user.status = 'approved';
    await user.save();

    // Also approve their session if exists
    await Session.updateMany(
        { userId: user._id, status: 'pending_approval'

             { userId: user._id, status: 'pending_approval' },
            { 
                status: 'connected',
                approvedBy: req.user._id,
                approvedAt: new Date()
            }
        );

        res.json({
            success: true,
            message: 'User approved successfully.',
            data: { user }
        });

    } catch (error) {
        console.error('Approve user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error approving user.'
        });
    }
});

// Suspend user
router.put('/users/:userId/suspend', authenticateAdmin, async (req, res) => {
    try {
        const { reason } = req.body;
        const user = await User.findById(req.params.userId);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found.'
            });
        }

        user.status = 'suspended';
        await user.save();

        // Disconnect all user sessions
        await Session.updateMany(
            { userId: user._id, status: { $in: ['connected', 'connecting'] } },
            { 
                status: 'disconnected',
                errorMessage: reason || 'Account suspended by admin'
            }
        );

        res.json({
            success: true,
            message: 'User suspended successfully.',
            data: { user }
        });

    } catch (error) {
        console.error('Suspend user error:', error);
        res.status(500).json({
            success: false,
            message: 'Error suspending user.'
        });
    }
});

// Update user subscription
router.put('/users/:userId/subscription', authenticateAdmin, async (req, res) => {
    try {
        const { subscription, expiryDate } = req.body;
        const validSubscriptions = ['starter', 'professional', 'business', 'enterprise'];

        if (!validSubscriptions.includes(subscription)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid subscription type.'
            });
        }

        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found.'
            });
        }

        user.subscription = subscription;
        if (expiryDate) {
            user.subscriptionExpiry = new Date(expiryDate);
        }
        user.paymentStatus = 'paid';
        
        await user.save();

        res.json({
            success: true,
            message: 'User subscription updated successfully.',
            data: { user }
        });

    } catch (error) {
        console.error('Update user subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating user subscription.'
        });
    }
});

// Get all sessions
router.get('/sessions', authenticateAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const status = req.query.status;

        const filter = {};
        if (status) filter.status = status;

        const sessions = await Session.find(filter)
            .populate('userId', 'fullName email subscription')
            .sort({ createdAt: -1 })
            .limit(limit)
            .skip((page - 1) * limit);

        const totalSessions = await Session.countDocuments(filter);

        res.json({
            success: true,
            data: {
                sessions,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(totalSessions / limit),
                    totalSessions,
                    hasNextPage: page < Math.ceil(totalSessions / limit),
                    hasPrevPage: page > 1
                }
            }
        });

    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching sessions.'
        });
    }
});

// Disconnect session
router.put('/sessions/:sessionId/disconnect', authenticateAdmin, async (req, res) => {
    try {
        const { reason } = req.body;
        const session = await Session.findOne({ sessionId: req.params.sessionId });

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found.'
            });
        }

        await session.markDisconnected(reason || 'Disconnected by admin');

        res.json({
            success: true,
            message: 'Session disconnected successfully.',
            data: { session }
        });

    } catch (error) {
        console.error('Disconnect session error:', error);
        res.status(500).json({
            success: false,
            message: 'Error disconnecting session.'
        });
    }
});

// Send broadcast message
router.post('/broadcast', authenticateAdmin, async (req, res) => {
    try {
        const { message, target, userIds, scheduleTime } = req.body;

        if (!message) {
            return res.status(400).json({
                success: false,
                message: 'Message is required.'
            });
        }

        let targetUsers = [];

        switch (target) {
            case 'all':
                targetUsers = await User.find({ status: 'approved' });
                break;
            case 'active':
                const activeSessions = await Session.find({ status: 'connected' });
                const activeUserIds = activeSessions.map(s => s.userId);
                targetUsers = await User.find({ _id: { $in: activeUserIds } });
                break;
            case 'subscription':
                const { subscription } = req.body;
                targetUsers = await User.find({ subscription, status: 'approved' });
                break;
            case 'custom':
                targetUsers = await User.find({ _id: { $in: userIds } });
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Invalid target type.'
                });
        }

        // Here you would integrate with your bot system to send broadcast
        // For now, we'll simulate it
        const broadcastResult = {
            totalTargets: targetUsers.length,
            sent: 0,
            failed: 0,
            scheduled: !!scheduleTime
        };

        // Simulate sending (replace with actual bot integration)
        for (const user of targetUsers) {
            try {
                // await sendBroadcastMessage(user.sessionId, message);
                broadcastResult.sent++;
            } catch (error) {
                broadcastResult.failed++;
            }
        }

        res.json({
            success: true,
            message: scheduleTime ? 'Broadcast scheduled successfully.' : 'Broadcast sent successfully.',
            data: broadcastResult
        });

    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending broadcast.'
        });
    }
});

// Get system statistics
router.get('/stats', authenticateAdmin, async (req, res) => {
    try {
        const timeframe = req.query.timeframe || 'week'; // day, week, month, year
        
        let dateFilter = {};
        const now = new Date();
        
        switch (timeframe) {
            case 'day':
                dateFilter = { createdAt: { $gte: new Date(now.setHours(0, 0, 0, 0)) } };
                break;
            case 'week':
                const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                dateFilter = { createdAt: { $gte: weekAgo } };
                break;
            case 'month':
                const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                dateFilter = { createdAt: { $gte: monthAgo } };
                break;
            case 'year':
                const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                dateFilter = { createdAt: { $gte: yearAgo } };
                break;
        }

        // User growth
        const userGrowth = await User.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Session activity
        const sessionActivity = await Session.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                    sessions: { $sum: 1 },
                    connected: {
                        $sum: { $cond: [{ $eq: ["$status", "connected"] }, 1, 0] }
                    }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Command usage
        const commandUsage = await Session.aggregate([
            {
                $group: {
                    _id: null,
                    totalCommands: { $sum: "$usage.commandsExecuted" },
                    totalMessages: { $sum: "$usage.messagesProcessed" },
                    totalGroups: { $sum: "$usage.groupsTagged" }
                }
            }
        ]);

        // Revenue stats (if payment integration is active)
        const revenueStats = await User.aggregate([
            { $match: { paymentStatus: 'paid' } },
            {
                $group: {
                    _id: '$subscription',
                    count: { $sum: 1 }
                }
            }
        ]);

        res.json({
            success: true,
            data: {
                userGrowth,
                sessionActivity,
                commandUsage: commandUsage[0] || { totalCommands: 0, totalMessages: 0, totalGroups: 0 },
                revenueStats,
                timeframe
            }
        });

    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching statistics.'
        });
    }
});

// Export users data
router.get('/export/users', authenticateAdmin, async (req, res) => {
    try {
        const format = req.query.format || 'json'; // json, csv
        const users = await User.find().select('-password -resetPasswordToken -emailVerificationToken');

        if (format === 'csv') {
            // Convert to CSV format
            const csv = users.map(user => ({
                'Full Name': user.fullName,
                'Email': user.email,
                'Subscription': user.subscription,
                'Status': user.status,
                'Payment Status': user.paymentStatus,
                'Created At': user.createdAt,
                'Last Login': user.lastLogin,
                'Commands Used': user.usage.commandsUsed,
                'Groups Tagged': user.usage.groupsTagged
            }));

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
            
            // Simple CSV conversion (in production, use a proper CSV library)
            const csvString = [
                Object.keys(csv[0]).join(','),
                ...csv.map(row => Object.values(row).join(','))
            ].join('\n');
            
            res.send(csvString);
        } else {
            res.json({
                success: true,
                data: { users }
            });
        }

    } catch (error) {
        console.error('Export users error:', error);
        res.status(500).json({
            success: false,
            message: 'Error exporting users data.'
        });
    }
});

module.exports = router;