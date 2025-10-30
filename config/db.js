const mongoose = require('mongoose');

const connectDB = async () => {
    // Use environment variable or default to local MongoDB
    const mongoURI = process.env.mongo || 'mongodb://localhost:27017/whatsappbot';
    
    try {
        await mongoose.connect(mongoURI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error.message);
        console.log('Make sure MongoDB is running on your system');
        process.exit(1);
    }
};

module.exports = connectDB;