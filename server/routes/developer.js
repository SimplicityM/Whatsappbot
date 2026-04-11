const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const prisma = require("../../packages/database/client");
const MongoSession = require("../models/Session");

const router = express.Router();

async function resolveAccountForUser(user) {
  const accountName = String(user?.email || "").trim().toLowerCase();
  if (!accountName) {
    throw new Error("Unable to resolve account for user");
  }

  let account = await prisma.account.findFirst({ where: { name: accountName } });
  if (!account) {
    account = await prisma.account.create({
      data: {
        name: accountName
      }
    });
  }

  return account;
}

router.get("/keys", async (req, res) => {
  try {
    const account = await resolveAccountForUser(req.user);
    const keys = await prisma.apiKey.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        prefix: true,
        createdAt: true,
        revokedAt: true
      }
    });

    return res.json({ success: true, data: { keys } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/keys", async (req, res) => {
  try {
    const account = await resolveAccountForUser(req.user);

    const prefix = crypto.randomBytes(6).toString("hex");
    const secret = crypto.randomBytes(24).toString("hex");
    const rawKey = `wa_live_${prefix}.${secret}`;
    const keyHash = await bcrypt.hash(rawKey, 12);

    const apiKey = await prisma.apiKey.create({
      data: {
        prefix,
        keyHash,
        accountId: account.id
      },
      select: {
        id: true,
        prefix: true,
        createdAt: true
      }
    });

    return res.status(201).json({
      success: true,
      message: "API key created. Save it now; it will not be shown again.",
      data: {
        key: rawKey,
        keyMeta: apiKey
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/keys/:keyId", async (req, res) => {
  try {
    const account = await resolveAccountForUser(req.user);
    const { keyId } = req.params;

    const existing = await prisma.apiKey.findFirst({
      where: {
        id: keyId,
        accountId: account.id
      },
      select: { id: true, revokedAt: true }
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: "API key not found" });
    }

    if (existing.revokedAt) {
      return res.json({ success: true, message: "API key already revoked" });
    }

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() }
    });

    return res.json({ success: true, message: "API key revoked" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/sessions", async (req, res) => {
  try {
    const account = await resolveAccountForUser(req.user);
    const sessions = await prisma.session.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        isActive: true,
        createdAt: true
      }
    });

    return res.json({ success: true, data: { sessions } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/sessions/link", async (req, res) => {
  try {
    const account = await resolveAccountForUser(req.user);
    const runtimeSessionId = String(req.body?.runtimeSessionId || "").trim();

    if (!runtimeSessionId) {
      return res.status(400).json({ success: false, message: "runtimeSessionId is required" });
    }

    const mongoSession = await MongoSession.findOne({ sessionId: runtimeSessionId }).lean();
    if (!mongoSession) {
      return res.status(404).json({
        success: false,
        message: "Runtime WhatsApp session not found in bot records"
      });
    }

    const existing = await prisma.session.findFirst({
      where: {
        accountId: account.id,
        name: runtimeSessionId
      }
    });

    if (existing) {
      if (!existing.isActive) {
        const updated = await prisma.session.update({
          where: { id: existing.id },
          data: { isActive: true },
          select: { id: true, name: true, isActive: true, createdAt: true }
        });
        return res.json({ success: true, data: { session: updated } });
      }
      return res.json({ success: true, data: { session: existing } });
    }

    const session = await prisma.session.create({
      data: {
        name: runtimeSessionId,
        accountId: account.id,
        isActive: true
      },
      select: { id: true, name: true, isActive: true, createdAt: true }
    });

    return res.status(201).json({ success: true, data: { session } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;