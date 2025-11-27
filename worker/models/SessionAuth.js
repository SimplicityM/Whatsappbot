const mongoose = require('mongoose');

const sessionAuthSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    authData: {
        type: String, // Encrypted JSON string of WhatsApp auth data
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('SessionAuth', sessionAuthSchema);