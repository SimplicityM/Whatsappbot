// worker/models/AutoReply.js
const mongoose = require('mongoose');

const AutoReplySchema = new mongoose.Schema({
    sessionId: { 
        type: String, 
        required: true,
        index: true 
    },
    
    // ============================================
    // GLOBAL SETTINGS
    // ============================================
    globalEnabled: {
        type: Boolean,
        default: true
    },
    
    // ============================================
    // GROUP FILTERING (Whitelist/Blacklist)
    // ============================================
    // If empty: works in ALL groups
    // If has items: ONLY works in these groups
    allowedGroups: {
        type: [String],
        default: [] // Empty = all groups allowed
    },
    
    // Groups where auto-reply is explicitly disabled
    disabledGroups: {
        type: [String],
        default: []
    },
    
    // ============================================
    // GLOBAL RULES (applies to all allowed groups)
    // ============================================
    globalRules: [
        {
            keyword: { 
                type: String, 
                required: true,
                trim: true,
                lowercase: true
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
    
    globalMediaRules: [
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
    ],

    // ============================================
    // GROUP-SPECIFIC RULES (per group)
    // ============================================
    groupRules: [
        {
            groupId: {
                type: String,
                required: true,
                index: true
            },
            groupName: {
                type: String,
                default: ''
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
                        lowercase: true
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
            ],
            // Priority: if true, ONLY group rules apply (ignores global)
            overrideGlobal: {
                type: Boolean,
                default: false
            }
        }
    ],

    // ============================================
    // BACKWARD COMPATIBILITY (old schema)
    // ============================================
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
                lowercase: true
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
    ],

    recallKeywords: [
        {
            term: {
                type: String,
                trim: true,
                lowercase: true
            },
            mapsToTime: {
                type: String,
                default: null
            },
            mapsToMedia: {
                type: String,
                enum: ['image', 'video', 'audio', 'sticker', 'document', null],
                default: null
            }
        }
    ]
}, { timestamps: true });

// Index for faster queries
AutoReplySchema.index({ sessionId: 1, 'groupRules.groupId': 1 });

module.exports = mongoose.models.AutoReply || mongoose.model('AutoReply', AutoReplySchema);
