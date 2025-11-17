const mongoose = require('mongoose');

const PhoneRecordSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true, index: true },

    trialStartedAt: { type: Date, default: null },
    trialExpiresAt: { type: Date, default: null },
    trialUsed: { type: Boolean, default: false },

    usedByUserId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: "User", 
        default: null 
    },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Keep updatedAt fresh
PhoneRecordSchema.pre("save", function (next) {
    this.updatedAt = new Date();
    next();
});

module.exports = mongoose.model("PhoneRecord", PhoneRecordSchema);
