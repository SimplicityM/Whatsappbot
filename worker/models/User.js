const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({

    fullName: { type: String, required: true, trim: true },

    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },

    password: { type: String, required: true, minlength: 8 },

    role: {
        type: String,
        enum: ['whatsapp_admin', 'system_admin'],
        default: 'whatsapp_admin'
    },

    subscription: {
        type: String,
        enum: ['free','starter', 'professional', 'business', 'enterprise'],
        default: 'free'
    },

    subscriptionExpiry: {
        type: Date,
        default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    },

    // ================= MESSAGE QUOTA SYSTEM =================

    messagesUsedThisMonth: { type: Number, default: 0 },

    quotaResetDate: {
        type: Date,
        default: () => {
            const now = new Date();
            return new Date(now.getFullYear(), now.getMonth() + 1, 1);
        }
    },

    quotaWarningSent: {
    type: Boolean,
    default: false
    },
    // ================= ACCOUNT INFO =================

    sessionId: { type: String, default: null },
    whatsappNumber: { type: String, default: null },
    phone: { type: String, default: null },

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

    paystackCustomerCode: { type: String, default: null },

    lastLogin: { type: Date, default: Date.now },

    isEmailVerified: { type: Boolean, default: false },

    emailVerificationToken: { type: String, default: null },
    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },

    usage: {
        commandsUsed: { type: Number, default: 0 },
        groupsTagged: { type: Number, default: 0 },
        contactsSaved: { type: Number, default: 0 },
        messagesProcessed: { type: Number, default: 0 }
    },

    // ================= PAYMENT EXEMPTIONS =================

    exemptFromPayment: { type: Boolean, default: false },
    exemptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    exemptedAt: { type: Date, default: null },
    exemptionReason: { type: String, default: null },

    // ================= ADMIN PRIVILEGES =================

    isOwner: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false },

    adminLevel: {
        type: String,
        enum: ['none', 'secondary', 'primary', 'owner'],
        default: 'none'
    },

    // ================= EMAIL SETTINGS =================

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

}, { timestamps: true });

/* ======================================================
   PASSWORD HASHING
====================================================== */

userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

userSchema.methods.comparePassword = function(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

/* ======================================================
   SUBSCRIPTION & QUOTA LOGIC
====================================================== */

// Auto reset monthly quota
userSchema.methods.resetQuotaIfNeeded = async function() {
    if (new Date() > this.quotaResetDate) {
        this.messagesUsedThisMonth = 0;
        this.quotaWarningSent = false;
        this.quotaResetDate = new Date(
            new Date().getFullYear(),
            new Date().getMonth() + 1,
            1
        );
        await this.save();
    }
};

// Plan-based quota
userSchema.methods.getPlanQuota = function() {

    if (this.role === 'system_admin' ||
        this.isExemptFromPayment() ||
        this.subscription === 'enterprise') {
        return -1; // unlimited
    }

    const quotas = {
        free: 500,
        starter: 1000,
        professional: 5000,
        business: 20000,
        enterprise: -1
    };

    return quotas[this.subscription] || 500;
};

// Check send permission
userSchema.methods.canSendMessage = async function() {

    await this.resetQuotaIfNeeded();

    if (!this.isSubscriptionActive()) {
        return false;
    }

    const quota = this.getPlanQuota();

    if (quota === -1) return true;

    return this.messagesUsedThisMonth < quota;
};

// Increment usage
userSchema.methods.incrementMessageUsage = async function() {

    await this.resetQuotaIfNeeded();

    const quota = this.getPlanQuota();

    if (quota === -1) return;

    this.messagesUsedThisMonth += 1;

    const usagePercentage = (this.messagesUsedThisMonth / quota) * 100;

    if (usagePercentage >= 80 && !this.quotaWarningSent) {
        this.quotaWarningSent = true;

        // Emit event or trigger email here
        console.log(`⚠️ 80% quota reached for ${this.email}`);
        
        // You can integrate nodemailer here
    }

    await this.save();
};

/* ======================================================
   ORIGINAL ADVANCED LOGIC (PRESERVED)
====================================================== */

userSchema.methods.isExemptFromPayment = function() {
    if (this.role === 'system_admin') return true;
    if (this.isOwner) return true;
    if (this.exemptFromPayment) return true;
    if (this.isAdmin || this.adminLevel !== 'none') return true;
    return false;
};

userSchema.methods.isBotOwner = function() {
    const CONFIG = require('../config');
    const ownerNumber = CONFIG.owner ? CONFIG.owner.replace(/[^0-9]/g, '') : null;
    const userNumber = this.whatsappNumber ? this.whatsappNumber.replace(/[^0-9]/g, '') : null;
    return ownerNumber && userNumber && userNumber === ownerNumber;
};

userSchema.methods.isSystemAdmin = function() {
    return this.role === 'system_admin' ||
           this.email === process.env.ADMIN_EMAIL ||
           this.adminLevel === 'owner';
};

userSchema.methods.isSubscriptionActive = function() {

    if (this.role === 'system_admin') return true;

    if (this.isExemptFromPayment() || this.isBotOwner()) return true;

    const isNotExpired = this.subscriptionExpiry && this.subscriptionExpiry > new Date();
    const hasValidPayment = this.paymentStatus === 'paid' || this.paymentStatus === 'trial';

    return isNotExpired && hasValidPayment;
};

userSchema.methods.getSubscriptionLimits = function() {

    if (this.role === 'system_admin' ||
        this.isExemptFromPayment() ||
        this.isBotOwner()) {
        return { sessions: -1, commands: -1, groups: -1 };
    }

    const limits = {
        free: { sessions: 1, commands: 50, groups: 5 },
        starter: { sessions: 1, commands: 100, groups: 10 },
        professional: { sessions: 1, commands: 500, groups: 50 },
        business: { sessions: 1, commands: 2000, groups: 200 },
        enterprise: { sessions: -1, commands: -1, groups: -1 }
    };

    return limits[this.subscription] || limits.free;
};

userSchema.methods.updateUsage = function(type, increment = 1) {
    if (this.usage[type] !== undefined) {
        this.usage[type] += increment;
        return this.save();
    }
    return Promise.resolve(this);
};

/* ======================================================
   ADMIN CONTROL HELPERS (PRESERVED)
====================================================== */

userSchema.methods.grantPaymentExemption = function(reason, exemptedByUserId) {
    this.exemptFromPayment = true;
    this.exemptedBy = exemptedByUserId;
    this.exemptedAt = new Date();
    this.exemptionReason = reason;
    return this.save();
};

userSchema.methods.removePaymentExemption = function() {
    this.exemptFromPayment = false;
    this.exemptedBy = null;
    this.exemptedAt = null;
    this.exemptionReason = null;
    return this.save();
};

userSchema.methods.setAsOwner = function() {
    this.isOwner = true;
    this.isAdmin = true;
    this.adminLevel = 'owner';
    this.exemptFromPayment = true;
    this.exemptionReason = 'Bot owner privileges';
    return this.save();
};

userSchema.methods.setAdminLevel = function(level) {
    const validLevels = ['none', 'secondary', 'primary', 'owner'];
    if (validLevels.includes(level)) {
        this.adminLevel = level;
        this.isAdmin = level !== 'none';
        if (level !== 'none') {
            this.exemptFromPayment = true;
            this.exemptionReason = `${level} admin privileges`;
        }
    }
    return this.save();
};

userSchema.methods.setAsSystemAdmin = function() {
    this.role = 'system_admin';
    this.isAdmin = true;
    this.adminLevel = 'owner';
    this.exemptFromPayment = true;
    this.exemptionReason = 'System admin privileges';
    return this.save();
};

/* ======================================================
   AUTO OWNER DETECTION (PRESERVED)
====================================================== */

userSchema.statics.ensureOwnerPrivileges = async function(user) {
    try {
        const CONFIG = require('../config.json');
        const ownerNumber = CONFIG.owner ? CONFIG.owner.replace(/[^0-9]/g, '') : null;

        if (!user || !user.whatsappNumber || !ownerNumber) return user;

        const userNumber = user.whatsappNumber.replace(/[^0-9]/g, '');

        if (userNumber === ownerNumber) {
            if (!user.isOwner || user.adminLevel !== 'owner') {
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

module.exports = mongoose.models.User || mongoose.model('User', userSchema);