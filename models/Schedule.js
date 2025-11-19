// models/Schedule.js
const mongoose = require('mongoose');

const ScheduleSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true }, // sessionId
  chatId: { type: String },
  creator: { type: String },
  mode: { type: String, enum: ['group','dm'], default: 'group' },
  targets: { type: [String], default: [] }, // optional jids for dm
  message: { type: String, required: true },
  timeHHMM: { type: String, required: true },
  nextRun: { type: Date, required: true },
  repeat: { type: String, enum: ['once','daily','weekly'], default: 'once' },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.models.Schedule || mongoose.model('Schedule', ScheduleSchema);