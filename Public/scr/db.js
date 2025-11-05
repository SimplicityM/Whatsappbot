// src/db.js
const mongoose = require('mongoose');
async function connect(uri, opts = {}) {
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true, ...opts });
  console.log('Connected to MongoDB');
}
module.exports = { connect, mongoose };
