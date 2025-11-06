// src/payments/paystack.js
const axios = require('axios');
const Payment = require('../models/Payment');
const INIT_URL = process.env.PAYSTACK_INITIALIZE_URL || 'https://api.paystack.co/transaction/initialize';
const VERIFY_URL = process.env.PAYSTACK_VERIFY_URL || 'https://api.paystack.co/transaction/verify';
async function initializeTransaction(email, amount, reference, metadata = {}) {
  const key = process.env.PAYSTACK_SECRET;
  if (!key) throw new Error('PAYSTACK_SECRET not set');
  const payload = { email, amount, reference, metadata };
  const res = await axios.post(INIT_URL, payload, { headers: { Authorization: `Bearer ${key}` } });
  const data = res.data;
  const p = new Payment({ reference, userId: metadata.userId || 'unknown', amount, status: 'pending', metadata });
  await p.save();
  return data;
}
async function verifyTransaction(reference) {
  const key = process.env.PAYSTACK_SECRET;
  if (!key) throw new Error('PAYSTACK_SECRET not set');
  const res = await axios.get(`${VERIFY_URL}/${reference}`, { headers: { Authorization: `Bearer ${key}` } });
  return res.data;
}
module.exports = { initializeTransaction, verifyTransaction };
