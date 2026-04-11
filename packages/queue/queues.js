const { Queue } = require("bullmq");
const redis = require("./redis");

const sendQueue = new Queue("send-message", {
  connection: redis
});

module.exports = { sendQueue };