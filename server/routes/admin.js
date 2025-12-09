const express = require('express');
const User = require('../../models/User');
const Session = require('../../models/Session');
const { authenticateAdmin } = require('../../middleware/auth');
const Contact = require('../../models/Contact');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// ✅ ADD THIS MIDDLEWARE - Check DB connection before processing
router.use((req, res, next) => {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            success: false,
            message: 'Database connection not ready. Please try again.',
            error: 'DB_NOT_READY'
        });
    }
    next();
});

// Get admin dashboard stats
router.get('/dashboard', authenticateAdmin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const activeUsers = await User.countDocuments({ status: 'approved' });
        const pendingUsers = await User.countDocuments({ status: 'pending' });
        const totalSessions = await Session.countDocuments();
        const activeSessions = await Session.countDocuments({ status: 'connected' });
        const connectingSessions = await Session.countDocuments({ status: 'waiting_qr' });

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


// Get user details
router.get('/users/:userId', authenticateAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('-password');
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found.' 
            });
        }

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

// Approve user
router.put('/users/:userId/approve', authenticateAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found.' 
            });
        }

        user.status = 'approved';
        await user.save();

        // Also approve their session if exists
        await Session.updateMany(
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
            { userId: user._id, status: { $in: ['connected', 'waiting_qr'] } },
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
        const validSubscriptions = ['free','starter', 'professional', 'business', 'enterprise']; // Updated to match your index page

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

        // Add timeout to queries
        const queryTimeout = 30000; // 30 seconds

        const sessions = await Session.find(filter)
            .populate('userId', 'fullName email subscription')
            .sort({ createdAt: -1 })
            .limit(limit)
            .skip((page - 1) * limit)
            .maxTimeMS(queryTimeout)  // ✅ Add query timeout
            .lean();  // ✅ Use lean for better performance

        const totalSessions = await Session.countDocuments(filter)
            .maxTimeMS(queryTimeout);  // ✅ Add timeout to count too

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
        
        // Better error handling
        if (error.name === 'MongooseError' && error.message.includes('buffering timed out')) {
            return res.status(503).json({
                success: false,
                message: 'Database connection timeout. Please try again in a moment.',
                error: 'DB_TIMEOUT'
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Error fetching sessions.',
            error: error.message
        });
    }
});

// Delete session
router.delete('/sessions/:sessionId', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        const session = await Session.findOneAndDelete({ sessionId });
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Session deleted successfully'
        });
        
    } catch (error) {
        console.error('Delete session error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting session'
        });
    }
});

// Restart session
router.post('/sessions/:sessionId/restart', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        const session = await Session.findOne({ sessionId });
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        session.status = 'waiting_qr';
        session.qrCode = null;
        await session.save();
        
        res.json({
            success: true,
            message: 'Session restart initiated'
        });
        
    } catch (error) {
        console.error('Restart session error:', error);
        res.status(500).json({
            success: false,
            message: 'Error restarting session'
        });
    }
});

router.get('/contacts', async (req, res) => {
    try {
        const { userId, sessionId, type } = req.query;
        
        let filter = {};
        if (userId) filter.userId = userId;
        if (sessionId) filter.sessionId = sessionId;
        if (type) filter.type = type;
        
        const contacts = await Contact.find(filter)
            .populate('userId', 'email fullName')
            .sort({ addedAt: -1 });
            
        // Group contacts by user/session
        const groupedContacts = contacts.reduce((acc, contact) => {
            const key = `${contact.userId}-${contact.sessionId}`;
            if (!acc[key]) {
                acc[key] = {
                    userId: contact.userId,
                    sessionId: contact.sessionId,
                    userInfo: contact.userId,
                    contacts: []
                };
            }
            acc[key].contacts.push(contact);
            return acc;
        }, {});
        
        res.json({
            success: true,
            data: {
                contacts: Object.values(groupedContacts),
                total: contacts.length
            }
        });
        
    } catch (error) {
        console.error('Error fetching contacts:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching contacts'
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

        session.status = 'disconnected';
        session.errorMessage = reason || 'Disconnected by admin';
        session.disconnectedAt = new Date();
        await session.save();

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

// Get all users with their sessions and payment status (with pagination)
router.get('/users', authenticateAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const status = req.query.status;
        const subscription = req.query.subscription;
        const search = req.query.search;

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

        // Get users with pagination
        const users = await User.find(filter)
            .select('fullName email whatsappNumber phone subscription subscriptionExpiry paymentStatus status lastLogin createdAt customCommands')
            .sort({ createdAt: -1 })
            .limit(limit)
            .skip((page - 1) * limit)
            .lean();

        const totalUsers = await User.countDocuments(filter);

        // Get sessions for each user
        const usersWithSessions = await Promise.all(users.map(async (user) => {
            const sessions = await Session.find({ userId: user._id })
                .select('sessionId whatsappNumber status lastActive')
                .lean();

            // Determine if subscription is active
            const now = new Date();
            const isSubscriptionActive = user.subscriptionExpiry && new Date(user.subscriptionExpiry) > now;
            const actualStatus = isSubscriptionActive && user.paymentStatus === 'paid' ? 'active' : 'inactive';

            return {
                id: user._id,
                name: user.fullName,
                email: user.email,
                phone: user.whatsappNumber || sessions[0]?.whatsappNumber || user.phone || 'N/A',
                subscription: user.subscription,
                subscriptionExpiry: user.subscriptionExpiry,
                paymentStatus: user.paymentStatus,
                status: actualStatus,
                lastActive: user.lastLogin || user.createdAt,
                sessions: sessions,
                customCommands: user.customCommands || []
            };
        }));

        res.json({
            success: true,
            users: usersWithSessions,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalUsers / limit),
                totalUsers,
                hasNextPage: page < Math.ceil(totalUsers / limit),
                hasPrevPage: page > 1,
                limit
            }
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching users'
        });
    }
});

// Update user custom commands
router.put('/users/:userId/commands', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { customCommands } = req.body;

        const user = await User.findByIdAndUpdate(
            userId,
            { $set: { customCommands } },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            message: 'Custom commands updated successfully',
            user: {
                id: user._id,
                customCommands: user.customCommands
            }
        });
    } catch (error) {
        console.error('Error updating custom commands:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating custom commands'
        });
    }
});

// Update user status
router.put('/users/:userId/status', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { status } = req.body;

        const user = await User.findByIdAndUpdate(
            userId,
            { $set: { status } },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            message: 'User status updated successfully'
        });
    } catch (error) {
        console.error('Error updating user status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating user status'
        });
    }
});

// Get blacklisted numbers
router.get('/blacklisted-numbers', authenticateAdmin, async (req, res) => {
    try {
        const BlacklistedNumber = require('../../models/BlacklistedNumber');
        
        const blacklisted = await BlacklistedNumber.find()
            .populate('originalUserId', 'fullName email')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            blacklisted
        });
    } catch (error) {
        console.error('Error fetching blacklisted numbers:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching blacklisted numbers'
        });
    }
});

// Remove from blacklist (allow reactivation)
router.delete('/blacklisted-numbers/:number', authenticateAdmin, async (req, res) => {
    try {
        const BlacklistedNumber = require('../../models/BlacklistedNumber');
        
        await BlacklistedNumber.findOneAndDelete({
            whatsappNumber: req.params.number
        });

        res.json({
            success: true,
            message: 'Number removed from blacklist'
        });
    } catch (error) {
        console.error('Error removing from blacklist:', error);
        res.status(500).json({
            success: false,
            message: 'Error removing from blacklist'
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
                const activeUserIds = [...new Set(activeSessions.map(s => s.userId.toString()))];
                targetUsers = await User.find({ _id: { $in: activeUserIds } });
                break;
            case 'subscription':
                const { subscription } = req.body;
                targetUsers = await User.find({ subscription, status: 'approved' });
                break;
            case 'custom':
                targetUsers = await User.find({ _id: { $in: userIds } });
                break;
            case 'groups':
                // Get users who have groups in their contacts
                const groupContacts = await Contact.find({ isGroup: true }).distinct('userId');
                targetUsers = await User.find({ _id: { $in: groupContacts }, status: 'approved' });
                break;
            case 'individuals':
                // Get users who have individual contacts
                const individualContacts = await Contact.find({ isGroup: false }).distinct('userId');
                targetUsers = await User.find({ _id: { $in: individualContacts }, status: 'approved' });
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Invalid target type.'
                });
        }

        const broadcastResult = {
            totalTargets: targetUsers.length,
            sent: 0,
            failed: 0,
            scheduled: !!scheduleTime
        };

        if (targetUsers.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No users found matching the target criteria.'
            });
        }

        // If scheduled, save to database for later processing
        if (scheduleTime) {
            const Broadcast = require('../models/Broadcast');
            const broadcast = new Broadcast({
                adminId: req.user.id,
                message,
                target,
                targetUserIds: targetUsers.map(u => u._id),
                scheduleTime: new Date(scheduleTime),
                status: 'scheduled'
            });
            await broadcast.save();

            return res.json({
                success: true,
                message: 'Broadcast scheduled successfully.',
                data: {
                    ...broadcastResult,
                    broadcastId: broadcast._id,
                    scheduledFor: scheduleTime
                }
            });
        }

        // Send immediately
        const workerSocket = req.app.get('workerSocket');
        
        if (!workerSocket || !workerSocket.connected) {
            return res.status(503).json({
                success: false,
                message: 'Worker service is not available. Please try again later.'
            });
        }

        // Send broadcast to each user's active sessions
        for (const user of targetUsers) {
            try {
                // Get user's active sessions
                const userSessions = await Session.find({ 
                    userId: user._id, 
                    status: 'connected' 
                });

                if (userSessions.length === 0) {
                    broadcastResult.failed++;
                    continue;
                }

                // Send to the first active session (or you can send to all)
                const session = userSessions[0];
                
                // Emit to worker to send the message
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Timeout'));
                    }, 10000);

                    workerSocket.emit('worker:send_broadcast', {
                        sessionId: session.sessionId,
                        message: message,
                        userId: user._id.toString()
                    }, (err, result) => {
                        clearTimeout(timeout);
                        if (err) {
                            console.error(`Failed to send broadcast to ${session.sessionId}:`, err);
                            reject(err);
                        } else {
                            resolve(result);
                        }
                    });
                });

                broadcastResult.sent++;
            } catch (error) {
                console.error(`Error sending to user ${user._id}:`, error);
                broadcastResult.failed++;
            }
        }

        // Log broadcast activity
        const BroadcastLog = require('../models/BroadcastLog');
        await BroadcastLog.create({
            adminId: req.user.id,
            message,
            target,
            totalTargets: broadcastResult.totalTargets,
            sent: broadcastResult.sent,
            failed: broadcastResult.failed,
            sentAt: new Date()
        });

        res.json({
            success: true,
            message: 'Broadcast sent successfully.',
            data: broadcastResult
        });

    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending broadcast.',
            error: error.message
        });
    }
});

router.post('/create-session', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }
        
        // Verify user exists
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        // Generate session ID
        const sessionId = `session-${userId}-${Date.now()}`;
        
        // Create session record
        const session = new Session({
            sessionId: sessionId,
            userId: userId,
            status: 'connecting',
            createdAt: new Date()
        });
        
        await session.save();
        
        // Start bot session
        const { createBotSession } = require('../bot.js');
        await createBotSession(userId, sessionId, req.app.get('io'));
        
        res.json({
            success: true,
            data: { 
                sessionId,
                userId,
                userEmail: user.email
            },
            message: 'Session created successfully'
        });
        
    } catch (error) {
        console.error('Admin session creation error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create session'
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
            const csvData = users.map(user => ({
                'Full Name': user.fullName,
                'Email': user.email,
                'Subscription': user.subscription,
                'Status': user.status,
                'Payment Status': user.paymentStatus,
                'Created At': user.createdAt,
                'Last Login': user.lastLogin,
                'Commands Used': user.usage?.commandsUsed || 0,
                'Groups Tagged': user.usage?.groupsTagged || 0
            }));

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
            
            // Simple CSV conversion
            const headers = Object.keys(csvData[0]).join(',');
            const rows = csvData.map(row => 
                Object.values(row).map(field => 
                    `"${String(field || '').replace(/"/g, '""')}"`
                ).join(',')
            );
            const csvString = [headers, ...rows].join('\n');
            
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

// Add this to routes/admin.js - Admin bot session creation
router.post('/sessions/create', authenticateAdmin, async (req, res) => {
    try {
        const adminId = req.user.id;
        const sessionId = `admin-bot-${adminId}-${Date.now()}`;
        
        console.log('🔄 ADMIN: Creating bot session for admin:', adminId);
        console.log('📱 ADMIN: Session ID:', sessionId);
        
        // Import createBotSession from bot.js
        const { createBotSession } = require('../bot.js');
        const io = req.app.get('io'); // Get Socket.IO instance
        
        if (!io) {
            throw new Error('Socket.IO instance not available');
        }
        
        // Create the bot session
        await createBotSession(adminId, sessionId, io);
        
        res.json({
            success: true,
            data: { sessionId, adminId },
            message: 'Admin bot session created successfully'
        });
        
    } catch (error) {
        console.error('❌ Admin bot session error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create admin bot session'
        });
    }
});

// Grant command to specific user
router.post('/grant-command/user', authenticateAdmin, async (req, res) => {
    try {
        const { userId, commandName, commandDescription, expiresAt, reason } = req.body;

        const CommandGrant = require('../../models/CommandGrant');
        const Notification = require('../../models/Notification');
        const User = require('../models/User');

        // Validate user exists
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Create command grant
        const grant = new CommandGrant({
            userId,
            commandName,
            commandDescription,
            grantedBy: req.user.id,
            grantType: 'user',
            expiresAt: expiresAt || null,
            reason: reason || 'Admin granted custom command'
        });

        await grant.save();

        // Create notification for user
        const notification = new Notification({
            userId,
            type: 'command_grant',
            title: '🎁 New Command Granted!',
            message: `You have been granted access to the "${commandName}" command. ${commandDescription || ''}`,
            data: {
                commandName,
                grantId: grant._id,
                expiresAt: expiresAt || null
            },
            priority: 'high'
        });

        await notification.save();

        console.log(`✅ Admin ${req.user.email} granted "${commandName}" to user ${user.email}`);

        res.json({
            success: true,
            message: `Command "${commandName}" granted to ${user.email}`,
            data: {
                grant,
                notification
            }
        });

    } catch (error) {
        console.error('❌ Grant command error:', error);
        res.status(500).json({
            success: false,
            message: 'Error granting command'
        });
    }
});


// Grant command to an entire plan
router.post('/grant-command/plan', authenticateAdmin, async (req, res) => {
    try {
        const { planType, commandName, commandDescription, expiresAt, reason } = req.body;

        const CommandGrant = require('../../models/CommandGrant');
        const Notification = require('../../models/Notification');
        const User = require('../models/User');

        // Validate plan type
        const validPlans = ['free', 'starter', 'professional', 'business', 'enterprise'];
        if (!validPlans.includes(planType)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid plan type'
            });
        }

        // Create command grant
        const grant = new CommandGrant({
            planType,
            commandName,
            commandDescription,
            grantedBy: req.user.id,
            grantType: 'plan',
            expiresAt: expiresAt || null,
            reason: reason || `Admin granted command to all ${planType} users`
        });

        await grant.save();

        // Fetch all plan users
        const planUsers = await User.find({ subscription: planType });

        // Notifications
        const notifications = planUsers.map(user => ({
            userId: user._id,
            type: 'plan_update',
            title: '🌟 New Command Available!',
            message: `The "${commandName}" command is now available for all ${planType} users. ${commandDescription || ''}`,
            data: {
                commandName,
                grantId: grant._id,
                planType,
                expiresAt: expiresAt || null
            },
            priority: 'medium'
        }));

        await Notification.insertMany(notifications);

        console.log(`✅ Admin ${req.user.email} granted "${commandName}" to all ${planType} users (${planUsers.length} users)`);

        res.json({
            success: true,
            message: `Command "${commandName}" granted to all ${planType} users (${planUsers.length} notified)`,
            data: {
                grant,
                usersNotified: planUsers.length
            }
        });

    } catch (error) {
        console.error('❌ Grant command to plan error:', error);
        res.status(500).json({
            success: false,
            message: 'Error granting command to plan'
        });
    }
});


// Get all command grants
router.get('/command-grants', authenticateAdmin, async (req, res) => {
    try {
        const CommandGrant = require('../../models/CommandGrant');

        const grants = await CommandGrant.find()
            .populate('userId', 'email fullName subscription')
            .populate('grantedBy', 'email fullName')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            data: { grants }
        });

    } catch (error) {
        console.error('❌ Error fetching command grants:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching command grants'
        });
    }
});


// Revoke command grant
router.delete('/command-grants/:grantId', authenticateAdmin, async (req, res) => {
    try {
        const CommandGrant = require('../../models/CommandGrant');
        const Notification = require('../../models/Notification');
        const User = require('../models/User');

        const grant = await CommandGrant.findById(req.params.grantId);

        if (!grant) {
            return res.status(404).json({
                success: false,
                message: 'Grant not found'
            });
        }

        // Deactivate instead of deleting
        grant.isActive = false;
        await grant.save();

        // If single user grant
        if (grant.userId) {
            await Notification.create({
                userId: grant.userId,
                type: 'command_grant',
                title: 'Command Access Revoked',
                message: `Access to the "${grant.commandName}" command has been revoked.`,
                data: {
                    commandName: grant.commandName,
                    grantId: grant._id
                },
                priority: 'medium'
            });

        } else if (grant.planType) {
            // Plan-wide revocation
            const planUsers = await User.find({ subscription: grant.planType });

            const notifications = planUsers.map(user => ({
                userId: user._id,
                type: 'plan_update',
                title: 'Command Removed',
                message: `The "${grant.commandName}" command is no longer available for ${grant.planType} users.`,
                data: {
                    commandName: grant.commandName,
                    grantId: grant._id,
                    planType: grant.planType
                },
                priority: 'low'
            }));

            await Notification.insertMany(notifications);
        }

        console.log(`✅ Admin ${req.user.email} revoked command grant ${grant._id}`);

        res.json({
            success: true,
            message: 'Command grant revoked successfully'
        });

    } catch (error) {
        console.error('❌ Error revoking command grant:', error);
        res.status(500).json({
            success: false,
            message: 'Error revoking command grant'
        });
    }
});

// ---------------------------------------------
// EXPORT ALL CONTACTS (CSV)
// ---------------------------------------------
router.get('/contacts/export', authenticateAdmin, async (req, res) => {
    try {
        const contacts = await Contact.find({}).lean();

        const csvHeader = 'Name,Number,Type,User ID,Session ID,Created At\n';
        const csvRows = contacts.map(contact => {
            return `"${contact.name || ''}","${contact.number || ''}","${contact.isGroup ? 'Group' : 'Individual'}","${contact.userId}","${contact.sessionId}","${contact.createdAt}"`;
        }).join('\n');

        const csvContent = csvHeader + csvRows;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=contacts-export-${new Date().toISOString().split('T')[0]}.csv`
        );

        res.send(csvContent);

    } catch (error) {
        console.error('❌ Export error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to export contacts'
        });
    }
});


// ---------------------------------------------
// EXPORT SELECTED CONTACTS (CSV)
// ---------------------------------------------
router.post('/contacts/export', authenticateAdmin, async (req, res) => {
    try {
        const { contactIds } = req.body;

        if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No contact IDs provided'
            });
        }

        const contacts = await Contact.find({
            _id: { $in: contactIds }
        }).lean();

        const csvHeader = 'Name,Number,Type,User ID,Session ID,Created At\n';
        const csvRows = contacts.map(contact => {
            return `"${contact.name || ''}","${contact.number || ''}","${contact.isGroup ? 'Group' : 'Individual'}","${contact.userId}","${contact.sessionId}","${contact.createdAt}"`;
        }).join('\n');

        const csvContent = csvHeader + csvRows;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=selected-contacts-${new Date().toISOString().split('T')[0]}.csv`
        );

        res.send(csvContent);

    } catch (error) {
        console.error('❌ Export selected error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to export selected contacts'
        });
    }
});


// ---------------------------------------------
// DELETE SINGLE CONTACT
// ---------------------------------------------
router.delete('/contacts/:contactId', authenticateAdmin, async (req, res) => {
    try {
        const { contactId } = req.params;

        const result = await Contact.findByIdAndDelete(contactId);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        res.json({
            success: true,
            message: 'Contact deleted successfully'
        });

    } catch (error) {
        console.error('❌ Delete contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete contact'
        });
    }
});


// ---------------------------------------------
// BULK DELETE CONTACTS
// ---------------------------------------------
router.post('/contacts/bulk-delete', authenticateAdmin, async (req, res) => {
    try {
        const { contactIds } = req.body;

        if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No contact IDs provided'
            });
        }

        const result = await Contact.deleteMany({
            _id: { $in: contactIds }
        });

        res.json({
            success: true,
            message: `${result.deletedCount} contacts deleted successfully`,
            data: { deletedCount: result.deletedCount }
        });

    } catch (error) {
        console.error('❌ Bulk delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete contacts'
        });
    }
});


// ---------------------------------------------
// UPDATE CONTACT
// ---------------------------------------------
router.put('/contacts/:contactId', authenticateAdmin, async (req, res) => {
    try {
        const { contactId } = req.params;
        const { name, number } = req.body;

        const contact = await Contact.findByIdAndUpdate(
            contactId,
            {
                name,
                number,
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!contact) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        res.json({
            success: true,
            message: 'Contact updated successfully',
            data: { contact }
        });

    } catch (error) {
        console.error('❌ Update contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update contact'
        });
    }
});


// ---------------------------------------------
// ADD NEW CONTACT
// ---------------------------------------------
router.post('/contacts', authenticateAdmin, async (req, res) => {
    try {
        const { name, number, isGroup } = req.body;

        if (!name || !number) {
            return res.status(400).json({
                success: false,
                message: 'Name and number are required'
            });
        }

        const contact = new Contact({
            userId: req.user.id,
            sessionId: `admin-${req.user.id}`,
            name,
            number,
            isGroup: isGroup || false,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        await contact.save();

        res.json({
            success: true,
            message: 'Contact added successfully',
            data: { contact }
        });

    } catch (error) {
        console.error('❌ Add contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add contact'
        });
    }
});

// Re-sync contacts for all active sessions
router.post('/contacts/sync-all', authenticateAdmin, async (req, res) => {
    try {
        const Session = require('../models/Session');
        
        // Get all active sessions
        const activeSessions = await Session.find({
            status: 'connected'
        });

        if (activeSessions.length === 0) {
            return res.json({
                success: true,
                message: 'No active sessions to sync',
                data: { totalSynced: 0 }
            });
        }

        // Emit sync command to worker for each session
        const workerSocket = req.app.get('workerSocket');
        let totalSynced = 0;

        for (const session of activeSessions) {
            workerSocket.emit('sync-contacts', {
                sessionId: session.sessionId,
                userId: session.userId
            });
            totalSynced++;
        }

        res.json({
            success: true,
            message: `Sync initiated for ${totalSynced} sessions`,
            data: { totalSynced }
        });

    } catch (error) {
        console.error('❌ Sync all error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to sync contacts'
        });
    }
});

// ---------------------------------------------
// IMPORT CONTACTS FROM CSV
// ---------------------------------------------
router.post('/contacts/import', authenticateAdmin, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const contacts = [];
        const filePath = req.file.path;

        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                if (row.Name && row.Number) {
                    contacts.push({
                        userId: req.user.id,
                        sessionId: `admin-${req.user.id}`,
                        name: row.Name,
                        number: row.Number,
                        isGroup: row.Type === 'Group',
                        createdAt: new Date(),
                        updatedAt: new Date()
                    });
                }
            })
            .on('end', async () => {
                try {
                    const result = await Contact.insertMany(contacts);

                    fs.unlinkSync(filePath);

                    res.json({
                        success: true,
                        message: `Successfully imported ${result.length} contacts`,
                        data: { imported: result.length }
                    });

                } catch (dbError) {
                    console.error('❌ DB insert error:', dbError);
                    fs.unlinkSync(filePath);

                    res.status(500).json({
                        success: false,
                        message: 'Failed to save contacts to database'
                    });
                }
            })
            .on('error', (parseError) => {
                console.error('❌ CSV parse error:', parseError);
                fs.unlinkSync(filePath);

                res.status(500).json({
                    success: false,
                    message: 'Failed to parse CSV file'
                });
            });

    } catch (error) {
        console.error('❌ Import error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to import contacts'
        });
    }
});


module.exports = router;