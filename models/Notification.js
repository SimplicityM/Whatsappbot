const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    
    type: {
        type: String,
        enum: ['command_grant', 'plan_update', 'system', 'payment', 'session'],
        required: true
    },
    
    title: {
        type: String,
        required: true
    },
    
    message: {
        type: String,
        required: true
    },
    
    data: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    
    isRead: {
        type: Boolean,
        default: false
    },
    
    readAt: {
        type: Date,
        default: null
    },
    
    priority: {
        type: String,
        enum: ['low', 'medium', 'high'],
        default: 'medium'
    }
}, {
    timestamps: true
});

// Indexes
notificationSchema.index({ userId: 1, isRead: 1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);