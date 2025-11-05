// server.js (updated)
// Replaces your existing server.js — includes Paystack init, secure webhook, admin contact endpoints, CSV export, input validation.

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const User = require('./models/User');
const Session = require('./models/Session');
const Contact = require('./models/Contact');
const Payment = require('./models/Payment');

const { authenticate, authenticateAdmin } = require('./middleware/auth');
const { createBotSession } = require('./bot'); // your bot create function

const app = express();
const server = http.createServer(app);
const io = new socketIo.Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// static files and CSP (kept from original)
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.socket.io https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
    "connect-src 'self' ws: wss: https: http://localhost:* ws://localhost:*; " +
    "img-src 'self' data: https: blob:; object-src 'none'; base-uri 'self';"
  );
  next();
});

// DB connect
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoURI) throw new Error('MONGODB_URI environment variable is not defined');
    await mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✅ Connected to MongoDB:', mongoose.connection.name);
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
};
connectDB().catch(console.error);

// Socket.io basic
io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);
  socket.on('joinRoom', (room) => {
    if (room) socket.join(room);
  });
  socket.on('disconnect', () => console.log('Socket disconnected', socket.id));
});

// --- Paystack initialize endpoint ---
// POST /api/payments/initialize
// Body: { userId, planId }  (optionally email or amount override)
// Returns: { authorization_url, access_url, reference, payment }
app.post('/api/payments/initialize', authenticate, async (req, res) => {
  try {
    const { planId, amount } = req.body;
    const userId = req.user.id;

    // Basic validation
    if (!planId && !amount) {
      return res.status(400).json({ success: false, message: 'planId or amount is required' });
    }

    // Determine amount from planId if not provided (example mapping)
    const planAmounts = { starter: 2900, professional: 7900 };
    const chosenAmount = amount || planAmounts[planId] || 2900;

    // Get user email to pass to Paystack
    const user = await User.findById(userId);
    if (!user || !user.email) {
      return res.status(400).json({ success: false, message: 'User email not found; provide an email in profile' });
    }

    const reference = `paystack_${userId}_${Date.now()}`;
    const payload = {
      email: user.email,
      amount: chosenAmount * 100, // Paystack expects kobo (NGN) or cents
      reference,
      metadata: { userId, planId }
    };

    const initUrl = process.env.PAYSTACK_INITIALIZE_URL || 'https://api.paystack.co/transaction/initialize';
    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) return res.status(500).json({ success: false, message: 'Paystack secret not configured' });

    const resp = await axios.post(initUrl, payload, {
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    if (!resp?.data?.status) {
      return res.status(502).json({ success: false, message: 'Paystack initialize failed' });
    }

    // Save pending payment
    const payment = new Payment({
      reference,
      userId,
      amount: chosenAmount,
      currency: (resp.data.data.currency || 'NGN'),
      status: 'pending',
      metadata: payload.metadata
    });
    await payment.save();

    return res.json({
      success: true,
      authorization_url: resp.data.data.authorization_url,
      access_url: resp.data.data.access_url || null,
      reference,
      paymentId: payment._id
    });
  } catch (err) {
    console.error('Paystack initialize error:', err?.response?.data || err.message);
    return res.status(500).json({ success: false, message: 'Failed to initialize payment' });
  }
});

// --- Paystack webhook with HMAC verification ---
// Paystack sends 'x-paystack-signature' header which is HMAC SHA512 of payload using your secret
app.post('/api/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body; // Buffer
    const signature = (req.headers['x-paystack-signature'] || req.headers['x-paystack-signature'.toLowerCase()]) || null;
    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) {
      console.warn('Webhook received but PAYSTACK_SECRET not configured');
      return res.status(500).end();
    }

    // Compute HMAC-SHA512 and compare timing-safe
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    if (!signature || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
      console.warn('Paystack webhook signature mismatch');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    // Parse JSON safely
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      console.error('Invalid webhook JSON payload', e);
      return res.status(400).end();
    }

    // Basic structure validation
    if (!event.event || !event.data) {
      console.warn('Invalid webhook structure');
      return res.status(400).end();
    }

    const reference = event?.data?.reference;
    if (!reference) return res.status(400).end();

    // For safety, verify with Paystack confirm endpoint (optional but recommended)
    // Note: you can skip this for lower latency, but verification is stronger
    try {
      const verifyUrl = `${process.env.PAYSTACK_VERIFY_URL || 'https://api.paystack.co/transaction/verify'}/${reference}`;
      const verifyResp = await axios.get(verifyUrl, { headers: { Authorization: `Bearer ${secret}` }, timeout: 10000 });
      const verified = verifyResp.data;
      const status = verified?.data?.status;

      // Update payment record
      await Payment.findOneAndUpdate(
        { reference },
        { status: status === 'success' ? 'success' : 'failed', metadata: verified.data || event.data },
        { upsert: true, new: true }
      );

      if (status === 'success') {
        const metadata = verified.data?.metadata || event.data?.metadata || {};
        const userid = metadata.userId || metadata.userID || metadata.user;
        if (userid) {
          // Enable subscription for 30 days as example
          await User.findOneAndUpdate(
            { dashboardUserId: userid },
            { $set: { 'subscription.active': true, 'subscription.expiresAt': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } },
            { upsert: true }
          );
          // Notify dashboard via socket room (if connected)
          io.to(`user-${userid}`).emit('paymentSuccess', { reference, message: 'Payment verified and subscription activated' });
        }
      }

    } catch (verifyErr) {
      // If verification failed, still try to update payment with event info
      console.error('Paystack verification failure (but webhook was signed).', verifyErr?.response?.data || verifyErr.message);
      await Payment.findOneAndUpdate({ reference }, { status: 'failed', metadata: event.data }, { upsert: true });
    }

    // Acknowledge webhook
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Paystack webhook handling error:', err);
    res.status(500).end();
  }
});

// --- Admin: list contacts (paginated & filterable) ---
// GET /api/admin/contacts?ownerUserId=&ownerEmail=&page=1&limit=50&fromDate=&toDate=
// admin-only route
app.get('/api/admin/contacts', authenticateAdmin, async (req, res) => {
  try {
    const { ownerUserId, ownerEmail, page = 1, limit = 50, fromDate, toDate } = req.query;
    const filter = {};
    if (ownerUserId) filter.ownerUserId = ownerUserId;
    if (ownerEmail) filter.ownerEmail = ownerEmail;
    if (fromDate || toDate) filter.firstContactedAt = {};
    if (fromDate) filter.firstContactedAt.$gte = new Date(fromDate);
    if (toDate) filter.firstContactedAt.$lte = new Date(toDate);

    const skip = (Math.max(parseInt(page, 10), 1) - 1) * Math.max(parseInt(limit, 10), 1);
    const docs = await Contact.find(filter).sort({ firstContactedAt: -1 }).skip(skip).limit(parseInt(limit, 10));
    const total = await Contact.countDocuments(filter);
    res.json({ success: true, data: { total, page: parseInt(page, 10), limit: parseInt(limit, 10), contacts: docs } });
  } catch (err) {
    console.error('Admin contacts error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch contacts' });
  }
});

// --- Admin: export CSV of contacts ---
// GET /api/admin/contacts/export?ownerUserId=&ownerEmail=&fromDate=&toDate=
app.get('/api/admin/contacts/export', authenticateAdmin, async (req, res) => {
  try {
    const { ownerUserId, ownerEmail, fromDate, toDate } = req.query;
    const filter = {};
    if (ownerUserId) filter.ownerUserId = ownerUserId;
    if (ownerEmail) filter.ownerEmail = ownerEmail;
    if (fromDate || toDate) filter.firstContactedAt = {};
    if (fromDate) filter.firstContactedAt.$gte = new Date(fromDate);
    if (toDate) filter.firstContactedAt.$lte = new Date(toDate);

    const cursor = Contact.find(filter).cursor();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${Date.now()}.csv"`);

    // CSV header
    res.write('ownerUserId,ownerEmail,contactNumber,contactName,firstContactedAt,lastContactedAt,advertConsent\n');

    // Stream rows
    cursor.on('data', (doc) => {
      const row = [
        `"${(doc.ownerUserId || '').toString().replace(/"/g, '""')}"`,
        `"${(doc.ownerEmail || '').toString().replace(/"/g, '""')}"`,
        `"${(doc.contactNumber || '').toString().replace(/"/g, '""')}"`,
        `"${(doc.contactName || '').toString().replace(/"/g, '""')}"`,
        `"${doc.firstContactedAt ? doc.firstContactedAt.toISOString() : ''}"`,
        `"${doc.lastContactedAt ? doc.lastContactedAt.toISOString() : ''}"`,
        `"${doc.advertConsent ? 'true' : 'false'}"`
      ].join(',');
      res.write(row + '\n');
    });

    cursor.on('end', () => {
      res.end();
    });

    cursor.on('error', (err) => {
      console.error('CSV stream error', err);
      res.status(500).end();
    });
  } catch (err) {
    console.error('Export contacts error', err);
    res.status(500).json({ success: false, message: 'Failed to export contacts' });
  }
});

// --- Keep existing session creation route but add ownerEmail param and simple input validation ---
// POST /api/sessions/create body: { userId, ownerEmail }
app.post('/api/sessions/create', authenticate, async (req, res) => {
  try {
    const { ownerEmail } = req.body;
    const userId = req.user.id;
    const sessionId = `session-${userId}-${Date.now()}`;

    if (!userId) return res.status(400).json({ success: false, message: 'userId missing' });
    // Optional: validate email
    if (ownerEmail && typeof ownerEmail !== 'string') return res.status(400).json({ success: false, message: 'invalid ownerEmail' });

    // Create bot session — pass ownerEmail to session create so sessionManager stores it
    await createBotSession(userId, sessionId, io, { ownerEmail });
    return res.json({ success: true, data: { sessionId } });
  } catch (err) {
    console.error('Session create API error', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to create session' });
  }
});

// Keep your other routes / public pages
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/user'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/payments', require('./routes/payments'));

// Public pages (unchanged)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/payment', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payment.html')));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Export existing function(s) if other modules rely on them
module.exports = { io };

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  // If you need to destroy active whatsapp clients, do it here (refer to your bot manager)
  await mongoose.connection.close();
  process.exit(0);
});



// server.js (auto WhatsApp payment link + verify endpoint)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const { createBotSession, clients } = require('./sessionManager');
const User = require('./models/User');
const Payment = require('./models/Payment');

const app = express();
const server = http.createServer(app);
const io = new socketIo.Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize payment and send link via WhatsApp
app.post('/api/payments/initialize', async (req, res) => {
  try {
    const { userId, sessionId, planId, amount } = req.body;
    if (!userId || !sessionId) return res.status(400).json({ success: false, message: 'userId and sessionId required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const planAmounts = { starter: 2900, professional: 7900 };
    const chosenAmount = amount || planAmounts[planId] || 2900;

    const reference = `paystack_${userId}_${Date.now()}`;
    const payload = { email: user.email, amount: chosenAmount * 100, reference, metadata: { userId, sessionId, planId } };

    const resp = await axios.post('https://api.paystack.co/transaction/initialize', payload, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
    });

    const payment = new Payment({ reference, userId, amount: chosenAmount, status: 'pending', metadata: payload.metadata });
    await payment.save();

    const link = resp.data.data.authorization_url;
    const client = clients.get(sessionId);
    if (client?.sock) {
      await client.sock.sendMessage(client.sock.user.id, {
        text: `💳 *Payment Link*\nHello! Please complete your subscription payment below:\n${link}\n\nOnce payment is confirmed, your bot will automatically be reactivated ✅`,
      });
      io.to(`user-${userId}`).emit('paymentLinkSent', { link, reference });
    }

    res.json({ success: true, authorization_url: link, reference });
  } catch (err) {
    console.error('Payment init error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to initialize payment' });
  }
});

// Verify payment status for frontend payment.html
app.get('/api/payments/verify', async (req, res) => {
  try {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ success: false, message: 'reference required' });
    const verify = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` },
    });
    const data = verify.data?.data;
    if (data?.status === 'success') {
      await Payment.findOneAndUpdate({ reference }, { status: 'success' });
      return res.json({ success: true, status: 'success', amount: data.amount / 100 });
    }
    return res.json({ success: false, status: data?.status || 'failed' });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// Serve payment.html confirmation
app.get('/payment', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));


// server.js (updated to include subscription job)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
require('dotenv').config();

const { startSubscriptionJob } = require('./src/jobs/subscriptionJob');
const { clients } = require('./sessionManager');

const app = express();
const server = http.createServer(app);
const io = new socketIo.Server(server, { cors: { origin: '*' } });

// DB connect
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err.message));

// Start subscription job
startSubscriptionJob(io);

app.get('/', (req, res) => res.send('Server running with subscription job.'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
