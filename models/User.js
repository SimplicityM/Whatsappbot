const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    fullName: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true,
        minlength: 8
    },
    subscription: {
        type: String,
        enum: ['starter', 'professional', 'business', 'enterprise'],
        default: 'starter'
    },
    subscriptionExpiry: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
    },
    sessionId: {
        type: String,
        default: null
    },
    whatsappNumber: {
        type: String,
        default: null
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'suspended', 'active'],
        default: 'pending'
    },
    paymentStatus: {
        type: String,
        enum: ['unpaid', 'paid', 'trial', 'expired'],
        default: 'trial'
    },
    paystackCustomerCode: {
        type: String,
        default: null
    },
    lastLogin: {
        type: Date,
        default: Date.now
    },
    isEmailVerified: {
        type: Boolean,
        default: false
    },
    emailVerificationToken: {
        type: String,
        default: null
    },
    resetPasswordToken: {
        type: String,
        default: null
    },
    resetPasswordExpires: {
        type: Date,
        default: null
    },
    usage: {
        commandsUsed: { type: Number, default: 0 },
        groupsTagged: { type: Number, default: 0 },
        contactsSaved: { type: Number, default: 0 },
        messagesProcessed: { type: Number, default: 0 }
    }
}, {
    timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    
    try {
        const salt = await bcrypt.genSalt(12);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Check if subscription is active
userSchema.methods.isSubscriptionActive = function() {
    return this.subscriptionExpiry > new Date() && this.paymentStatus === 'paid';
};

// Get subscription limits
userSchema.methods.getSubscriptionLimits = function() {
    const limits = {
        starter: { sessions: 5, commands: 100, groups: 10 },
        professional: { sessions: 25, commands: 500, groups: 50 },
        business: { sessions: 100, commands: 2000, groups: 200 },
        enterprise: { sessions: -1, commands: -1, groups: -1 } // unlimited
    };
    
    return limits[this.subscription] || limits.starter;
};

// Update usage statistics
userSchema.methods.updateUsage = function(type, increment = 1) {
    if (this.usage[type] !== undefined) {
        this.usage[type] += increment;
        return this.save();
    }
    return Promise.resolve(this);
};

module.exports = mongoose.model('User', userSchema);