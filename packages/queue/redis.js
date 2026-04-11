const IORedis = require("ioredis");

const redis = new IORedis(process.env.REDIS_URL);

module.exports = redis;