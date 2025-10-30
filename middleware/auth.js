const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Generate JWT token
const generateToken = (userId) => {
    return jwt.sign({ userId }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    });
};

// Verify JWT token
const verifyToken = (token) => {
    return jwt.verify(token, process.env.JWT_SECRET);
};

// Authentication middleware
const authenticate = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '') || 
                     req.cookies?.token;

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Access denied. No token provided.'
            });
        }

        const decoded = verifyToken(token);
        const user = await User.findById(decoded.userId).select('-password');

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token. User not found.'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: 'Token expired. Please login again.'
            });
        }

        return res.status(401).json({
            success: false,
            message: 'Invalid token.'
        });
    }
};

// Admin authentication middleware
const authenticateAdmin = async (req, res, next) => {
    try {
        await authenticate(req, res, () => {});

        // Check if user is admin (you can modify this logic)
        if (req.user.email !== process.env.ADMIN_EMAIL && !req.user.isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Admin privileges required.'
            });
        }

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Authentication failed.'
        });
    }
};

// Check subscription status
const checkSubscription = async (req, res, next) => {
    try {
        if (!req.user.isSubscriptionActive() && req.user.paymentStatus !== 'trial') {
            return res.status(403).json({
                success: false,
                message: 'Subscription expired. Please renew your subscription.',
                code: 'SUBSCRIPTION_EXPIRED'
            });
        }

        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Error checking subscription status.'
        });
    }
};

// Rate limiting middleware
const rateLimit = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
    const requests = new Map();

    return (req, res, next) => {
        const key = req.user?.id || req.ip;
        const now = Date.now();
        const windowStart = now - windowMs;

        // Clean old entries
        const userRequests = requests.get(key) || [];
        const validRequests = userRequests.filter(time => time > windowStart);

        if (validRequests.length >= maxRequests) {
            return res.status(429).json({
                success: false,
                message: 'Too many requests. Please try again later.'
            });
        }

        validRequests.push(now);
        requests.set(key, validRequests);
        next();
    };
};

module.exports = {
    generateToken,
    verifyToken,
    authenticate,
    authenticateAdmin,
    checkSubscription,
    rateLimit
};