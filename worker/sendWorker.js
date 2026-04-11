const { Worker } = require("bullmq");
const prisma = require("../packages/database/client");
const redis = require("../packages/queue/redis");
const incrementUsage = require("../packages/usage/increment");

new Worker(
  "send-message",
  async job => {
    const { messageId } = job.data;

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) return;
    if (message.status === "SENT") return;

    // 🔥 integrate your existing Baileys send logic here
    // await sock.sendMessage(...)

    await prisma.message.update({
      where: { id: messageId },
      data: { status: "SENT" }
    });

    await incrementUsage(message.accountId);
  },
  { connection: redis }
);