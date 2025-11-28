const mongoose = require('mongoose');

const checkDbConnection = (req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            success: false,
            message: 'Database connection not ready. Please try again in a moment.'
        });
    }
    next();
};

module.exports = checkDbConnection;