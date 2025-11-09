// fix-owner.js
const mongoose = require('mongoose');
const User = require('./models/User');
require('dotenv').config();

async function fixOwnerUser() {
    try {
        console.log('🔄 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsappbot');
        console.log('✅ Connected to MongoDB');

        // Find your user by ID
        const userId = '68f8cc03463c75fb02668fd1';
        const user = await User.findById(userId);
        
        if (!user) {
            console.log('❌ User not found');
            return;
        }

        console.log('📱 Current user data:', {
            id: user._id,
            email: user.email,
            whatsappNumber: user.whatsappNumber,
            isOwner: user.isOwner,
            exemptFromPayment: user.exemptFromPayment,
            subscription: user.subscription
        });

        // Update user to be the owner
        await User.findByIdAndUpdate(userId, {
            whatsappNumber: '2347067012884',
            phone: '2347067012884',
            isOwner: true,
            exemptFromPayment: true,
            isAdmin: true,
            adminLevel: 'owner',
            exemptionReason: 'Bot owner privileges',
            status: 'active',
            paymentStatus: 'paid',
            subscription: 'enterprise'
        });

        console.log('✅ User updated with owner privileges');
        
        // Verify the update
        const updatedUser = await User.findById(userId);
        console.log('📱 Updated user data:', {
            id: updatedUser._id,
            email: updatedUser.email,
            whatsappNumber: updatedUser.whatsappNumber,
            isOwner: updatedUser.isOwner,
            exemptFromPayment: updatedUser.exemptFromPayment,
            subscription: updatedUser.subscription
        });

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
}

fixOwnerUser();