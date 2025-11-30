// /middleware/checkDbConnection.js
const mongoose = require('mongoose');

const checkDbConnection = async (req, res, next) => {
  // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  const labels = ['disconnected', 'connected', 'connecting', 'disconnecting'];

  const waitForReady = async (timeoutMs = 3000, intervalMs = 250) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (mongoose.connection.readyState === 1) return true;
      // allow "connecting" to settle quickly
      if (mongoose.connection.readyState === 2) {
        // give it a short chance to flip to connected
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return mongoose.connection.readyState === 1;
  };

  try {
    if (mongoose.connection.readyState === 1) {
      return next();
    }

    // If we're currently connecting, wait a short time for it to finish.
    const ok = await waitForReady(3000, 250); // Wait up to 3s
    if (ok) return next();

    const state = mongoose.connection.readyState;
    const stateLabel = labels[state] || 'unknown';
    console.warn(`⚠️ DB Not Ready - ReadyState: ${state} (${stateLabel})`);

    // Suggest client retry time
    res.set('Retry-After', String(5));
    return res.status(503).json({
      success: false,
      message: 'Database connection not ready. Please try again in a few seconds.',
      debug: { readyState: state, stateLabel }
    });
  } catch (err) {
    console.error('checkDbConnection error:', err);
    // On any internal failure, better to allow request through and let route handle DB errors
    return next();
  }
};

module.exports = checkDbConnection;
