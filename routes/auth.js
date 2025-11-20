const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const { generateToken, authenticate, verifyToken } = require('../middleware/auth');
const nodemailer = require('nodemailer');
const router = express.Router();


// Register new user
router.post('/register', async (req, res) => {
    try {
        const { fullName, email, password, confirmPassword } = req.body;

        // Validation
        if (!fullName || !email || !password || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required.'
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Passwords do not match.'
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long.'
            });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'User with this email already exists.'
            });
        }

        // Create new user
        const emailVerificationToken = crypto.randomBytes(32).toString('hex');
        const user = new User({
            fullName,
            email: email.toLowerCase(),
            password,
            emailVerificationToken,
            paymentStatus: 'trial' // Start with trial
        });

        await user.save();

        // Generate token
        const token = generateToken(user._id);

        // Remove password from response
        const userResponse = user.toObject();
        delete userResponse.password;
        delete userResponse.emailVerificationToken;

        res.status(201).json({
            success: true,
            message: 'Account created successfully!',
            data: {
                user: userResponse,
                token
            }
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating account. Please try again.'
        });
    }
});

// Login user
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required.'
            });
        }

        // Find user
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password.'
            });
        }

        // Check password
        const isPasswordValid = await user.comparePassword(password);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password.'
            });
        }

        // Update last login
        user.lastLogin = new Date();
        await user.save();

        // Generate token
        const token = generateToken(user._id);

        // Remove password from response
        const userResponse = user.toObject();
        delete userResponse.password;

        res.json({
            success: true,
            message: 'Login successful!',
            data: {
                user: userResponse,
                token
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Error logging in. Please try again.'
        });
    }
});

// Admin Login Route - Add this after the regular login route
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

// Admin Token Verification Route - Add this too
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

// Change password
router.put('/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'All password fields are required.'
            });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'New passwords do not match.'
            });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long.'
            });
        }

        // Verify current password
        const user = await User.findById(req.user._id);
        const isCurrentPasswordValid = await user.comparePassword(currentPassword);
        
        if (!isCurrentPasswordValid) {
            return res.status(400).json({
                success: false,
                message: 'Current password is incorrect.'
            });
        }

        // Update password
        user.password = newPassword;
        await user.save();

        res.json({
            success: true,
            message: 'Password changed successfully!'
        });

    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Error changing password.'
        });
    }
});

// Logout (if using token blacklist)
router.post('/logout', authenticate, (req, res) => {
    // In a real app, you might want to blacklist the token
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
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);

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
            message: 'Password reset instructions sent to your email.',
            // Remove this in production - only for testing
            resetToken: process.env.NODE_ENV === 'development' ? resetToken : undefined
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing password reset request. Please try again later.'
        });
    }
});

// Create transporter (you can also move this to a separate config file)
const transporter = nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Reset password
router.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword, confirmPassword } = req.body;

        if (!token || !newPassword || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required.'
            });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Passwords do not match.'
            });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long.'
            });
        }

        // Find user with valid reset token
        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: new Date() }
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired reset token.'
            });
        }

        // Update password and clear reset token
        user.password = newPassword;
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;
        await user.save();

        res.json({
            success: true,
            message: 'Password reset successfully!'
        });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Error resetting password.'
        });
    }
});



module.exports = router;