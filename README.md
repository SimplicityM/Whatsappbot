# Baileys WhatsApp Bot - Full Build (Multi-session + MongoDB + Paystack + Auto-contacts)

This package contains a modular Baileys-based WhatsApp bot designed to integrate with a dashboard.
Features:
- Multi-session Baileys sessions (QR via Socket.IO)
- MongoDB (Mongoose) models: User, Session, Contact, Payment
- Auto-create Contact when a new WhatsApp contact messages a connected session
- Contact saved under the session owner's email and ownerUserId
- Admin-visible contacts (contacts collection can be queried by admin)
- Paystack integration: initialize transaction and verify webhook to activate/renew subscriptions
- Subscription enforcement: bot blocks commands if subscription inactive/expired
- Dockerfile and .env.example included

Drop this into your project, run `npm install` with dependencies listed in package.json, and start the express server.

Note: edit `.env` with your MONGO_URI and PAYSTACK secret and CALLBACK_URL before running.
