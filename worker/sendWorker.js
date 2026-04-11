const { Worker } = require("bullmq");
const crypto = require("crypto");
const prisma = require("../packages/database/client");
const redis = require("../packages/queue/redis");
const incrementUsage = require("../packages/queue/usage/increment");
const { sessions } = require("./baileys");

const SEND_WORKER_MAX_PER_MINUTE = parseInt(process.env.SEND_WORKER_MAX_PER_MINUTE || "20", 10);
const SEND_WORKER_MIN_DELAY_MS = parseInt(process.env.SEND_WORKER_MIN_DELAY_MS || "1200", 10);
const SEND_WORKER_BLOCK_DUPLICATES = process.env.SEND_WORKER_BLOCK_DUPLICATES === "true";
const SEND_WORKER_DUPLICATE_WINDOW_MS = parseInt(process.env.SEND_WORKER_DUPLICATE_WINDOW_MS || "30000", 10);
const SEND_WORKER_FAIL_COOLDOWN_ENABLED = process.env.SEND_WORKER_FAIL_COOLDOWN_ENABLED === "true";
const SEND_WORKER_FAIL_THRESHOLD = parseInt(process.env.SEND_WORKER_FAIL_THRESHOLD || "5", 10);
const SEND_WORKER_COOLDOWN_MS = parseInt(process.env.SEND_WORKER_COOLDOWN_MS || "120000", 10);

const recentMessageHashes = new Map();
const failureState = new Map();

function cleanupRecentHashes(now) {
  for (const [k, ts] of recentMessageHashes.entries()) {
    if (now - ts > SEND_WORKER_DUPLICATE_WINDOW_MS) {
      recentMessageHashes.delete(k);
    }
  }
}

function hashPayload(to, content) {
  return crypto
    .createHash("sha256")
    .update(`${to}|${String(content || "")}`)
    .digest("hex");
}

const sendWorker = new Worker(
  "send-message",
  async job => {
    const { messageId } = job.data;

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) return;
    if (message.status === "SENT") return;

    const session = await prisma.session.findUnique({
      where: { id: message.sessionId }
    });

    const runtimeSessionId = session?.name || message.sessionId;
    const sock = sessions.get(runtimeSessionId);

    if (SEND_WORKER_FAIL_COOLDOWN_ENABLED) {
      const f = failureState.get(runtimeSessionId);
      if (f?.cooldownUntil && Date.now() < f.cooldownUntil) {
        await prisma.message.update({
          where: { id: message.id },
          data: { status: "FAILED" }
        });
        throw new Error(`Session ${runtimeSessionId} is in temporary cooldown`);
      }
    }

    if (!sock) {
      await prisma.message.update({
        where: { id: message.id },
        data: { status: "FAILED" }
      });
      throw new Error(`No active WhatsApp session for ${runtimeSessionId}`);
    }

    try {
      if (SEND_WORKER_BLOCK_DUPLICATES) {
        const now = Date.now();
        cleanupRecentHashes(now);
        const dedupeKey = `${runtimeSessionId}:${hashPayload(message.to, message.content)}`;
        if (recentMessageHashes.has(dedupeKey)) {
          await prisma.message.update({
            where: { id: messageId },
            data: { status: "FAILED" }
          });
          throw new Error("Duplicate message blocked by worker safeguard");
        }
        recentMessageHashes.set(dedupeKey, now);
      }

      await sock.sendMessage(message.to, {
        text: message.content || ""
      });

      await prisma.message.update({
        where: { id: messageId },
        data: { status: "SENT" }
      });

      await incrementUsage(message.accountId);

      if (SEND_WORKER_FAIL_COOLDOWN_ENABLED) {
        failureState.set(runtimeSessionId, { count: 0, cooldownUntil: 0 });
      }

      // Small pacing delay to mimic human send cadence and reduce anti-spam risk.
      if (SEND_WORKER_MIN_DELAY_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, SEND_WORKER_MIN_DELAY_MS));
      }
    } catch (err) {
      if (SEND_WORKER_FAIL_COOLDOWN_ENABLED) {
        const current = failureState.get(runtimeSessionId) || { count: 0, cooldownUntil: 0 };
        const nextCount = current.count + 1;
        const cooldownUntil = nextCount >= SEND_WORKER_FAIL_THRESHOLD
          ? Date.now() + SEND_WORKER_COOLDOWN_MS
          : 0;
        failureState.set(runtimeSessionId, { count: nextCount, cooldownUntil });
      }

      await prisma.message.update({
        where: { id: messageId },
        data: { status: "FAILED" }
      });
      throw err;
    }
  },
    {
      connection: redis,
      limiter: {
        max: SEND_WORKER_MAX_PER_MINUTE,
        duration: 60000
      }
    }
);

function isSendWorkerRunning() {
  return !sendWorker.closing;
}

module.exports = {
  sendWorker,
  isSendWorkerRunning
};