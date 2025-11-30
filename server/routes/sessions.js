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
// Create new session (improved)
router.post('/create', authenticate, checkSubscription, async (req, res) => {
  try {
    // local DB ready guard (in addition to middleware)
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      const retrySeconds = 5;
      res.set('Retry-After', String(retrySeconds));
      console.warn('❗ Create session rejected — DB not ready (create route)');
      return res.status(503).json({
        success: false,
        message: 'Database connection not ready. Please try again in a moment.'
      });
    }

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

    // Create a DB record first (status waiting_qr)
    const newSession = new Session({
      userId: user._id,
      sessionId,
      status: 'waiting_qr',
      subscriptionAtTime: user.subscription,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await newSession.save();

    // Ask worker to create the actual WhatsApp session
    // If worker not connected, mark DB record as failed and return error
    const workerSocket = req.app.get('workerSocket');
    if (!workerSocket || !workerSocket.connected) {
      // mark as failed in DB and return 503 so UI knows to retry later
      await Session.findByIdAndUpdate(newSession._id, {
        status: 'failed',
        errorMessage: 'Worker service not connected',
        updatedAt: new Date()
      });
      const retrySeconds = 10;
      res.set('Retry-After', String(retrySeconds));
      return res.status(503).json({
        success: false,
        message: 'Worker service is not connected. Please try again later.'
      });
    }

    // Ask worker to create — keep same timeout as server.js createWhatsAppSession
    const ack = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker did not respond in time')), 20000);
      workerSocket.emit('worker:create_session', { userId: user._id, sessionId }, (err, result) => {
        clearTimeout(timeout);
        if (err) return reject(new Error(String(err)));
        resolve(result);
      });
    });

    console.log('✅ API: Worker acked create_session:', ack);

    return res.json({
      success: true,
      data: { sessionId },
      message: 'Session created successfully'
    });

  } catch (error) {
    console.error('❌ Create session error (improved handler):', error);
    // Provide the error message to help debugging, but don't leak sensitive internals
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create session'
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