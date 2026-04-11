const jwt = require('jsonwebtoken');
const bcrypt = require("bcrypt");
const prisma = require("../packages/database/client");

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No API key" });

  const rawKey = header.replace("Bearer ", "");
  const prefix = rawKey.split(".")[0].replace("wa_live_", "");

  const apiKey = await prisma.apiKey.findUnique({
    where: { prefix }
  });

  if (!apiKey) return res.status(401).json({ error: "Invalid key" });

  const valid = await bcrypt.compare(rawKey, apiKey.keyHash);
  if (!valid) return res.status(401).json({ error: "Invalid key" });

  req.accountId = apiKey.accountId;

  next();
}

module.exports = authenticate;

// Don't load User model at the top - get it dynamically
const getUserModel = () => {
    // Try to get from global first (if set by server.js)
    if (global.User) return global.User;
    
    // Otherwise require it (for cases where it's already loaded)
    try {
        return require('../server/models/User');
    } catch (err) {
        console.error('❌ Failed to load User model:', err.message);
        return null;
    }
};

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

// Authentication for WhatsApp Group Admins (users who connect their WhatsApp to use the bot)
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
        const User = getUserModel();
        
        if (!User) {
            return res.status(500).json({
                success: false,
                message: 'Server error: User model not loaded'
            });
        }
        
        const user = await User.findById(decoded.userId).select('-password');

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token. User not found.'
            });
        }

        // This is for WhatsApp Group Admins who use the bot
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

// Authentication for System Admin (central admin who controls everything)
const authenticateAdmin = async (req, res, next) => {
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
        const User = getUserModel();
        
        if (!User) {
            return res.status(500).json({
                success: false,
                message: 'Server error: User model not loaded'
            });
        }
        
        const user = await User.findById(decoded.userId).select('-password');

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token. User not found.'
            });
        }

        // Check if user is the SYSTEM ADMIN (central admin)
       const isSystemAdmin =
         user.email === process.env.ADMIN_EMAIL ||
        user.role === 'system_admin' ||
         user.isAdmin === true;


        if (!isSystemAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. System admin privileges required.'
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
            message: 'System admin authentication failed.'
        });
    }
};

// Check subscription status (for WhatsApp Group Admins)
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
    authenticate,        // For WhatsApp Group Admins
    authenticateAdmin,   // For System Admin
    checkSubscription,
    rateLimit
};