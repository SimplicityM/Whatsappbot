const mongoose = require("mongoose");

const TagUsageSchema = new mongoose.Schema({
    // Original fields for daily tag tracking
    phone: { type: String },
    date: { type: String }, // "YYYY-MM-DD"
    tagsToday: { type: Number, default: 0 },
    
    // ✅ NEW FIELDS for rotation and reply tracking
    sessionId: { type: String },
    groupId: { type: String },
    lastPosition: { type: Number, default: 0 },
    lastMessageId: { type: String, default: null },
    lastTaggedAt: { type: Date }
});

// Keep original index for daily tracking
TagUsageSchema.index({ phone: 1, date: 1 });

// ✅ Add new index for rotation tracking
TagUsageSchema.index({ sessionId: 1, groupId: 1 });

module.exports = mongoose.model("TagUsage", TagUsageSchema);