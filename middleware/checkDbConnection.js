const mongoose = require('mongoose');

const checkDbConnection = (req, res, next) => {
    // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const state = mongoose.connection.readyState;
    
    if (state !== 1) {
        console.error(`❌ DB Check Failed - ReadyState: ${state} (0=disconnected, 1=connected, 2=connecting, 3=disconnecting)`);
        
        return res.status(503).json({
            success: false,
            message: 'Database connection not ready. Please try again in a moment.',
            debug: {
                readyState: state,
                stateLabel: ['disconnected', 'connected', 'connecting', 'disconnecting'][state]
            }
        });
    }
    
    next();
};

module.exports = checkDbConnection;