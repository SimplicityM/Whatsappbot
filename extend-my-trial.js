require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

async function extendMyTrial() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('📊 Connected to MongoDB');

        // Find your user (replace with your email)
        const user = await User.findById('6914a2ed8bcd32744227189e');
        
        if (!user) {
            console.log('❌ User not found');
            process.exit(1);
        }

        console.log(`Found user: ${user.email}`);
        console.log(`Current status: ${user.paymentStatus}`);
        console.log(`Current expiry: ${user.subscriptionExpiry}`);

        // Extend trial by 7 days from now
        user.subscriptionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        user.paymentStatus = 'trial';
        await user.save();

        const daysLeft = Math.ceil((user.subscriptionExpiry - new Date()) / (1000 * 60 * 60 * 24));
        console.log(`✅ Trial extended! ${daysLeft} days remaining`);
        console.log(`New expiry: ${user.subscriptionExpiry}`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

extendMyTrial();