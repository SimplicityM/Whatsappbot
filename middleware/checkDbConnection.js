const mongoose = require('mongoose');

const checkDbConnection = (req, res, next) => {
    // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const state = mongoose.connection.readyState;
    const labels = ['disconnected', 'connected', 'connecting', 'disconnecting'];

    if (state !== 1) {
        const stateLabel = labels[state] || 'unknown';

        console.warn(`⚠️  DB Not Ready - ReadyState: ${state} (${stateLabel})`);

        // Tell the client when to retry
        const retrySeconds = 5;
        res.set('Retry-After', String(retrySeconds));

        return res.status(503).json({
            success: false,
            message: 'Database connection not ready. Please try again in a few seconds.',
            debug: {
                readyState: state,
                stateLabel
            }
        });
    }

    // DB ready → proceed
    return next();
};

module.exports = checkDbConnection;
