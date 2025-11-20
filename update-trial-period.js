require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

async function updateTrialPeriods() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('📊 Connected to MongoDB');

        // Update all trial users to have 7 days from their creation date
        const trialUsers = await User.find({ paymentStatus: 'trial' });
        
        console.log(`Found ${trialUsers.length} trial users`);

        for (const user of trialUsers) {
            const createdAt = user.createdAt || new Date();
            const newExpiry = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
            
            user.subscriptionExpiry = newExpiry;
            await user.save();
            
            const daysLeft = Math.ceil((newExpiry - new Date()) / (1000 * 60 * 60 * 24));
            console.log(`✅ Updated ${user.email}: ${daysLeft} days remaining`);
        }

        console.log('✅ All trial periods updated!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

updateTrialPeriods();