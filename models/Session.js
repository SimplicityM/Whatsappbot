const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    whatsappNumber: {
        type: String,
        default: null
    },
    status: {
        type: String,
        enum: ['connecting', 'connected', 'disconnected', 'error', 'pending_approval'],
        default: 'connecting'
    },
    qrCode: {
        type: String,
        default: null
    },
    qrCodeExpiry: {
        type: Date,
        default: () => new Date(Date.now() + 5 * 60 * 1000) // 5 minutes from now
    },
    connectionData: {
        clientInfo: { type: mongoose.Schema.Types.Mixed, default: null },
        batteryLevel: { type: Number, default: null },
        isCharging: { type: Boolean, default: null },
        platform: { type: String, default: null }
    },
    lastActive: {
        type: Date,
        default: Date.now
    },
    connectedAt: {
        type: Date,
        default: null
    },
    disconnectedAt: {
        type: Date,
        default: null
    },
    errorMessage: {
        type: String,
        default: null
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    approvedAt: {
        type: Date,
        default: null
    },
    usage: {
        commandsExecuted: { type: Number, default: 0 },
        messagesProcessed: { type: Number, default: 0 },
        groupsTagged: { type: Number, default: 0 },
        lastCommandAt: { type: Date, default: null }
    },
    settings: {
        autoReconnect: { type: Boolean, default: true },
        maxRetries: { type: Number, default: 3 },
        commandPrefix: { type: String, default: '!' }
    }
}, {
    timestamps: true
});

// Index for faster queries
sessionSchema.index({ userId: 1, status: 1 });
sessionSchema.index({ sessionId: 1 });
sessionSchema.index({ whatsappNumber: 1 });

// Check if QR code is expired
sessionSchema.methods.isQRExpired = function() {
    return this.qrCodeExpiry < new Date();
};

// Update session activity
sessionSchema.methods.updateActivity = function() {
    this.lastActive = new Date();
    return this.save();
};

// Mark as connected
sessionSchema.methods.markConnected = function(whatsappNumber, connectionData = {}) {
    this.status = 'connected';
    this.whatsappNumber = whatsappNumber;
    this.connectedAt = new Date();
    this.connectionData = { ...this.connectionData, ...connectionData };
    this.errorMessage = null;
    return this.save();
};

// Mark as disconnected
sessionSchema.methods.markDisconnected = function(reason = null) {
    this.status = 'disconnected';
    this.disconnectedAt = new Date();
    if (reason) this.errorMessage = reason;
    return this.save();
};

// Update usage statistics
sessionSchema.methods.updateUsage = function(type, increment = 1) {
    if (this.usage[type] !== undefined) {
        this.usage[type] += increment;
        if (type === 'commandsExecuted') {
            this.usage.lastCommandAt = new Date();
        }
        return this.save();
    }
    return Promise.resolve(this);
};

// Get session uptime
sessionSchema.methods.getUptime = function() {
    if (!this.connectedAt || this.status !== 'connected') return 0;
    return Math.floor((new Date() - this.connectedAt) / 1000); // in seconds
};

module.exports = mongoose.model('Session', sessionSchema);