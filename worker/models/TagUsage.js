const mongoose = require("mongoose");

const TagUsageSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    tagsToday: { type: Number, default: 0 }
});

TagUsageSchema.index({ phone: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("TagUsage", TagUsageSchema);
