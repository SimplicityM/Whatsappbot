const { Worker } = require("bullmq");
const Redis = require("ioredis");

const connection = new Redis(process.env.REDIS_URL);

const worker = new Worker(
  "messageQueue",
  async job => {
    const { sock, jid, payload } = job.data;
    await sock.sendMessage(jid, payload);
  },
  { connection }
);

module.exports = worker;