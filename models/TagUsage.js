const mongoose = require('mongoose');

const TagUsageSchema = new mongoose.Schema({
    phone: { type: String, required: true, index: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    tagsToday: { type: Number, default: 0 }
});

module.exports = mongoose.model('TagUsage', TagUsageSchema);
