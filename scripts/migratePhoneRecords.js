require('dotenv').config();   // <-- REQUIRED!

const mongoose = require('mongoose');
const Session = require('../models/Session');
const PhoneRecord = require('../models/PhoneRecord');
const User = require('../models/User');

(async () => {
  try {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
      console.error("❌ ERROR: MONGODB_URI is missing in environment variables");
      process.exit(1);
    }

    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log("✅ Connected to MongoDB");

    const sessions = await Session.find({ phone: { $exists: true, $ne: null } });

    for (const s of sessions) {
      const phone = s.phone;
      if (!phone) continue;

      const existing = await PhoneRecord.findOne({ phone });
      if (existing) continue;

      const startDate = s.createdAt || new Date();
      const expireDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

      await PhoneRecord.create({
        phone,
        trialUsed: true,
        usedByUserId: s.userId,
        trialStartedAt: startDate,
        trialExpiresAt: expireDate
      });

      console.log(`📌 PhoneRecord created for ${phone}`);
    }

    console.log("🎉 Migration completed.");
    process.exit(0);

  } catch (error) {
    console.error("❌ Migration error:", error);
    process.exit(1);
  }
})();
