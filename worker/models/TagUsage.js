const mongoose = require("mongoose");

const TagUsageSchema = new mongoose.Schema(
  {
    // ===== Daily tag tracking =====
    phone: {
      type: String,
      required: false,
      index: true
    },
    date: {
      type: String, // "YYYY-MM-DD"
      required: false,
      index: true
    },
    tagsToday: {
      type: Number,
      default: 0
    },

    // ===== Rotation + reply tracking =====
    sessionId: {
      type: String,
      required: false,
      index: true
    },
    groupId: {
      type: String,
      required: false,
      index: true
    },
    lastPosition: {
      type: Number,
      default: 0
    },
    lastMessageId: {
      type: String,
      default: null
    },
    lastTaggedAt: {
      type: Date
    }
  },
  { timestamps: true }
);

// ✅ UNIQUE index for daily tracking (only when phone + date exist)
TagUsageSchema.index(
  { phone: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: {
      phone: { $exists: true, $ne: null },
      date: { $exists: true, $ne: null }
    }
  }
);

// ✅ UNIQUE index for rotation tracking (only when sessionId + groupId exist)
TagUsageSchema.index(
  { sessionId: 1, groupId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sessionId: { $exists: true, $ne: null },
      groupId: { $exists: true, $ne: null }
    }
  }
);

module.exports = mongoose.model("TagUsage", TagUsageSchema);