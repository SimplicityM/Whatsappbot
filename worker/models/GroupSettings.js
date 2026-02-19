const mongoose = require("mongoose");

const groupSettingsSchema = new mongoose.Schema({
    groupId: { type: String, required: true, unique: true },
    antiLink: { type: Boolean, default: false },
    antiDelete: { type: Boolean, default: false },
    welcome: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model("GroupSettings", groupSettingsSchema);