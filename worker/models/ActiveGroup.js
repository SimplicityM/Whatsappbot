const mongoose = require('mongoose');

const ActiveGroupSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  activeIndex: { type: Number, default: null },
  groupId: { type: String, default: null },
  groupName: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ActiveGroup', ActiveGroupSchema);
