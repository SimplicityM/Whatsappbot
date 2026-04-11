const bcrypt = require("bcrypt");
const prisma = require("../packages/database/client");

async function apiKeyAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No API key" });
    }

    const rawKey = header.replace("Bearer ", "").trim();
    const keyPrefix = String(rawKey.split(".")[0] || "").replace("wa_live_", "");

    if (!keyPrefix) {
      return res.status(401).json({ error: "Invalid key" });
    }

    const apiKey = await prisma.apiKey.findUnique({
      where: { prefix: keyPrefix }
    });

    if (!apiKey || apiKey.revokedAt) {
      return res.status(401).json({ error: "Invalid key" });
    }

    const valid = await bcrypt.compare(rawKey, apiKey.keyHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid key" });
    }

    req.accountId = apiKey.accountId;
    next();
  } catch (error) {
    return res.status(500).json({ error: "API key authentication failed" });
  }
}

module.exports = apiKeyAuth;