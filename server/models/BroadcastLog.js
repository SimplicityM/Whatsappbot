const mongoose = require('mongoose');

const broadcastLogSchema = new mongoose.Schema({
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    message: {
        type: String,
        required: true
    },
    target: {
        type: String,
        required: true
    },
    totalTargets: {
        type: Number,
        default: 0
    },
    sent: {
        type: Number,
        default: 0
    },
    failed: {
        type: Number,
        default: 0
    },
    sentAt: {
        type: Date,
        default: Date.now
    }
});

broadcastLogSchema.index({ adminId: 1, sentAt: -1 });

module.exports = mongoose.model('BroadcastLog', broadcastLogSchema);