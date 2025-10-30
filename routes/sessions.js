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
                status: 'connected'
            });

            if (userSessions >= limits.sessions) {
                return res.json({
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

        res.json({
            success: true,
            data: { sessionId }
        });

    } catch (error) {
        console.error('Create session error:', error);
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

        // Update session status
        session.status = 'connecting';
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

module.exports = router;