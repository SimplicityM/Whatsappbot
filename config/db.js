const mongoose = require('mongoose');

const connectDB = async () => {
    if(!process.env.mongo){
        console.error('MongoDB URI is not defined in environment variables');
        process.exit(1);
    }
    
    try {
        await mongoose.connect(process.env.mongo, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
