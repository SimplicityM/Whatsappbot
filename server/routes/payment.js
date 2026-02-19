const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const { authenticate } = require('../../middleware/auth');
const router = express.Router();

// Flutterwave configuration
const FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
// After successful payment
const BlacklistedNumber = require('../models/BlacklistedNumber');

// Subscription plans
const SUBSCRIPTION_PLANS = {
    starter: { 
        monthly: { amount: 700, duration: 1 },      // $7/month for 1 month
        yearly: { amount: 6720, duration: 12 }      // $67.20/year for 12 months (20% off)
    },
    professional: { 
        monthly: { amount: 1500, duration: 1 },     // $15/month for 1 month
        yearly: { amount: 14400, duration: 12 }     // $144/year for 12 months (20% off)
    },
    business: { 
        monthly: { amount: 2200, duration: 1 },     // $22/month for 1 month
        yearly: { amount: 21120, duration: 12 }     // $211.20/year for 12 months (20% off)
    },
    enterprise: { 
        monthly: { amount: 3800, duration: 1 },     // $38/month for 1 month
        yearly: { amount: 36480, duration: 12 }     // $364.80/year for 12 months (20% off)
    }
};

// Plans endpoint
router.get('/plans', (req, res) => {
    try {
        const plans = Object.entries(SUBSCRIPTION_PLANS).map(([key, plan]) => ({
            id: key,
            name: key.charAt(0).toUpperCase() + key.slice(1) + ' Plan',
            monthly: {
                amount: plan.monthly.amount / 100, // ✅ Convert cents to dollars for display
                amountInCents: plan.monthly.amount, // ✅ Keep cents for payment processing
                duration: plan.monthly.duration,
                currency: 'USD'
            },
            yearly: plan.yearly ? {
                amount: plan.yearly.amount / 100, // ✅ Convert cents to dollars for display
                amountInCents: plan.yearly.amount, // ✅ Keep cents for payment processing
                duration: plan.yearly.duration,
                currency: 'USD',
                savings: '20%'
            } : null,
            features: getSubscriptionFeatures(key)
        }));

        res.json({
            success: true,
            data: { plans }
        });

    } catch (error) {
        console.error('Get plans error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching subscription plans.'
        });
    }
});

function getSubscriptionFeatures(subscription) {
    const features = {
        free: [
            'Basic group tagging (tagall)',
            'Basic media sharing',
            '1 active sessions',
            'Standard support'
        ],
        starter: [
            'Basic group tagging (tagall)',
            'Contact auto-save',
            'Basic media sharing',
            '1 active sessions',
            'Standard support'
        ],
        professional: [
            'All Starter features',
            'Advanced tagging (tagallexcept)',
            'Event & meeting scheduling',
            'Reminder management',
            '1 active sessions',
            'Priority support',
            'Basic admin controls'
        ],
        business: [
            'All Professional features',
            'Advanced admin controls',
            'Sudo user management',
            'System monitoring',
            '1 active sessions',
            'Broadcast messaging',
            'Custom workflows',
            '24/7 support'
        ],
        enterprise: [
            'All Business features',
            'Unlimited active sessions',
            'Advanced automation workflows',
            'Custom bot commands',
            'API access',
            'White-label solution',
            'Dedicated support manager',
            'Custom integrations'
        ]
    };

    return features[subscription] || [];
}

// Verify Flutterwave payment
router.post('/verify-flutterwave', authenticate, async (req, res) => {
    try {
        const { transaction_id, tx_ref } = req.body;

        if (!transaction_id) {
            return res.status(400).json({
                success: false,
                message: 'Transaction ID is required.'
            });
        }

        const response = await axios.get(
            `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
            {
                headers: {
                    'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`
                }
            }
        );

        const payload = response.data?.data;
        if (!payload) {
            return res.status(400).json({
                success: false,
                message: 'Invalid verification payload.'
            });
        }

        if (payload.status !== 'successful') {
            return res.status(400).json({
                success: false,
                message: 'Payment verification failed.',
                data: { status: payload.status }
            });
        }

        const meta = payload.meta || {};
        const userId = meta.userId || req.user._id;
        const subscription = meta.subscription;
        const billingCycle = meta.billingCycle || 'monthly';

        const Transaction = require('../models/Transaction');
        const existingTransaction = await Transaction.findOne({ transactionId: String(transaction_id) });
        if (existingTransaction) {
            return res.json({
                success: true,
                message: 'Payment already verified.',
                data: {
                    reference: tx_ref,
                    amount: payload.amount,
                    subscription: existingTransaction.subscription,
                    duration: existingTransaction.duration,
                    alreadyProcessed: true
                }
            });
        }

        const planDetails = SUBSCRIPTION_PLANS[subscription]?.[billingCycle];
        if (!planDetails) {
            return res.status(400).json({
                success: false,
                message: 'Invalid subscription plan or billing cycle.'
            });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found.'
            });
        }

        const durationInDays = Math.round(planDetails.duration * 30);
        user.subscription = subscription;
        user.paymentStatus = 'paid';
        user.subscriptionExpiry = new Date(Date.now() + durationInDays * 24 * 60 * 60 * 1000);
        user.status = 'approved';
        await user.save();

        if (user.whatsappNumber) {
            await BlacklistedNumber.findOneAndUpdate(
                { whatsappNumber: user.whatsappNumber },
                {
                    canReactivate: true,
                    reason: 'paid_subscription',
                    notes: `Subscription renewed on ${new Date().toISOString()}`
                }
            );
        }

        await Transaction.create({
            userId: user._id,
            transactionId: String(transaction_id),
            txRef: tx_ref,
            amount: payload.amount,
            currency: payload.currency || 'USD',
            status: payload.status,
            subscription,
            billingCycle,
            duration: planDetails.duration,
            paymentMethod: payload.payment_type || 'card',
            customerEmail: payload.customer?.email || user.email,
            customerName: payload.customer?.name || user.fullName,
            flutterwaveRef: payload.flw_ref,
            createdAt: new Date(payload.created_at || Date.now())
        });

        try {
            const { restoreUserSessionAfterPayment } = require('../../worker/baileys.js');
            await restoreUserSessionAfterPayment(user._id);
        } catch (botError) {
            console.error('Error restoring bot session:', botError);
        }

        return res.json({
            success: true,
            message: 'Payment verified successfully.',
            data: {
                reference: tx_ref,
                amount: payload.amount,
                subscription,
                duration: planDetails.duration,
                subscriptionExpiry: user.subscriptionExpiry
            }
        });

    } catch (error) {
        console.error('Flutterwave verification error:', error.response?.data || error);
        res.status(500).json({
            success: false,
            message: 'Error verifying payment.'
        });
    }
});

// Flutterwave webhook
router.post('/flutterwave-webhook', async (req, res) => {
    try {
        const secretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH;
        const signature = req.headers['verif-hash'];

        if (!signature || signature !== secretHash) {
            return res.status(401).json({
                success: false,
                message: 'Invalid signature.'
            });
        }

        const payload = req.body;

        // Handle successful payment
        if (payload.event === 'charge.completed' && payload.data?.status === 'successful') {
            const data = payload.data;
            const meta = data.meta || {};
            const userId = meta.userId;
            const subscription = meta.subscription;
            const billingCycle = meta.billingCycle || 'monthly';
            const planDetails = SUBSCRIPTION_PLANS[subscription]?.[billingCycle];

            if (userId && planDetails) {
                const user = await User.findById(userId);
                if (user) {
                    user.subscription = subscription;
                    user.paymentStatus = 'paid';
                    user.subscriptionExpiry = new Date(Date.now() + (planDetails.duration * 30 * 24 * 60 * 60 * 1000));
                    user.status = 'approved';
                    await user.save();

                    if (user.whatsappNumber) {
                        await BlacklistedNumber.findOneAndUpdate(
                            { whatsappNumber: user.whatsappNumber },
                            {
                                canReactivate: true,
                                reason: 'paid_subscription',
                                notes: `Subscription renewed via webhook on ${new Date().toISOString()}`
                            }
                        );
                    }

                    try {
                        const { restoreUserSessionAfterPayment } = require('../../worker/baileys.js');
                        await restoreUserSessionAfterPayment(userId);
                    } catch (botError) {
                        console.error('Error restoring bot session:', botError);
                    }
                }
            }
        }

        res.status(200).json({ success: true });

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({
            success: false,
            message: 'Webhook processing failed.'
        });
    }
});

// Payment history (placeholder - Flutterwave doesn't have direct customer transaction endpoint like Paystack)
// Payment history
router.get('/history', authenticate, async (req, res) => {
    try {
        const user = req.user;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const status = req.query.status; // Optional filter: successful, failed, pending

        const Transaction = require('../models/Transaction');
        
        // Build query
        const query = { userId: user._id };
        if (status) {
            query.status = status;
        }

        // Get transactions with pagination
        const transactions = await Transaction.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        const total = await Transaction.countDocuments(query);

        // Get user payment summary
        const summary = await Transaction.getUserSummary(user._id);

        res.json({
            success: true,
            data: {
                transactions: transactions.map(t => ({
                    id: t._id,
                    reference: t.txRef,
                    transactionId: t.transactionId,
                    amount: t.amount,
                    formattedAmount: `₦${t.amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    currency: t.currency,
                    status: t.status,
                    subscription: t.subscription,
                    subscriptionName: getSubscriptionName(t.subscription),
                    duration: t.duration,
                    durationText: `${t.duration} month${t.duration > 1 ? 's' : ''}`,
                    paymentMethod: t.paymentMethod,
                    createdAt: t.createdAt,
                    paidAt: t.createdAt,
                    customerEmail: t.customerEmail
                })),
                summary: {
                    totalSpent: summary.totalSpent,
                    formattedTotalSpent: `₦${summary.totalSpent.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    totalTransactions: summary.totalTransactions,
                    lastPayment: summary.lastPayment,
                    lastPaymentFormatted: summary.lastPayment ? new Date(summary.lastPayment).toLocaleDateString('en-NG', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    }) : null
                },
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(total / limit),
                    totalTransactions: total,
                    hasNextPage: page < Math.ceil(total / limit),
                    hasPreviousPage: page > 1,
                    perPage: limit
                }
            }
        });

    } catch (error) {
        console.error('Payment history error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching payment history.'
        });
    }
});

// Helper function to get subscription name
function getSubscriptionName(subscription) {
    const names = {
        free: 'Free Plan',
        starter: 'Starter Plan',
        professional: 'Professional Plan',
        business: 'Business Plan',
        enterprise: 'Enterprise Plan'
    };
    return names[subscription] || subscription;
}

// Subscription status
router.get('/subscription-status', authenticate, async (req, res) => {
    try {
        const user = req.user;

        res.json({
            success: true,
            data: {
                subscription: user.subscription,
                paymentStatus: user.paymentStatus,
                subscriptionExpiry: user.subscriptionExpiry,
                isActive: user.isSubscriptionActive(),
                daysRemaining: Math.ceil((user.subscriptionExpiry - new Date()) / (1000 * 60 * 60 * 24)),
                limits: user.getSubscriptionLimits(),
                features: getSubscriptionFeatures(user.subscription)
            }
        });

    } catch (error) {
        console.error('Subscription status error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching subscription status.'
        });
    }
});

// Cancel subscription
router.post('/cancel-subscription', authenticate, async (req, res) => {
    try {
        const user = req.user;

        user.paymentStatus = 'expired';
        await user.save();

        res.json({
            success: true,
            message: 'Subscription cancelled. Access continues until expiry.',
            data: {
                subscriptionExpiry: user.subscriptionExpiry
            }
        });

    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Error cancelling subscription.'
        });
    }
});

// Reactivate subscription
router.post('/reactivate-subscription', authenticate, async (req, res) => {
    try {
        const { subscription } = req.body;
        const user = req.user;

        if (!SUBSCRIPTION_PLANS[subscription]) {
            return res.status(400).json({
                success: false,
                message: 'Invalid subscription plan.'
            });
        }

        user.subscription = subscription;
        await user.save();

        res.json({
            success: true,
            message: 'Please complete payment to reactivate subscription.',
            data: {
                redirectToPayment: true,
                subscription
            }
        });

    } catch (error) {
        console.error('Reactivate subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Error reactivating subscription.'
        });
    }
});

// Get single transaction details
router.get('/transaction/:transactionId', authenticate, async (req, res) => {
    try {
        const { transactionId } = req.params;
        const user = req.user;

        const Transaction = require('../models/Transaction');
        
        const transaction = await Transaction.findOne({
            $or: [
                { transactionId: transactionId },
                { txRef: transactionId },
                { _id: transactionId }
            ],
            userId: user._id
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found.'
            });
        }

        res.json({
            success: true,
            data: {
                id: transaction._id,
                transactionId: transaction.transactionId,
                reference: transaction.txRef,
                flutterwaveRef: transaction.flutterwaveRef,
                amount: transaction.amount,
                formattedAmount: `₦${transaction.amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                currency: transaction.currency,
                status: transaction.status,
                subscription: transaction.subscription,
                subscriptionName: getSubscriptionName(transaction.subscription),
                duration: transaction.duration,
                durationText: `${transaction.duration} month${transaction.duration > 1 ? 's' : ''}`,
                paymentMethod: transaction.paymentMethod,
                customerEmail: transaction.customerEmail,
                customerName: transaction.customerName,
                createdAt: transaction.createdAt,
                updatedAt: transaction.updatedAt,
                isSuccessful: transaction.isSuccessful()
            }
        });

    } catch (error) {
        console.error('Get transaction error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching transaction details.'
        });
    }
});

module.exports = router;






