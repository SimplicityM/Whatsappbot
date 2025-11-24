const mongoose = require('mongoose');

const usageSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: String, // YYYY-MM-DD format
        required: true
    },
    messagesCount: {
        type: Number,
        default: 0
    },
    commandsUsed: [{
        command: String,
        timestamp: Date,
        sessionId: String
    }],
    sessionsActive: {
        type: Number,
        default: 0
    },
    groupsManaged: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

// Compound index for efficient queries
usageSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Usage', usageSchema);