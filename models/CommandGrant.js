const mongoose = require('mongoose');

const commandGrantSchema = new mongoose.Schema({
    // Who received the grant
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null // null means granted to entire plan
    },
    
    // Or grant to entire plan
    planType: {
        type: String,
        enum: ['free', 'starter', 'professional', 'business', 'enterprise', null],
        default: null
    },
    
    // Command details
    commandName: {
        type: String,
        required: true
    },
    
    commandDescription: {
        type: String,
        default: ''
    },
    
    // Who granted it
    grantedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    
    // Grant metadata
    grantType: {
        type: String,
        enum: ['user', 'plan'],
        required: true
    },
    
    expiresAt: {
        type: Date,
        default: null // null = permanent
    },
    
    isActive: {
        type: Boolean,
        default: true
    },
    
    reason: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

// Indexes
commandGrantSchema.index({ userId: 1, commandName: 1 });
commandGrantSchema.index({ planType: 1, commandName: 1 });
commandGrantSchema.index({ isActive: 1 });

module.exports = mongoose.models.CommandGrant || mongoose.model('CommandGrant', commandGrantSchema);