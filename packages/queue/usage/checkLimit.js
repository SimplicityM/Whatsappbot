const redis = require("../queue/redis");
const dayjs = require("dayjs");
const prisma = require("../database/client");

async function checkDailyLimit(accountId) {
  const account = await prisma.account.findUnique({
    where: { id: accountId }
  });

  const today = dayjs().format("YYYY-MM-DD");
  const key = `usage:${accountId}:${today}`;

  const used = parseInt((await redis.get(key)) || "0");

  if (used >= account.messageLimit) {
    throw new Error("Daily limit exceeded");
  }
}

module.exports = checkDailyLimit;