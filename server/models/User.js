const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // Add this import at the top

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
    
    // 🔑 ADD THIS NEW FIELD FOR USER TYPE DISTINCTION
    role: {
        type: String,
        enum: ['whatsapp_admin', 'system_admin'],
        default: 'whatsapp_admin'
    },
    
    subscription: {
        type: String,
        enum: ['free','starter', 'professional', 'business', 'enterprise'],
        default: 'Free'
    },
    subscriptionExpiry: {
        type: Date,
        default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days from now
    },
    sessionId: {
        type: String,
        default: null
    },
    whatsappNumber: {
        type: String,
        default: null
    },
    phone: {
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
    },

    // 🔑 NEW PAYMENT EXEMPTION FIELDS
    exemptFromPayment: {
        type: Boolean,
        default: false
    },
    exemptedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    exemptedAt: {
        type: Date,
        default: null
    },
    exemptionReason: {
        type: String,
        default: null
    },

    // 👑 OWNER AND ADMIN PRIVILEGES
    isOwner: {
        type: Boolean,
        default: false
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    adminLevel: {
        type: String,
        enum: ['none', 'secondary', 'primary', 'owner'],
        default: 'none'
    },
    
    customCommands: {
    type: [String],
    default: []
},

    // EMAIL PREFERENCES
    emailPreferences: {
        marketing: { type: Boolean, default: true },
        trialReminders: { type: Boolean, default: true },
        usageAlerts: { type: Boolean, default: true },
        productUpdates: { type: Boolean, default: true }
    },
    unsubscribeToken: {
        type: String,
        default: () => crypto.randomBytes(32).toString('hex')
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

// 🔑 ENHANCED: Check if user is exempt from payment requirements
userSchema.methods.isExemptFromPayment = function() {
    // System admin is always exempt
    if (this.role === 'system_admin') return true;
    
    // Owner is always exempt
    if (this.isOwner) return true;
    
    // Admin exemption
    if (this.exemptFromPayment) return true;
    
    // Secondary admin privileges
    if (this.isAdmin || this.adminLevel !== 'none') return true;
    
    return false;
};

// 👑 NEW: Check if user is the bot owner
userSchema.methods.isBotOwner = function() {
    // Check if this user's WhatsApp number matches the owner number from config
    const CONFIG = require('../../config.json'); // Adjust path as needed
    const ownerNumber = CONFIG.owner ? CONFIG.owner.replace(/[^0-9]/g, '') : null;
    const userNumber = this.whatsappNumber ? this.whatsappNumber.replace(/[^0-9]/g, '') : null;
    
    return ownerNumber && userNumber && userNumber === ownerNumber;
};

// 🔑 ENHANCED: Check if user is system admin
userSchema.methods.isSystemAdmin = function() {
    return this.role === 'system_admin' || 
           this.email === process.env.ADMIN_EMAIL ||
           this.adminLevel === 'owner';
};

// Check if subscription is active (enhanced with exemptions)
userSchema.methods.isSubscriptionActive = function() {
    // System admin doesn't need subscription
    if (this.role === 'system_admin') return true;
    
    // Exempt users don't need active subscriptions
    if (this.isExemptFromPayment()) return true;
    
    // Owner is always active
    if (this.isBotOwner()) return true;
    
    // Regular subscription check
    return this.subscriptionExpiry > new Date() && this.paymentStatus === 'paid';
};

// Get subscription limits (enhanced with exemptions)
userSchema.methods.getSubscriptionLimits = function() {
    // System admin gets unlimited access
    if (this.role === 'system_admin') {
        return { sessions: -1, commands: -1, groups: -1 }; // unlimited
    }
    
    // Owner and exempt users get unlimited access
    if (this.isExemptFromPayment() || this.isBotOwner()) {
        return { sessions: -1, commands: -1, groups: -1 }; // unlimited
    }
    
            const limits = {
            free: { sessions: 1, commands: 50, groups: 5 }, // ✅ Added free plan limits
            starter: { sessions: 1, commands: 100, groups: 10 },
            professional: { sessions: 1, commands: 500, groups: 50 },
            business: { sessions: 2, commands: 2000, groups: 200 },
            enterprise: { sessions: -1, commands: -1, groups: -1 } // unlimited
        };

        return limits[this.subscription] || limits.free;
};

// Update usage statistics
userSchema.methods.updateUsage = function(type, increment = 1) {
    if (this.usage[type] !== undefined) {
        this.usage[type] += increment;
        return this.save();
    }
    return Promise.resolve(this);
};

// 🛡️ NEW: Grant exemption from payment
userSchema.methods.grantPaymentExemption = function(reason, exemptedByUserId) {
    this.exemptFromPayment = true;
    this.exemptedBy = exemptedByUserId;
    this.exemptedAt = new Date();
    this.exemptionReason = reason;
    return this.save();
};

// 🛡️ NEW: Remove exemption from payment
userSchema.methods.removePaymentExemption = function() {
    this.exemptFromPayment = false;
    this.exemptedBy = null;
    this.exemptedAt = null;
    this.exemptionReason = null;
    return this.save();
};

// 👑 NEW: Set as bot owner
userSchema.methods.setAsOwner = function() {
    this.isOwner = true;
    this.isAdmin = true;
    this.adminLevel = 'owner';
    this.exemptFromPayment = true;
    this.exemptionReason = 'Bot owner privileges';
    return this.save();
};

// 👨‍💼 NEW: Set admin level
userSchema.methods.setAdminLevel = function(level) {
    const validLevels = ['none', 'secondary', 'primary', 'owner'];
    if (validLevels.includes(level)) {
        this.adminLevel = level;
        this.isAdmin = level !== 'none';
        
        // Admins get payment exemption
        if (level !== 'none') {
            this.exemptFromPayment = true;
            this.exemptionReason = `${level} admin privileges`;
        }
    }
    return this.save();
};

// 🔑 NEW: Set as system admin
userSchema.methods.setAsSystemAdmin = function() {
    this.role = 'system_admin';
    this.isAdmin = true;
    this.adminLevel = 'owner';
    this.exemptFromPayment = true;
    this.exemptionReason = 'System admin privileges';
    return this.save();
};

// 👑 Auto-assign owner privileges if user matches configured owner number
userSchema.statics.ensureOwnerPrivileges = async function (user) {
    try {
        const CONFIG = require('../../config.json'); // adjust path if needed
        const ownerNumber = CONFIG.owner ? CONFIG.owner.replace(/[^0-9]/g, '') : '2347067012884';

        if (!user || !user.whatsappNumber) return user;

        const userNumber = user.whatsappNumber.replace(/[^0-9]/g, '');

        if (userNumber === ownerNumber) {
            if (!user.isOwner || !user.isAdmin || user.adminLevel !== 'owner') {
                console.log(`👑 Ensuring owner privileges for ${userNumber}`);
                user.isOwner = true;
                user.isAdmin = true;
                user.adminLevel = 'owner';
                user.exemptFromPayment = true;
                user.exemptionReason = 'Auto-granted bot owner privileges';
                await user.save();
            }
        }

        return user;
    } catch (err) {
        console.error('❌ Error ensuring owner privileges:', err);
        return user;
    }
};

module.exports = mongoose.model('User', userSchema);