const mongoose = require('mongoose');

const blacklistedNumberSchema = new mongoose.Schema({
    whatsappNumber: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    reason: {
        type: String,
        enum: ['trial_expired', 'banned', 'abuse', 'fraud'],
        default: 'trial_expired'
    },
    originalUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    originalEmail: String,
    trialUsedAt: Date,
    expiresAt: Date,
    canReactivate: {
        type: Boolean,
        default: false
    },
    notes: String,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('BlacklistedNumber', blacklistedNumberSchema);