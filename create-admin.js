// create-admin.js
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User'); // Adjust path if needed
require('dotenv').config();

async function createAdminUser() {
    try {
        // Connect to MongoDB
        console.log('🔄 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsappbot');
        console.log('✅ Connected to MongoDB');

        // Check if admin already exists
        const adminEmail = 'tagthemall@botforall.com'; // Change this to your preferred email
        const adminPassword = 'abuusayd123$'; // Change this to your preferred password
        
        const existingAdmin = await User.findOne({ email: adminEmail });
        if (existingAdmin) {
            console.log('⚠️ Admin user already exists with email:', adminEmail);
            
            // Update existing user to be admin
            existingAdmin.role = 'system_admin';
            existingAdmin.isAdmin = true;
            existingAdmin.emailVerified = true;
            await existingAdmin.save();
            
            console.log('✅ Updated existing user to admin privileges');
            process.exit(0);
        }

        // Hash password
        console.log('🔐 Hashing password...');
        const hashedPassword = await bcrypt.hash(adminPassword, 10);

        // Create admin user
        const adminUser = new User({
            name: 'System Administrator',
            email: adminEmail,
            password: hashedPassword,
            role: 'system_admin',
            isAdmin: true,
            emailVerified: true,
            whatsappNumber: null,
            subscription: {
                planType: 'enterprise',
                status: 'active',
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year from now
            },
            createdAt: new Date(),
            lastLogin: null
        });

        await adminUser.save();

        console.log('🎉 Admin user created successfully!');
        console.log('📧 Email:', adminEmail);
        console.log('🔑 Password:', adminPassword);
        console.log('');
        console.log('🚀 You can now login at: http://localhost:3000/admin-login.html');
        console.log('');
        console.log('⚠️ IMPORTANT: Change the password after first login!');

    } catch (error) {
        console.error('❌ Error creating admin user:', error);
    } finally {
        // Close database connection
        await mongoose.connection.close();
        console.log('🔌 Database connection closed');
        process.exit(0);
    }
}

// Run the script
createAdminUser();