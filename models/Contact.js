const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        index: true
    },
    userId: {
        type: String,
        required: true,
        index: true
    },
    whatsappId: {
        type: String,
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true
    },
    phone: {
        type: String,
        default: null
    },
    type: {
        type: String,
        enum: ['individual', 'group', 'group_member'],
        default: 'individual'
    },
    isGroup: {
        type: Boolean,
        default: false
    },
    groupId: {
        type: String,
        default: null
    },
    groupName: {
        type: String,
        default: null
    },
    profilePicture: {
        type: String,
        default: null
    },
    hasMessagedBot: {
        type: Boolean,
        default: false
    },
    lastMessageAt: {
        type: Date,
        default: null
    },
    addedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Compound indexes for efficient querying
contactSchema.index({ userId: 1, sessionId: 1 });
contactSchema.index({ userId: 1, type: 1 });
contactSchema.index({ sessionId: 1, isGroup: 1 });

module.exports = mongoose.models.Contact || mongoose.model('Contact', contactSchema);