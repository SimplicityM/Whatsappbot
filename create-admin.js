// create-admin.js - FIXED VERSION
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User');
require('dotenv').config();

async function createAdminUser() {
    try {
        // Connect to MongoDB
        console.log('🔄 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsappbot');
        console.log('✅ Connected to MongoDB');

        // Admin credentials
        const adminEmail = 'tagthemall@botforall.com';
        const adminPassword = 'abuusayd2323$'; // Must be at least 8 characters
        
        // Check if admin already exists
        const existingAdmin = await User.findOne({ email: adminEmail });
        if (existingAdmin) {
            console.log('⚠️ Admin user already exists with email:', adminEmail);
            
            // Update existing user to be admin
            existingAdmin.role = 'system_admin';
            existingAdmin.isAdmin = true;
            existingAdmin.emailVerified = true;
            await existingAdmin.save();
            
            console.log('✅ Updated existing user to admin privileges');
            console.log('📧 Email:', adminEmail);
            console.log('🔑 Use your existing password');
            process.exit(0);
        }

        // Hash password
        console.log('🔐 Hashing password...');
        const hashedPassword = await bcrypt.hash(adminPassword, 10);

        // Create admin user with correct field names
        const adminUser = new User({
            fullName: 'System Administrator', // This was missing!
            email: adminEmail,
            password: hashedPassword,
            role: 'system_admin', // This matches your enum
            subscription: 'enterprise', // This should be a string, not object
            subscriptionExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
            isAdmin: true,
            emailVerified: true,
            whatsappNumber: null,
            phone: null,
            sessionId: null,
            createdAt: new Date(),
            lastLogin: null
        });

        await adminUser.save();

        console.log('🎉 Admin user created successfully!');
        console.log('📧 Email:', adminEmail);
        console.log('🔑 Password:', adminPassword);
        console.log('👤 Full Name: System Administrator');
        console.log('🎯 Role: system_admin');
        console.log('💎 Subscription: enterprise');
        console.log('');
        console.log('🚀 You can now login at: http://localhost:3000/admin-login.html');
        console.log('');
        console.log('⚠️ IMPORTANT: Change the password after first login!');

    } catch (error) {
        console.error('❌ Error creating admin user:', error);
        
        if (error.code === 11000) {
            console.log('💡 Tip: User with this email already exists. Try a different email.');
        }
    } finally {
        // Close database connection
        await mongoose.connection.close();
        console.log('🔌 Database connection closed');
        process.exit(0);
    }
}

// Run the script
createAdminUser();