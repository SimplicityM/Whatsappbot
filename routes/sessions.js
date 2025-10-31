const express = require('express');
const User = require('../models/User');
const Session = require('../models/Session');
const { authenticate, checkSubscription } = require('../middleware/auth');
const router = express.Router();

// Get user's sessions
router.get('/my-sessions', authenticate, async (req, res) => {
    try {
        const sessions = await Session.find({ userId: req.user._id })
            .sort({ createdAt: -1 });

        const sessionsData = sessions.map(session => ({
            sessionId: session.sessionId,
            status: session.status,
            phone: session.whatsappNumber,
            messageCount: session.usage.messagesProcessed || 0,
            uptime: session.getUptime(),
            createdAt: session.createdAt
        }));

        res.json({
            success: true,
            data: { sessions: sessionsData }
        });

    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching sessions.'
        });
    }
});

// Create new session
router.post('/create', authenticate, checkSubscription, async (req, res) => {
    try {
        const user = req.user;

        // Check subscription limits
        const limits = user.getSubscriptionLimits();
        if (limits.sessions !== -1) {
            const userSessions = await Session.countDocuments({ 
                userId: user._id,
                status: { $in: ['connected', 'waiting_qr', 'connecting'] }
            });

            if (userSessions >= limits.sessions) {
                return res.json({
                    success: false,
                    message: `Session limit reached. Your ${user.subscription} plan allows ${limits.sessions} sessions.`
                });
            }
        }

        // Generate unique session ID
        const sessionId = `session-${user._id}-${Date.now()}`;

        console.log('🔄 API: Creating session for user:', user._id);
        console.log('📱 Session ID:', sessionId);

        // Import the createWhatsAppSession function
        const { createWhatsAppSession } = require('../server');
        
        // Create WhatsApp session (this will handle database creation too)
        await createWhatsAppSession(user._id, sessionId);

        res.json({
            success: true,
            data: { sessionId },
            message: 'Session created successfully'
        });

    } catch (error) {
        console.error('❌ Create session error:', error);
        res.json({
            success: false,
            message: 'Failed to create session'
        });
    }
});

// Restart session
router.post('/:sessionId/restart', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await Session.findOne({ 
            sessionId,
            userId: req.user._id 
        });

        if (!session) {
            return res.json({
                success: false,
                message: 'Session not found'
            });
        }

        // Update session status - FIXED: changed from 'connecting' to 'waiting_qr'
        session.status = 'waiting_qr';
        session.errorMessage = null;
        await session.save();

        res.json({
            success: true,
            message: 'Session restart initiated'
        });

    } catch (error) {
        console.error('Restart session error:', error);
        res.json({
            success: false,
            message: 'Failed to restart session'
        });
    }
});

// Delete session
router.delete('/:sessionId', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await Session.findOne({ 
            sessionId,
            userId: req.user._id 
        });

        if (!session) {
            return res.json({
                success: false,
                message: 'Session not found'
            });
        }

        // Mark session as disconnected and delete
        await session.markDisconnected('User deleted session');
        await Session.deleteOne({ _id: session._id });

        res.json({
            success: true,
            message: 'Session deleted successfully'
        });

    } catch (error) {
        console.error('Delete session error:', error);
        res.json({
            success: false,
            message: 'Failed to delete session'
        });
    }
});

// Get session details
router.get('/:sessionId', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await Session.findOne({ 
            sessionId,
            userId: req.user._id 
        });

        if (!session) {
            return res.json({
                success: false,
                message: 'Session not found'
            });
        }

        res.json({
            success: true,
            data: { session }
        });

    } catch (error) {
        console.error('Get session error:', error);
        res.json({
            success: false,
            message: 'Error fetching session details'
        });
    }
});

// Get session status
router.get('/:sessionId/status', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await Session.findOne({ 
            sessionId,
            userId: req.user._id 
        });

        if (!session) {
            return res.json({
                success: false,
                message: 'Session not found'
            });
        }

        res.json({
            success: true,
            data: { 
                status: session.status,
                phone: session.whatsappNumber,
                uptime: session.getUptime(),
                messageCount: session.usage.messagesProcessed || 0,
                lastActivity: session.usage.lastActivity
            }
        });

    } catch (error) {
        console.error('Get session status error:', error);
        res.json({
            success: false,
            message: 'Error fetching session status'
        });
    }
});

// Update session settings
router.put('/:sessionId/settings', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { settings } = req.body;
        
        const session = await Session.findOne({ 
            sessionId,
            userId: req.user._id 
        });

        if (!session) {
            return res.json({
                success: false,
                message: 'Session not found'
            });
        }

        session.settings = { ...session.settings, ...settings };
        await session.save();

        res.json({
            success: true,
            message: 'Session settings updated successfully'
        });

    } catch (error) {
        console.error('Update session settings error:', error);
        res.json({
            success: false,
            message: 'Error updating session settings'
        });
    }
});

// Get session statistics
router.get('/:sessionId/stats', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await Session.findOne({ 
            sessionId,
            userId: req.user._id 
        });

        if (!session) {
            return res.json({
                success: false,
                message: 'Session not found'
            });
        }

        const stats = {
            messagesProcessed: session.usage.messagesProcessed || 0,
            lastActivity: session.usage.lastActivity,
            uptime: session.getUptime(),
            status: session.status,
            createdAt: session.createdAt,
            connectedAt: session.connectedAt
        };

        res.json({
            success: true,
            data: { stats }
        });

    } catch (error) {
        console.error('Get session stats error:', error);
        res.json({
            success: false,
            message: 'Error fetching session statistics'
        });
    }
});

module.exports = router;