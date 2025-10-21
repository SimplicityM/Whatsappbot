const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const router = express.Router();

// Paystack configuration
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// Subscription plans
const SUBSCRIPTION_PLANS = {
    starter: { amount: 2900, name: 'Starter Plan' }, // Amount in kobo (₦29)
    professional: { amount: 7900, name: 'Professional Plan' }, // ₦79
    business: { amount: 14900, name: 'Business Plan' }, // ₦149
    enterprise: { amount: 27900, name: 'Enterprise Plan' } // ₦279
};

// Initialize payment
router.post('/initialize', authenticate, async (req, res) => {
    try {
        const { subscription, duration = 1 } = req.body; // duration in months
        const user = req.user;

        if (!SUBSCRIPTION_PLANS[subscription]) {
            return res.status(400).json({
                success: false,
                message: 'Invalid subscription plan.'
            });
        }

        const plan = SUBSCRIPTION_PLANS[subscription];
        const amount = plan.amount * duration;

        // Create Paystack customer if not exists
        let customerCode = user.paystackCustomerCode;
        
        if (!customerCode) {
            try {
                const customerResponse = await axios.post(
                    `${PAYSTACK_BASE_URL}/customer`,
                    {
                        email: user.email,
                        first_name: user.fullName.split(' ')[0],
                        last_name: user.fullName.split(' ').slice(1).join(' '),
                        metadata: {
                            userId: user._id.toString()
                        }
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );

                customerCode = customerResponse.data.data.customer_code;
                user.paystackCustomerCode = customerCode;
                await user.save();
            } catch (error) {
                console.error('Error creating Paystack customer:', error.response?.data);
                return res.status(500).json({
                    success: false,
                    message: 'Error creating payment customer.'
                });
            }
        }

        // Initialize transaction
        try {
            const response = await axios.post(
                `${PAYSTACK_BASE_URL}/transaction/initialize`,
                {
                    email: user.email,
                    amount: amount,
                    currency: 'NGN',
                    customer: customerCode,
                    metadata: {
                        userId: user._id.toString(),
                        subscription: subscription,
                        duration: duration,
                        custom_fields: [
                            {
                                display_name: 'Subscription Plan',
                                variable_name: 'subscription_plan',
                                value: plan.name
                            },
                            {
                                display_name: 'Duration',
                                variable_name: 'duration',
                                value: `${duration} month(s)`
                            }
                        ]
                    },
                    callback_url: `${process.env.FRONTEND_URL}/payment/callback`,
                    channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer']
                },
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const { authorization_url, access_code, reference } = response.data.data;

            res.json({
                success: true,
                message: 'Payment initialized successfully.',
                data: {
                    authorization_url,
                    access_code,
                    reference,
                    amount: amount / 100, // Convert back to naira
                    plan: plan.name,
                    duration
                }
            });

        } catch (error) {
            console.error('Error initializing payment:', error.response?.data);
            res.status(500).json({
                success: false,
                message: 'Error initializing payment.'
            });
        }

    } catch (error) {
        console.error('Payment initialization error:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing payment request.'
        });
    }
});

// Verify payment
router.get('/verify/:reference', authenticate, async (req, res) => {
    try {
        const { reference } = req.params;

        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                }
            }
        );

        const { data } = response.data;

        if (data.status === 'success') {
            const { metadata, amount, customer } = data;
            const userId = metadata.userId;
            const subscription = metadata.subscription;
            const duration = metadata.duration;

            // Update user subscription
            const user = await User.findById(userId);
            if (user) {
                user.subscription = subscription;
                user.paymentStatus = 'paid';
                user.subscriptionExpiry = new Date(Date.now() + duration * 30 * 24 * 60 * 60 * 1000);
                user.status = 'approved'; // Auto-approve paid users
                await user.save();

                res.json({
                    success: true,
                    message: 'Payment verified successfully.',
                    data: {
                        reference,
                        amount: amount / 100,
                        subscription,
                        duration,
                        subscriptionExpiry: user.subscriptionExpiry
                    }
                });
            } else {
                res.status(404).json({
                    success: false,
                    message: 'User not found.'
                });
            }
        } else {
            res.status(400).json({
                success: false,
                message: 'Payment verification failed.',
                data: { status: data.status }
            });
        }

    } catch (error) {
        console.error('Payment verification error:', error.response?.data || error);
        res.status(500).json({
            success: false,
            message: 'Error verifying payment.'
        });
    }
});

// Paystack webhook
router.post('/webhook', (req, res) => {
    try {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            return res.status(400).json({
                success: false,
                message: 'Invalid signature.'
            });
        }

        const event = req.body;

        switch (event.event) {
            case 'charge.success':
                handleSuccessfulPayment(event.data);
                break;
            case 'charge.failed':
                handleFailedPayment(event.data);
                break;
            case 'subscription.create':
                handleSubscriptionCreate(event.data);
                break;
            case 'subscription.disable':
                handleSubscriptionDisable(event.data);
                break;
            default:
                console.log('Unhandled webhook event:', event.event);
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

// Handle successful payment
async function handleSuccessfulPayment(data) {
    try {
        const { metadata, amount, customer, reference } = data;
        const userId = metadata.userId;
        const subscription = metadata.subscription;
        const duration = parseInt(metadata.duration);

        const user = await User.findById(userId);
        if (user) {
            user.subscription = subscription;
            user.paymentStatus = 'paid';
            user.subscriptionExpiry = new Date(Date.now() + duration * 30 * 24 * 60 * 60 * 1000);
            user.status = 'approved';
            await user.save();

            console.log(`Payment successful for user ${user.email}: ${reference}`);
            
            // Here you could send confirmation email or notification
            // await sendPaymentConfirmationEmail(user, { reference, amount, subscription });
        }
    } catch (error) {
        console.error('Error handling successful payment:', error);
    }
}

// Handle failed payment
async function handleFailedPayment(data) {
    try {
        const { metadata, reference } = data;
        const userId = metadata.userId;

        console.log(`Payment failed for user ${userId}: ${reference}`);
        
        // Here you could send failure notification
        // await sendPaymentFailureEmail(userId, reference);
    } catch (error) {
        console.error('Error handling failed payment:', error);
    }
}

// Handle subscription creation
async function handleSubscriptionCreate(data) {
    try {
        const { customer, plan } = data;
        console.log('Subscription created:', { customer, plan });
        
        // Handle recurring subscription logic here
    } catch (error) {
        console.error('Error handling subscription creation:', error);
    }
}

// Handle subscription disable
async function handleSubscriptionDisable(data) {
    try {
        const { customer, plan } = data;
        console.log('Subscription disabled:', { customer, plan });
        
        // Handle subscription cancellation logic here
    } catch (error) {
        console.error('Error handling subscription disable:', error);
    }
}

// Get payment history
router.get('/history', authenticate, async (req, res) => {
    try {
        const user = req.user;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        if (!user.paystackCustomerCode) {
            return res.json({
                success: true,
                data: {
                    transactions: [],
                    pagination: {
                        currentPage: page,
                        totalPages: 0,
                        totalTransactions: 0
                    }
                }
            });
        }

        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/customer/${user.paystackCustomerCode}/transaction`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                },
                params: {
                    page,
                    perPage: limit
                }
            }
        );

        const { data, meta } = response.data;

        const transactions = data.map(transaction => ({
            reference: transaction.reference,
            amount: transaction.amount / 100,
            status: transaction.status,
            paidAt: transaction.paid_at,
            createdAt: transaction.created_at,
            channel: transaction.channel,
            currency: transaction.currency,
            metadata: transaction.metadata
        }));

        res.json({
            success: true,
            data: {
                transactions,
                pagination: {
                    currentPage: meta.page,
                    totalPages: meta.pageCount,
                    totalTransactions: meta.total
                }
            }
        });

    } catch (error) {
        console.error('Payment history error:', error.response?.data || error);
        res.status(500).json({
            success: false,
            message: 'Error fetching payment history.'
        });
    }
});

// Get subscription plans
router.get('/plans', (req, res) => {
    try {
        const plans = Object.entries(SUBSCRIPTION_PLANS).map(([key, plan]) => ({
            id: key,
            name: plan.name,
            amount: plan.amount / 100, // Convert to naira
            currency: 'NGN',
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

// Get subscription features
function getSubscriptionFeatures(subscription) {
    const features = {
        starter: [
            'Basic group tagging (tagall)',
            'Contact auto-save',
            'Basic media sharing',
            '5 active sessions',
            'Standard support'
        ],
        professional: [
            'All Starter features',
            'Advanced tagging (tagallexcept)',
            'Event & meeting scheduling',
            'Reminder management',
            '25 active sessions',
            'Priority support',
            'Basic admin controls'
        ],
        business: [
            'All Professional features',
            'Advanced admin controls',
            'Sudo user management',
            'System monitoring',
            '100 active sessions',
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

// Cancel subscription
router.post('/cancel-subscription', authenticate, async (req, res) => {
    try {
        const user = req.user;

        // Update user subscription to expire at the end of current period
        // Don't immediately revoke access, let it expire naturally
        user.paymentStatus = 'expired';
        await user.save();

        res.json({
            success: true,
            message: 'Subscription cancelled. Access will continue until expiry date.',
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

        // This would typically redirect to payment flow
        // For now, just update the user's intended subscription
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

// Get current subscription status
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

module.exports = router;