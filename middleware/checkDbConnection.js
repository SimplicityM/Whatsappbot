// /middleware/checkDbConnection.js
const mongoose = require('mongoose');

const checkDbConnection = async (req, res, next) => {
    const state = mongoose.connection.readyState;
    const labels = ["disconnected", "connected", "connecting", "disconnecting"];

    // If connected, allow immediately
    if (state === 1) return next();

    console.warn(`⚠️ DB Not Ready - ReadyState: ${state} (${labels[state] || 'unknown'})`);

    // ⚠️ WAIT up to 2.5 seconds for auto-reconnect instead of failing immediately
    let waited = 0;
    while (waited < 2500) {
        await new Promise(r => setTimeout(r, 250));
        if (mongoose.connection.readyState === 1) {
            console.log("🔄 DB recovered during wait. Continuing request.");
            return next();
        }
        waited += 250;
    }

    // After timeout, DB is still not ready → return 503
    res.set("Retry-After", "5");
    return res.status(503).json({
        success: false,
        message: "Database connection not ready. Please try again in a few seconds.",
        debug: {
            readyState: mongoose.connection.readyState,
            stateLabel: labels[mongoose.connection.readyState] || "unknown"
        }
    });
};

module.exports = checkDbConnection;
