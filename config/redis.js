const Redis = require('ioredis')

let redis = null

if (process.env.REDIS_HOST) {
  redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD,
    retryStrategy: times => Math.min(times * 50, 2000),
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  })

  redis.on('connect', () => {
    console.log('Redis connected')
  })

  redis.on('error', (err) => {
    console.error('Redis error:', err)
  })
}

module.exports = redis