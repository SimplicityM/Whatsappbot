// models/WelcomeMeta.js
const mongoose = require('mongoose');

const WelcomeMetaSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  groupId: { type: String, required: true },
  welcomeSent: { type: Boolean, default: false }
}, { timestamps: true });

WelcomeMetaSchema.index({ sessionId: 1, groupId: 1 }, { unique: true });

module.exports = mongoose.models.WelcomeMeta || mongoose.model('WelcomeMeta', WelcomeMetaSchema);