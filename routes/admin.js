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