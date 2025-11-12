// make-user-admin.js
const mongoose = require('mongoose');
const User = require('./models/User');
require('dotenv').config();

async function makeUserAdmin() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsappbot');
        console.log('✅ Connected to MongoDB');

        const email = 'tagthemall@botforall.com';
        
        // Find the user
        const user = await User.findOne({ email: email.toLowerCase() });
        
        if (!user) {
            console.log('❌ User not found with email:', email);
            console.log('💡 You need to sign up first at: http://localhost:3000/signup.html');
            return;
        }

        console.log('📋 Current user details:');
        console.log('Name:', user.fullName);
        console.log('Email:', user.email);
        console.log('Role:', user.role);
        console.log('isAdmin:', user.isAdmin);

        // Make user admin
        user.role = 'system_admin';
        user.isAdmin = true;
        await user.save();

        console.log('\n✅ User updated to admin successfully!');
        console.log('👑 Role:', user.role);
        console.log('🛡️ isAdmin:', user.isAdmin);
        console.log('\n🚀 You can now login at: http://localhost:3000/admin-login.html');
        console.log('📧 Email: tagthemall@botforall.com');
        console.log('🔑 Password: abuusayd101010$');

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
}

makeUserAdmin();