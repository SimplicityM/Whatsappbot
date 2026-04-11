const redis = require("../redis");
const dayjs = require("dayjs");

async function incrementUsage(accountId) {
  const today = dayjs().format("YYYY-MM-DD");
  const key = `usage:${accountId}:${today}`;

  await redis.incr(key);
  await redis.expire(key, 60 * 60 * 48);
}

module.exports = incrementUsage;