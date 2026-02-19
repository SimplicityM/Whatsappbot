require("dotenv").config();
const { Worker } = require("bullmq");
const Redis = require("ioredis");

const redisEnabled = process.env.REDIS_ENABLED !== "false";
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

if (!redisEnabled) {
    throw new Error("Queue worker requires Redis. Set REDIS_ENABLED=true before starting it.");
}

const connection = new Redis(redisUrl);

const worker = new Worker(
  "messageQueue",
  async job => {
    const { sock, jid, payload } = job.data;
    await sock.sendMessage(jid, payload);
  },
  { connection }
);

module.exports = worker;
