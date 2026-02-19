require("dotenv").config();
const { Queue } = require("bullmq");
const Redis = require("ioredis");

const redisEnabled = process.env.REDIS_ENABLED !== "false";
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

if (!redisEnabled) {
    throw new Error("Queue requires Redis. Set REDIS_ENABLED=true or avoid loading queue module.");
}

const connection = new Redis(redisUrl);

const messageQueue = new Queue("messageQueue", { connection });

module.exports = messageQueue;
