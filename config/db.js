const mongoose = require('mongoose');

const connectDB = async () => {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsappbot';
    
    try {
        await mongoose.connect(mongoURI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 30000, // 30 seconds
            socketTimeoutMS: 45000, // 45 seconds
            bufferMaxEntries: 0,
            maxPoolSize: 10,
        });
        console.log('✅ MongoDB connected successfully');
        console.log(`📊 Database: ${mongoose.connection.name}`);
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        
        // Fallback to local MongoDB for development
        if (process.env.NODE_ENV !== 'production') {
            console.log('🔄 Attempting to connect to local MongoDB...');
            try {
                await mongoose.connect('mongodb://localhost:27017/whatsappbot', {
                    useNewUrlParser: true,
                    useUnifiedTopology: true,
                });
                console.log('✅ Connected to local MongoDB');
                return;
            } catch (localError) {
                console.error('❌ Local MongoDB also failed:', localError.message);
            }
        }
        
        console.log('💡 Troubleshooting steps:');
        console.log('1. Check your internet connection');
        console.log('2. Verify MongoDB Atlas Network Access settings');
        console.log('3. Confirm your MONGODB_URI in .env file');
        console.log('4. Check if your IP is whitelisted in Atlas');
        
        process.exit(1);
    }
};

module.exports = connectDB;