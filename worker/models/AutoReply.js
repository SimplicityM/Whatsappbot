// worker/models/AutoReply.js
const mongoose = require('mongoose');

const AutoReplySchema = new mongoose.Schema({
    sessionId: { 
        type: String, 
        required: true,
        index: true 
    },
    groupId: {
        type: String,
        default: null // null means applies to all groups for this session
    },
    enabled: {
        type: Boolean,
        default: true
    },
    rules: [
        {
            keyword: { 
                type: String, 
                required: true,
                trim: true,
                lowercase: true // Store keywords in lowercase for case-insensitive matching
            },
            response: { 
                type: String, 
                required: true 
            },
            matchType: {
                type: String,
                enum: ['exact', 'contains', 'starts', 'ends'],
                default: 'contains'
            },
            active: {
                type: Boolean,
                default: true
            }
        }
    ],
    // Media auto-reply rules (moved outside of rules array)
    mediaRules: [
        {
            type: { 
                type: String, 
                enum: ['image', 'video', 'audio', 'sticker', 'document'],
                required: true 
            },
            response: { 
                type: String, 
                required: true 
            },
            active: {
                type: Boolean,
                default: true
            }
        }
    ]
}, { timestamps: true });

// Index for faster queries
AutoReplySchema.index({ sessionId: 1, groupId: 1 });

module.exports = mongoose.models.AutoReply || mongoose.model('AutoReply', AutoReplySchema);