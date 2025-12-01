// models/PhoneRecord.js
const mongoose = require('mongoose');

const phoneRecordSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    usedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    trialUsed: { type: Boolean, default: false },
    trialStartedAt: { type: Date },
    trialExpiresAt: { type: Date },
    firstCommandDone: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.models.PhoneRecord || mongoose.model('PhoneRecord', phoneRecordSchema);