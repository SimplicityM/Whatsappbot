const mongoose = require('mongoose');

const SavedGroupListSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  groups: [
    {
      name: String,
      groupId: String
    }
  ],
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.SavedGroupList || mongoose.model('SavedGroupList', SavedGroupListSchema);
