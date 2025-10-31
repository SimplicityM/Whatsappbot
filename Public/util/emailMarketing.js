const nodemailer = require('nodemailer'); const cron = require('node-cron');

class EmailMarketing {
    constructor() {
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: true,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
        
        this.setupCronJobs();
    }

setupCronJobs() {
    // Daily email campaigns
    cron.schedule('0 9 * * *', () => {
        this.sendDailyEmails();
    });

    // Weekly digest
    cron.schedule('0 9 * * 1', () => {
        this.sendWeeklyDigest();
    });

    // Trial expiration reminders
    cron.schedule('0 10 * * *', () => {
        this.sendTrialReminders();
    });
}

async sendWelcomeEmail(user) {
    const emailTemplate = this.getWelcomeTemplate(user);
    
    await this.transporter.sendMail({
        from: '"TagThemAll Bot" <noreply@tagthemallbot.com>',
        to: user.email,
        subject: '🎉 Welcome to TagThemAll Bot - Your Free Trial Starts Now!',
        html: emailTemplate
    });

    // Schedule follow-up emails
    this.scheduleFollowUpEmails(user);
}

async sendTrialReminders() {
    const usersNearExpiration = await User.find({
        'subscription.planType': 'free',
        'subscription.trialEndsAt': {
            $gte: new Date(),
            $lte: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) // 2 days
        },
        'emailPreferences.trialReminders': true
    });

    for (const user of usersNearExpiration) {
        await this.sendTrialExpirationEmail(user);
    }
}

async sendTrialExpirationEmail(user) {
    const daysLeft = Math.ceil((user.subscription.trialEndsAt - new Date()) / (1000 * 60 * 60 * 24));
    const usage = await this.getUserUsageStats(user._id);
    
    const emailTemplate = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Your Trial Expires Soon</title>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: white; padding: 30px; border: 1px solid #ddd; }
            .stats { background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0; }
            .cta-button { display: inline-block; background: #007bff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
            .urgency { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>⏰ Your Trial Expires in ${daysLeft} Day${daysLeft > 1 ? 's' : ''}!</h1>
            </div>
            <div class="content">
                <p>Hi ${user.name},</p>
                
                <div class="urgency">
                    <strong>Don't lose access!</strong> Your free trial ends in ${daysLeft} day${daysLeft > 1 ? 's' : ''}. Upgrade now to keep all your automations running.
                </div>

                <div class="stats">
                    <h3>📊 Your Trial Usage:</h3>
                    <ul>
                        <li><strong>${usage.messagesSent}</strong> messages automated</li>
                        <li><strong>${usage.groupsManaged}</strong> groups managed</li>
                        <li><strong>${usage.commandsUsed}</strong> commands executed</li>
                        <li><strong>${usage.timeSaved}</strong> hours saved</li>
                    </ul>
                </div>

                <p>You've already experienced the power of automation. Don't let it stop now!</p>

                <h3>🎯 Upgrade Benefits:</h3>
                <ul>
                    <li>✅ Unlimited messages and sessions</li>
                    <li>✅ Advanced automation features</li>
                    <li>✅ Priority support</li>
                    <li>✅ Advanced analytics</li>
                </ul>

                <div style="text-align: center;">
                    <a href="${process.env.DOMAIN}/pricing?utm_source=email&utm_campaign=trial_expiration&user_id=${user._id}" class="cta-button">
                        🚀 Upgrade Now - Save 20%
                    </a>
                </div>

                <p><small>This offer expires when your trial ends. Questions? Reply to this email!</small></p>
            </div>
        </div>
    </body>
    </html>
    `;

    await this.transporter.sendMail({
        from: '"TagThemAll Bot" <noreply@tagthemallbot.com>',
        to: user.email,
        subject: `⏰ ${daysLeft} day${daysLeft > 1 ? 's' : ''} left in your trial - Don't lose access!`,
        html: emailTemplate
    });
}

async sendUsageMilestoneEmail(user, milestone) {
    const milestoneTemplates = {
        first_message: {
            subject: '🎉 You sent your first automated message!',
            content: 'Congratulations! You just experienced the power of automation. This is just the beginning...'
        },
        hundred_messages: {
            subject: '💯 100 messages automated - You\'re on fire!',
            content: 'Amazing! You\'ve automated 100 messages. Imagine what you could do with unlimited access...'
        },
        limit_reached: {
            subject: '📊 You\'ve reached your daily limit',
            content: 'You\'re using TagThemAll Bot to its full potential! Ready for unlimited access?'
        }
    };

    const template = milestoneTemplates[milestone];
    if (!template) return;

    const emailContent = this.getMilestoneTemplate(user, milestone, template);

    await this.transporter.sendMail({
        from: '"TagThemAll Bot" <noreply@tagthemallbot.com>',
        to: user.email,
        subject: template.subject,
        html: emailContent
    });
}

async sendReEngagementEmail(user) {
    const lastActivity = await this.getLastActivity(user._id);
    const daysSinceActivity = Math.floor((new Date() - lastActivity) / (1000 * 60 * 60 * 24));

    const emailTemplate = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>We Miss You!</title>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: white; padding: 30px; border: 1px solid #ddd; }
                .feature-highlight { background: #f8f9fa; padding: 20px; border-left: 4px solid #007bff; margin: 20px 0; }
                .cta-button { display: inline-block; background: #28a745; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
                .tips-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; }
                .tip-card { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>👋 We Miss You, ${user.name}!</h1>
                    <p>It's been ${daysSinceActivity} days since your last visit</p>
                </div>
                <div class="content">
                    <p>Hi ${user.name},</p>
                    
                    <p>We noticed you haven't been using TagThemAll Bot lately. We wanted to check in and see if we can help you get back to automating your WhatsApp workflows!</p>

                    <div class="feature-highlight">
                        <h3>🆕 What's New Since Your Last Visit:</h3>
                        <ul>
                            <li>✨ New scheduling commands for better automation</li>
                            <li>📊 Enhanced analytics dashboard</li>
                            <li>🚀 Improved group management features</li>
                            <li>💬 24/7 customer support chat</li>
                        </ul>
                    </div>

                    <h3>💡 Quick Tips to Get Started Again:</h3>
                    <div class="tips-grid">
                        <div class="tip-card">
                            <h4>🎯 Try !tagall</h4>
                            <p>Tag all group members instantly</p>
                        </div>
                        <div class="tip-card">
                            <h4>⏰ Set Reminders</h4>
                            <p>Use !reminder for important tasks</p>
                        </div>
                        <div class="tip-card">
                            <h4>📈 Check Analytics</h4>
                            <p>See your automation impact</p>
                        </div>
                        <div class="tip-card">
                            <h4>🔧 Explore Commands</h4>
                            <p>Type !help for all features</p>
                        </div>
                    </div>

                    <div style="text-align: center;">
                        <a href="${process.env.DOMAIN}/dashboard?utm_source=email&utm_campaign=re_engagement&user_id=${user._id}" class="cta-button">
                            🚀 Continue Your Automation Journey
                        </a>
                    </div>

                    <p>Need help getting started? Just reply to this email - our team is here to help!</p>

                    <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
                    
                    <p><small>Don't want to receive these emails? <a href="${process.env.DOMAIN}/unsubscribe?token=${user.unsubscribeToken}">Unsubscribe here</a></small></p>
                </div>
            </div>
        </body>
        </html>
        `;

        await this.transporter.sendMail({
            from: '"TagThemAll Bot" <noreply@tagthemallbot.com>',
            to: user.email,
            subject: `👋 We miss you! Come back to ${daysSinceActivity} days of new features`,
            html: emailTemplate
        });
    }

    scheduleFollowUpEmails(user) {
        // Day 1: Getting started tips
        setTimeout(() => {
            this.sendGettingStartedEmail(user);
        }, 24 * 60 * 60 * 1000); // 1 day

        // Day 3: Feature showcase
        setTimeout(() => {
            this.sendFeatureShowcaseEmail(user);
        }, 3 * 24 * 60 * 60 * 1000); // 3 days

        // Day 5: Success stories
        setTimeout(() => {
            this.sendSuccessStoriesEmail(user);
        }, 5 * 24 * 60 * 60 * 1000); // 5 days
    }

    async sendGettingStartedEmail(user) {
        const emailTemplate = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Getting Started with TagThemAll Bot</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: white; padding: 30px; border: 1px solid #ddd; }
                .step { background: #f8f9fa; padding: 20px; margin: 15px 0; border-radius: 10px; border-left: 4px solid #007bff; }
                .step-number { background: #007bff; color: white; width: 30px; height: 30px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 15px; }
                .command-example { background: #2d3748; color: #68d391; padding: 10px; border-radius: 5px; font-family: monospace; margin: 10px 0; }
                .cta-button { display: inline-block; background: #007bff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🚀 Ready to Automate Your WhatsApp?</h1>
                    <p>Let's get you started with TagThemAll Bot!</p>
                </div>
                <div class="content">
                    <p>Hi ${user.name},</p>
                    
                    <p>Welcome to TagThemAll Bot! Let's get you up and running in just 3 simple steps:</p>

                    <div class="step">
                        <div style="display: flex; align-items: center;">
                            <span class="step-number">1</span>
                            <div>
                                <h3>Connect Your WhatsApp</h3>
                                <p>Scan the QR code in your dashboard to connect your WhatsApp account.</p>
                                <div class="command-example">💡 Tip: Keep WhatsApp Web closed on other devices for best performance</div>
                            </div>
                        </div>
                    </div>

                    <div class="step">
                        <div style="display: flex; align-items: center;">
                            <span class="step-number">2</span>
                            <div>
                                <h3>Try Your First Command</h3>
                                <p>Send a message to any group or chat:</p>
                                <div class="command-example">!ping</div>
                                <p>You should get a "Pong! 🏓" response - that's your bot working!</p>
                            </div>
                        </div>
                    </div>

                    <div class="step">
                        <div style="display: flex; align-items: center;">
                            <span class="step-number">3</span>
                            <div>
                                <h3>Explore More Commands</h3>
                                <p>Try these powerful automation commands:</p>
                                <div class="command-example">!help - See all available commands</div>
                                <div class="command-example">!tagall Hello everyone! - Tag all group members</div>
                                <div class="command-example">!status - Check your bot status</div>
                            </div>
                        </div>
                    </div>

                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${process.env.DOMAIN}/dashboard?utm_source=email&utm_campaign=getting_started" class="cta-button">
                            🎯 Go to Dashboard
                        </a>
                    </div>

                    <p><strong>Need Help?</strong> Our support team is here for you:</p>
                    <ul>
                        <li>📧 Reply to this email</li>
                        <li>💬 Use the chat widget on our website</li>
                        <li>📖 Check our <a href="${process.env.DOMAIN}/bot-commands.html">command guide</a></li>
                    </ul>

                    <p>Happy automating!</p>
                    <p>The TagThemAll Bot Team</p>
                </div>
            </div>
        </body>
        </html>
        `;

        await this.transporter.sendMail({
            from: '"TagThemAll Bot" <noreply@tagthemallbot.com>',
            to: user.email,
            subject: '🚀 Your 3-step guide to WhatsApp automation success',
            html: emailTemplate
        });
    }

    async getUserUsageStats(userId) {
        const usage = await Usage.findOne({ 
            userId: userId, 
            date: new Date().toISOString().split('T')[0] 
        });
        
        const totalUsage = await Usage.aggregate([
            { $match: { userId: mongoose.Types.ObjectId(userId) } },
            { 
                $group: {
                    _id: null,
                    totalMessages: { $sum: '$messagesCount' },
                    totalCommands: { $sum: { $size: '$commandsUsed' } },
                    totalGroups: { $sum: '$groupsManaged' }
                }
            }
        ]);

        const stats = totalUsage[0] || { totalMessages: 0, totalCommands: 0, totalGroups: 0 };

        return {
            messagesSent: stats.totalMessages,
            commandsUsed: stats.totalCommands,
            groupsManaged: stats.totalGroups,
            timeSaved: Math.round(stats.totalMessages * 0.5 / 60) // Estimate time saved in hours
        };
    }

    getWelcomeTemplate(user) {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Welcome to TagThemAll Bot</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: white; padding: 40px; border: 1px solid #ddd; border-radius: 0 0 10px 10px; }
                .welcome-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin: 30px 0; text-align: center; }
                .stat { background: #f8f9fa; padding: 20px; border-radius: 10px; }
                .stat-number { font-size: 2em; font-weight: bold; color: #007bff; }
                .cta-button { display: inline-block; background: #28a745; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
                .feature-list { background: #f8f9fa; padding: 25px; border-radius: 10px; margin: 25px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎉 Welcome to TagThemAll Bot!</h1>
                    <p>Your WhatsApp automation journey starts now</p>
                </div>
                <div class="content">
                    <p>Hi ${user.name},</p>
                    
                    <p>Welcome to the most powerful WhatsApp automation platform! You've just joined thousands of businesses who are saving time and increasing productivity with our bot.</p>

                    <div class="welcome-stats">
                        <div class="stat">
                            <div class="stat-number">2,847+</div>
                            <div>Active Users</div>
                        </div>
                        <div class="stat">
                            <div class="stat-number">1.2M+</div>
                            <div>Messages Automated</div>
                        </div>
                        <div class="stat">
                            <div class="stat-number">99.9%</div>
                            <div>Uptime</div>
                        </div>
                    </div>

                    <div class="feature-list">
                        <h3>🚀 What You Can Do Right Now:</h3>
                        <ul>
                            <li>✅ Tag all group members instantly with !tagall</li>
                            <li>✅ Set up automated responses</li>
                            <li>✅ Schedule messages and reminders</li>
                            <li>✅ Manage multiple WhatsApp groups</li>
                            <li>✅ Track your automation analytics</li>
                        </ul>
                    </div>

                    <div style="text-align: center;">
                        <a href="${process.env.DOMAIN}/dashboard?utm_source=email&utm_campaign=welcome&new_user=true" class="cta-button">
                            🎯 Start Your Free Trial
                        </a>
                    </div>

                    <p><strong>Your Free Trial Includes:</strong></p>
                    <ul>
                        <li>🎁 7 days of full access</li>
                        <li>🎁 50 messages per day</li>
                        <li>🎁 1 WhatsApp session</li>
                        <li>🎁 All basic commands</li>
                        <li>🎁 Email support</li>
                    </ul>

                    <p>Questions? Just reply to this email - we're here to help!</p>

                    <p>Welcome aboard!</p>
                    <p>The TagThemAll Bot Team</p>

                    <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
                    
                    <p><small>You're receiving this because you signed up for TagThemAll Bot. <a href="${process.env.DOMAIN}/unsubscribe?token=${user.unsubscribeToken}">Unsubscribe</a></small></p>
                </div>
            </div>
        </body>
        </html>
        `;
    }
}

// Initialize email marketing
const emailMarketing = new EmailMarketing();

// Usage tracking for email triggers
async function trackEmailTriggers(userId, action, data = {}) {
    const user = await User.findById(userId);
    if (!user || !user.emailPreferences.marketing) return;

    switch(action) {
        case 'first_message_sent':
            await emailMarketing.sendUsageMilestoneEmail(user, 'first_message');
            break;
        case 'hundred_messages_reached':
            await emailMarketing.sendUsageMilestoneEmail(user, 'hundred_messages');
            break;
        case 'daily_limit_reached':
            await emailMarketing.sendUsageMilestoneEmail(user, 'limit_reached');
            break;
        case 'trial_started':
            await emailMarketing.sendWelcomeEmail(user);
            break;
    }
}

module.exports = { emailMarketing, trackEmailTriggers };