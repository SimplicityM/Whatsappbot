const mongoose = require("mongoose");

const PhoneRecordSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },

    // Anti-fraud user ID lock
    usedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Trial fields
    trialUsed: { type: Boolean, default: false },
    trialStartedAt: { type: Date, default: null },
    trialExpiresAt: { type: Date, default: null },

    // First-command rule tracking for expired users
    firstCommandDone: { type: Boolean, default: false },

    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("PhoneRecord", PhoneRecordSchema);
