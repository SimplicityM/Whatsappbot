const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
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
        enum: ['all', 'active', 'subscription', 'custom', 'groups', 'individuals'],
        required: true
    },
    targetUserIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    scheduleTime: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['scheduled', 'sending', 'completed', 'failed'],
        default: 'scheduled'
    },
    sent: {
        type: Number,
        default: 0
    },
    failed: {
        type: Number,
        default: 0
    },
    sentAt: Date,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

broadcastSchema.index({ scheduleTime: 1, status: 1 });

module.exports = mongoose.models.Broadcast || mongoose.model('Broadcast', broadcastSchema);