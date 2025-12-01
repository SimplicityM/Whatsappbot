const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    transactionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    txRef: {
        type: String,
        required: true,
        index: true
    },
    flutterwaveRef: {
        type: String
    },
    amount: {
        type: Number,
        required: true
    },
    currency: {
        type: String,
        default: 'NGN'
    },
    status: {
        type: String,
        enum: ['successful', 'failed', 'pending', 'cancelled'],
        required: true,
        default: 'pending'
    },
    subscription: {
        type: String,
        required: true,
        enum: ['starter', 'professional', 'business', 'enterprise']
    },
    duration: {
        type: Number,
        required: true,
        min: 1
    },
    paymentMethod: {
        type: String,
        default: 'card'
    },
    customerEmail: {
        type: String,
        required: true
    },
    customerName: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Index for faster queries
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1 });

// Virtual for formatted amount
transactionSchema.virtual('formattedAmount').get(function() {
    return `₦${this.amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
});

// Method to check if transaction is successful
transactionSchema.methods.isSuccessful = function() {
    return this.status === 'successful';
};

// Static method to get user's transaction summary
transactionSchema.statics.getUserSummary = async function(userId) {
    const summary = await this.aggregate([
        { $match: { userId: mongoose.Types.ObjectId(userId), status: 'successful' } },
        {
            $group: {
                _id: null,
                totalSpent: { $sum: '$amount' },
                totalTransactions: { $sum: 1 },
                lastPayment: { $max: '$createdAt' }
            }
        }
    ]);
    
    return summary.length > 0 ? summary[0] : {
        totalSpent: 0,
        totalTransactions: 0,
        lastPayment: null
    };
};

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);