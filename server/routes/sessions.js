const express = require('express');
const User = require('../models/User');
const Session = require('../models/Session');
const { authenticate, checkSubscription } = require('../../middleware/auth');
const checkDbConnection = require('../../middleware/checkDbConnection');
const router = express.Router();

// Apply to all routes
router.use(checkDbConnection);

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
// Create new session (with comprehensive error handling)
router.post('/create', authenticate, checkSubscription, async (req, res) => {
  try {
    // 1. Check database connection
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      console.warn('❗ Create session rejected — DB not ready');
      res.set('Retry-After', '5');
      return res.status(503).json({
        success: false,
        message: 'Database connection not ready. Please try again in a moment.',
        retryAfter: 5
      });
    }

    const user = req.user;

    // 2. Check subscription limits
    const limits = user.getSubscriptionLimits();
    if (limits.sessions !== -1) {
      const userSessions = await Session.countDocuments({
        userId: user._id,
        status: { $in: ['connected', 'waiting_qr', 'connecting'] }
      });

      if (userSessions >= limits.sessions) {
        return res.status(403).json({
          success: false,
          message: `Session limit reached. Your ${user.subscription} plan allows ${limits.sessions} session(s). Please upgrade or delete an existing session.`,
          currentSessions: userSessions,
          maxSessions: limits.sessions
        });
      }
    }

    // 3. Check worker availability BEFORE creating anything
    const isWorkerAvailable = req.app.get('isWorkerAvailable');
    if (!isWorkerAvailable || !isWorkerAvailable()) {
      console.error('❌ Worker service unavailable');
      res.set('Retry-After', '30');
      return res.status(503).json({
        success: false,
        message: 'WhatsApp service is temporarily unavailable. Please try again in 30 seconds.',
        retryAfter: 30,
        code: 'WORKER_UNAVAILABLE'
      });
    }

    // 4. Generate unique session ID
    const sessionId = `session-${user._id}-${Date.now()}`;

    console.log('🔄 API: Creating session for user:', user._id);
    console.log('📱 Session ID:', sessionId);

    // 5. Use the enhanced createWhatsAppSession function
    const { createWhatsAppSession } = require('../server');
    await createWhatsAppSession(user._id, sessionId);

    console.log('✅ API: Session created successfully');

    return res.json({
      success: true,
      data: { 
        sessionId,
        status: 'waiting_qr',
        message: 'Session created. Please wait for QR code.'
      }
    });

  } catch (error) {
    console.error('❌ Create session error:', error.message);
    
    // Determine appropriate status code and message
    let statusCode = 500;
    let message = 'Failed to create session';
    let retryAfter = null;

    if (error.message.includes('Worker service is not available')) {
      statusCode = 503;
      message = error.message;
      retryAfter = 30;
    } else if (error.message.includes('Worker did not respond')) {
      statusCode = 504;
      message = 'Session creation timed out. Please try again.';
      retryAfter = 10;
    } else if (error.message.includes('User not found')) {
      statusCode = 404;
      message = 'User not found';
    } else {
      message = error.message || message;
    }

    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
    }

    return res.status(statusCode).json({
      success: false,
      message,
      retryAfter,
      code: error.code || 'SESSION_CREATE_ERROR'
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