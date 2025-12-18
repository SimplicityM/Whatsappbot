const mongoose = require("mongoose");

const TagUsageSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    tagsToday: { type: Number, default: 0 }
});

/**
 * ✅ FIX: Prevent E11000 duplicate key error
 * - Enforces uniqueness ONLY when phone & date are valid strings
 * - Allows MongoDB to ignore null / invalid inserts safely
 * - Does NOT break existing logic
 */
TagUsageSchema.index(
    { phone: 1, date: 1 },
    {
        unique: true,
        partialFilterExpression: {
            phone: { $type: "string" },
            date: { $type: "string" }
        }
    }
);


module.exports = mongoose.models.TagUsage || mongoose.model("TagUsage", TagUsageSchema);