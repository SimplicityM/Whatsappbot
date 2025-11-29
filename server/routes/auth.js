const express = require('express');
const crypto = require('crypto');
const User = require('../models/User');
const { generateToken, authenticate, verifyToken } = require('../../middleware/auth');
const { Resend } = require('resend');  // ✅ Only need Resend
const router = express.Router();
const verifyRecaptcha = require("../utils/verifyRecaptcha");

// Initialize Resend once at the top
const resend = new Resend(process.env.RESEND_API_KEY);


// Register new user with reCAPTCHA v3 protection
router.post('/register', async (req, res) => {
    try {
        const { fullName, email, password, confirmPassword, recaptchaToken, plan } = req.body; // ✅ Added plan

        console.log("🆕 Registration attempt:", email, "Plan:", plan);

        // ================================
        // 1. Basic field validation
        // ================================
        if (!fullName || !email || !password || !confirmPassword) {
            console.log("❌ Missing required fields");
            return res.status(400).json({
                success: false,
                message: 'All fields are required.'
            });
        }

        if (password !== confirmPassword) {
            console.log("❌ Passwords do not match");
            return res.status(400).json({
                success: false,
                message: 'Passwords do not match.'
            });
        }

        if (password.length < 8) {
            console.log("❌ Weak password");
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long.'
            });
        }

        if (!recaptchaToken) {
            console.log("❌ Missing recaptcha token");
            return res.status(400).json({
                success: false,
                message: "Recaptcha validation failed."
            });
        }

        // ===============================================
        // 2. Verify reCAPTCHA v3 (anti-bot protection)
        // ===============================================
        const verifyRecaptcha = require("../utils/verifyRecaptcha");
        const recaptchaResult = await verifyRecaptcha(recaptchaToken, "signup");

        if (!recaptchaResult.success) {
            console.log(`❌ Registration blocked. Low recaptcha score: ${recaptchaResult.score}`);
            return res.status(400).json({
                success: false,
                message: "Suspicious activity detected. Try again."
            });
        }

        console.log(`🛡 reCAPTCHA passed. Score: ${recaptchaResult.score}`);


        // ===============================================
        // 3. Check existing user
        // ===============================================
        const existingUser = await User.findOne({ email: email.toLowerCase() });

        if (existingUser) {
            console.log("❌ Email already registered");
            return res.status(400).json({
                success: false,
                message: 'User with this email already exists.'
            });
        }

        // ===============================================
        // 4. Create user
        // ===============================================
        console.log("📌 Creating new user record...");

        const crypto = require("crypto");
        const emailVerificationToken = crypto.randomBytes(32).toString('hex');

        const user = new User({
            fullName,
            email: email.toLowerCase(),
            password,
            emailVerificationToken,
            paymentStatus: 'trial' // Start with free trial
        });

        await user.save();

        // ===============================================
        // 5. Generate Auth Token
        // ===============================================
        const token = generateToken(user._id);

        let userResponse = user.toObject();
        delete userResponse.password;
        delete userResponse.emailVerificationToken;

        console.log("✅ Account created:", email);


        // ===============================================
        // 6. Response
        // ===============================================
        return res.status(201).json({
            success: true,
            message: 'Account created successfully!',
            data: {
                user: userResponse,
                token
            }
        });

        // const crypto = require("crypto");
        // const emailVerificationToken = crypto.randomBytes(32).toString('hex');

        // // ✅ Determine subscription plan
        // const validPlans = ['free', 'starter', 'professional', 'business', 'enterprise'];
        // const selectedPlan = validPlans.includes(plan) ? plan : 'free';
        
        // // ✅ Set payment status based on plan
        // const paymentStatus = selectedPlan === 'free' ? 'trial' : 'pending';

        // const user = new User({
        //     fullName,
        //     email: email.toLowerCase(),
        //     password,
        //     emailVerificationToken,
        //     subscription: selectedPlan, // ✅ Use selected plan
        //     paymentStatus: paymentStatus // ✅ trial for free, pending for paid
        // });

        // await user.save();

        // console.log(`✅ Account created: ${email} with ${selectedPlan} plan`);

    } catch (error) {
        console.error('❌ Registration error:', error);
        console.error("Stack:", error.stack);

        return res.status(500).json({
            success: false,
            message: 'Error creating account. Please try again.'
        });
    }
});



// Login user with reCAPTCHA v3 verification
router.post('/login', async (req, res) => {
    try {
        const { email, password, recaptchaToken } = req.body;

        console.log('🔐 Login attempt:', email);

        // ============================
        // 1. Validate required fields
        // ============================
        if (!email || !password) {
            console.log('❌ Missing credentials');
            return res.status(400).json({
                success: false,
                message: 'Email and password are required.'
            });
        }

        if (!recaptchaToken) {
            console.log('❌ Missing reCAPTCHA token');
            return res.status(400).json({
                success: false,
                message: 'Recaptcha validation failed. Try again.'
            });
        }

        // ==================================================
        // 2. Verify reCAPTCHA v3 Token (Anti-Bot Protection)
        // ==================================================
        const verifyRecaptcha = require("../utils/verifyRecaptcha");
        const recaptchaResult = await verifyRecaptcha(recaptchaToken, "login");

        if (!recaptchaResult.success) {
            console.log(`❌ Recaptcha rejected login. Score: ${recaptchaResult.score}`);
            return res.status(400).json({
                success: false,
                message: "Suspicious login attempt blocked. Try again."
            });
        }

        console.log(`🛡 reCAPTCHA passed. Score: ${recaptchaResult.score}`);


        // ============================
        // 3. Find user
        // ============================
        console.log('🔍 Looking for user:', email.toLowerCase());

        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
            console.log('❌ User not found');
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password.'
            });
        }

        console.log('✅ User found, checking password');


        // ============================
        // 4. Validate password
        // ============================
        const isPasswordValid = await user.comparePassword(password);

        if (!isPasswordValid) {
            console.log('❌ Invalid password');
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password.'
            });
        }

        console.log('✅ Password valid, generating token');


        // ============================
        // 5. Update last login time
        // ============================
        user.lastLogin = new Date();
        await user.save();


        // ============================
        // 6. Generate token
        // ============================
        const token = generateToken(user._id);

        const userResponse = user.toObject();
        delete userResponse.password;

        console.log('✅ Login successful for:', email);


        // ============================
        // 7. Respond to frontend
        // ============================
        return res.json({
            success: true,
            message: 'Login successful!',
            data: {
                user: userResponse,
                token
            }
        });

    } catch (error) {
        console.error('❌ Login error:', error);
        console.error('Error stack:', error.stack);
        
        return res.status(500).json({
            success: false,
            message: 'Error logging in. Please try again.'
        });
    }
});


// Google OAuth Login/Signup with reCAPTCHA v3 protection
// Google OAuth Login/Signup with reCAPTCHA v3 protection
router.post("/google-login", async (req, res) => {
    try {
        // ✅ Handle both 'credential' and 'token' for backward compatibility
        const { credential, token, recaptchaToken } = req.body;
        const googleCredential = credential || token;

        console.log("🔵 Google OAuth login attempt");

        // ======================================================
        // 1. Validate request fields
        // ======================================================
        if (!googleCredential) {
            console.log("❌ Missing Google credential");
            return res.status(400).json({
                success: false,
                message: "Google credential is required"
            });
        }

        if (!recaptchaToken) {
            console.log("❌ Missing reCAPTCHA token");
            return res.status(400).json({
                success: false,
                message: "Recaptcha validation failed."
            });
        }

        // ======================================================
        // 2. Verify reCAPTCHA v3 first (protects against bot abuse)
        // ======================================================
        const verifyRecaptcha = require("../utils/verifyRecaptcha");
        const recaptchaResult = await verifyRecaptcha(recaptchaToken);

        if (!recaptchaResult.success) {
            console.log(`❌ Low reCAPTCHA score (${recaptchaResult.score}). Blocking Google login.`);
            return res.status(400).json({
                success: false,
                message: "Suspicious activity detected. Try again."
            });
        }

        console.log(`🛡 reCAPTCHA passed for Google Login. Score: ${recaptchaResult.score}`);


        // ======================================================
        // 3. Verify Google OAuth Token
        // ======================================================
        const { OAuth2Client } = require("google-auth-library");
        const client = new OAuth2Client(
            process.env.GOOGLE_CLIENT_ID ||
            "1024040438272-d9emfus837hjp2oc7afvcoq11p7p1qpg.apps.googleusercontent.com"
        );

        const ticket = await client.verifyIdToken({
            idToken: googleCredential,  // ✅ Use the variable
            audience: process.env.GOOGLE_CLIENT_ID ||
                "1024040438272-d9emfus837hjp2oc7afvcoq11p7p1qpg.apps.googleusercontent.com"
        });

        const payload = ticket.getPayload();
        const { email, name, picture, sub: googleId } = payload;

        console.log("🔍 Google user:", email);


        // ======================================================
        // 4. Check if user already exists
        // ======================================================
        let user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
            // ============================================
            // 4a. Create new user from Google Account
            // ============================================
            const crypto = require("crypto");

            user = new User({
                fullName: name,
                email: email.toLowerCase(),
                password: crypto.randomBytes(32).toString("hex"), // never used
                isEmailVerified: true,
                googleId: googleId,
                profilePicture: picture,
                subscription: "free",
                paymentStatus: "trial",
                status: "active"
            });

            await user.save();
            console.log(`🆕 New Google user created: ${email}`);
        } else {
            // ============================================
            // 4b. User exists — update googleId and login time
            // ============================================
            if (!user.googleId) {
                user.googleId = googleId;
                user.isEmailVerified = true;
            }

            user.lastLogin = new Date();
            await user.save();

            console.log(`🔁 Existing user logged in via Google: ${email}`);
        }


        // ======================================================
        // 5. Generate JWT Token
        // ======================================================
        const jwtToken = generateToken(user._id);

        const userResponse = user.toObject();
        delete userResponse.password;
        delete userResponse.emailVerificationToken;


        // ======================================================
        // 6. Send Response
        // ======================================================
        return res.json({
            success: true,
            message: "Google sign-in successful!",
            data: {
                user: userResponse,
                token: jwtToken
            }
        });

    } catch (error) {
        console.error("❌ Google login error:", error);
        return res.status(500).json({
            success: false,
            message: "Google authentication failed. Please try again."
        });
    }
});

// Admin Login Route
router.post('/admin-login', async (req, res) => {
    try {
        const { email, password, isAdmin } = req.body;

        console.log('🔐 Admin login attempt for:', email);

        // Validation
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        // Find user
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            console.log('❌ Admin login failed: User not found');
            return res.status(401).json({
                success: false,
                message: 'Invalid admin credentials'
            });
        }

        // Check password
        const isPasswordValid = await user.comparePassword(password);
        if (!isPasswordValid) {
            console.log('❌ Admin login failed: Invalid password');
            return res.status(401).json({
                success: false,
                message: 'Invalid admin credentials'
            });
        }

        // Check if user is admin
        const isSystemAdmin = user.email === process.env.ADMIN_EMAIL || 
                             user.role === 'system_admin' || 
                             user.isAdmin === true;

        if (!isSystemAdmin) {
            console.log('❌ Admin login failed: User is not admin');
            console.log('User role:', user.role);
            console.log('User isAdmin:', user.isAdmin);
            console.log('Admin email from env:', process.env.ADMIN_EMAIL);
            return res.status(403).json({
                success: false,
                message: 'Access denied. Admin privileges required.'
            });
        }

        // Generate token
        const token = generateToken(user._id);

        // Update last login
        user.lastLogin = new Date();
        await user.save();

        console.log('✅ Admin login successful for:', email);

        // Remove password from response
        const userResponse = user.toObject();
        delete userResponse.password;

        res.json({
            success: true,
            message: 'Admin login successful',
            data: {
                token,
                user: {
                    id: user._id,
                    email: user.email,
                    fullName: user.fullName,
                    role: user.role || 'system_admin',
                    isAdmin: true,
                    subscription: user.subscription
                }
            }
        });

    } catch (error) {
        console.error('❌ Admin login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during admin login'
        });
    }
});

// Admin Token Verification Route
router.get('/admin/verify-token', async (req, res) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'No token provided'
            });
        }

        const decoded = verifyToken(token);
        const user = await User.findById(decoded.userId).select('-password');

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token'
            });
        }

        // Check if user is admin
        const isSystemAdmin = user.email === process.env.ADMIN_EMAIL || 
                             user.role === 'system_admin' || 
                             user.isAdmin === true;

        if (!isSystemAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Admin privileges required'
            });
        }

        res.json({
            success: true,
            user: {
                id: user._id,
                email: user.email,
                fullName: user.fullName,
                role: user.role || 'system_admin',
                isAdmin: true
            }
        });

    } catch (error) {
        console.error('❌ Token verification error:', error);
        res.status(401).json({
            success: false,
            message: 'Invalid token'
        });
    }
});

// Get current user profile
router.get('/profile', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password');

        res.json({
            success: true,
            data: { user }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching profile.'
        });
    }
});

// Update user profile
router.put('/profile', authenticate, async (req, res) => {
    try {
        const { fullName, email } = req.body;
        const user = req.user;

        if (fullName) user.fullName = fullName;
        if (email && email !== user.email) {
            // Check if email is already taken
            const existingUser = await User.findOne({ 
                email: email.toLowerCase(),
                _id: { $ne: user._id }
            });
            
            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    message: 'Email is already in use.'
                });
            }
            
            user.email = email.toLowerCase();
            user.isEmailVerified = false;
        }

        await user.save();

        const userResponse = user.toObject();
        delete userResponse.password;

        res.json({
            success: true,
            message: 'Profile updated successfully!',
            data: { user: userResponse }
        });

    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating profile.'
        });
    }
});

// Change user password with reCAPTCHA v3 protection
router.put('/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword, recaptchaToken } = req.body;

        console.log("🔐 Change password request from user:", req.user._id);

        // ========================================
        // 1. Basic Validation
        // ========================================
        if (!currentPassword || !newPassword || !confirmPassword) {
            console.log("❌ Missing password fields");
            return res.status(400).json({
                success: false,
                message: 'All password fields are required.'
            });
        }

        if (newPassword !== confirmPassword) {
            console.log("❌ Password mismatch");
            return res.status(400).json({
                success: false,
                message: 'New passwords do not match.'
            });
        }

        if (newPassword.length < 8) {
            console.log("❌ Weak password");
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long.'
            });
        }

        if (!recaptchaToken) {
            console.log("❌ Missing reCAPTCHA token");
            return res.status(400).json({
                success: false,
                message: "Recaptcha validation failed. Try again."
            });
        }

        // ========================================
        // 2. Verify reCAPTCHA v3
        // ========================================
        const verifyRecaptcha = require("../utils/verifyRecaptcha");
        const recaptchaResult = await verifyRecaptcha(recaptchaToken, "change_password");

        if (!recaptchaResult.success) {
            console.log(`❌ reCAPTCHA rejected password change. Score: ${recaptchaResult.score}`);
            return res.status(400).json({
                success: false,
                message: "Suspicious activity detected. Try again."
            });
        }

        console.log(`🛡 reCAPTCHA passed. Score: ${recaptchaResult.score}`);


        // ========================================
        // 3. Validate Current Password
        // ========================================
        const user = await User.findById(req.user._id);

        if (!user) {
            console.log("❌ User not found during password change");
            return res.status(404).json({
                success: false,
                message: 'User not found.'
            });
        }

        const isCurrentPasswordValid = await user.comparePassword(currentPassword);

        if (!isCurrentPasswordValid) {
            console.log("❌ Incorrect current password");
            return res.status(400).json({
                success: false,
                message: 'Current password is incorrect.'
            });
        }

        console.log("🔑 Current password verified. Updating password...");


        // ========================================
        // 4. Update Password
        // ========================================
        user.password = newPassword;
        await user.save();

        console.log("✅ Password changed successfully for:", req.user._id);


        // ========================================
        // 5. Respond
        // ========================================
        return res.json({
            success: true,
            message: 'Password changed successfully!'
        });

    } catch (error) {
        console.error('❌ Change password error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error changing password.'
        });
    }
});


// Logout
router.post('/logout', authenticate, (req, res) => {
    res.json({ 
        success: true, 
        message: 'Logged out successfully!' 
    });
});

// Forgot password
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required.'
            });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'No account found with this email address.'
            });
        }

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        user.resetPasswordToken = resetToken;
        user.resetPasswordExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        await user.save();

        // Send reset email using Resend
        const resetUrl = `${process.env.FRONTEND_URL}/reset-password.html?token=${resetToken}`;

        const { data, error } = await resend.emails.send({
            from: 'TagThemAll Bot <onboarding@resend.dev>',
            to: [user.email],
            subject: 'Password Reset Request - TagThemAll Bot',
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                        .header { background: #4CAF50; color: white; padding: 20px; text-align: center; border-radius: 5px; }
                        .content { background: #f9f9f9; padding: 30px; border-radius: 5px; margin-top: 20px; }
                        .button { display: inline-block; padding: 12px 30px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                        .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
                        .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>🔐 Password Reset Request</h1>
                        </div>
                        <div class="content">
                            <h2>Hello ${user.fullName},</h2>
                            <p>We received a request to reset your password for your TagThemAll Bot account.</p>
                            
                            <p><strong>Click the button below to reset your password:</strong></p>
                            <a href="${resetUrl}" class="button">Reset Password</a>
                            
                            <p>Or copy and paste this link into your browser:</p>
                            <p style="word-break: break-all; color: #4CAF50;">${resetUrl}</p>
                            
                            <div class="warning">
                                <p><strong>⏰ Important:</strong> This link will expire in <strong>10 minutes</strong>.</p>
                            </div>
                            
                            <p>If you didn't request this password reset, please ignore this email. Your password will remain unchanged.</p>
                            
                            <p>For security reasons, never share this link with anyone.</p>
                        </div>
                        <div class="footer">
                            <p>© 2024 TagThemAll Bot. All rights reserved.</p>
                            <p>This is an automated email. Please do not reply.</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (error) {
            console.error('Resend error:', error);
            return res.status(500).json({
                success: false,
                message: 'Error sending reset email. Please try again later.'
            });
        }

        console.log('Reset email sent:', data);
        
        res.json({
            success: true,
            message: 'Password reset instructions sent to your email.'
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing password reset request. Please try again later.'
        });
    }
});

// Reset password with reCAPTCHA v3 protection
router.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword, confirmPassword, recaptchaToken } = req.body;

        console.log("🔧 Password reset attempt");

        // ===========================================
        // 1. Basic Validation
        // ===========================================
        if (!token || !newPassword || !confirmPassword) {
            console.log("❌ Missing required fields");
            return res.status(400).json({
                success: false,
                message: 'All fields are required.'
            });
        }

        if (newPassword !== confirmPassword) {
            console.log("❌ Password mismatch");
            return res.status(400).json({
                success: false,
                message: 'Passwords do not match.'
            });
        }

        if (newPassword.length < 8) {
            console.log("❌ Weak password");
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long.'
            });
        }

        if (!recaptchaToken) {
            console.log("❌ Missing reCAPTCHA token");
            return res.status(400).json({
                success: false,
                message: "Recaptcha validation failed."
            });
        }

        // ===========================================
        // 2. Verify reCAPTCHA v3 (anti-bot protection)
        // ===========================================
        const verifyRecaptcha = require("../utils/verifyRecaptcha");
        const recaptchaResult = await verifyRecaptcha(recaptchaToken, "reset_password");

        if (!recaptchaResult.success) {
            console.log(`❌ Low recaptcha score ${recaptchaResult.score}. Blocking reset.`);
            return res.status(400).json({
                success: false,
                message: "Suspicious activity detected. Try again."
            });
        }

        console.log(`🛡 reCAPTCHA passed. Score: ${recaptchaResult.score}`);


        // ===========================================
        // 3. Find User With Valid Reset Token
        // ===========================================
        console.log("🔍 Checking password reset token...");

        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: new Date() }
        });

        if (!user) {
            console.log("❌ Invalid or expired reset token");
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired reset token.'
            });
        }

        console.log("🔑 Reset token valid. Updating password...");


        // ===========================================
        // 4. Update Password + Clear Reset Token
        // ===========================================
        user.password = newPassword;
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;

        await user.save();

        console.log("✅ Password reset successful for:", user.email);


        // ===========================================
        // 5. Success Response
        // ===========================================
        return res.json({
            success: true,
            message: 'Password reset successfully!'
        });

    } catch (error) {
        console.error('❌ Reset password error:', error);

        return res.status(500).json({
            success: false,
            message: 'Error resetting password.'
        });
    }
});


module.exports = router;