const { Queue } = require("bullmq");
const Redis = require("ioredis");

const connection = new Redis(process.env.REDIS_URL);

const messageQueue = new Queue("messageQueue", { connection });

module.exports = messageQueue;