// models/GroupPermission.js
const mongoose = require('mongoose');

const GroupPermissionSchema = new mongoose.Schema({
  botUserId: { type: String, required: true, index: true }, // sessionId
  groupId: { type: String, required: true },
  allowed: { type: [String], default: [] },
  blocked: { type: [String], default: [] }
}, { timestamps: true });

GroupPermissionSchema.index({ botUserId: 1, groupId: 1 }, { unique: true });

module.exports = mongoose.models.GroupPermission || mongoose.model('GroupPermission', GroupPermissionSchema);
