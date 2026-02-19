const express = require("express");
const router = express.Router();

router.get("/stats", async (req, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    sessions: global.sessions?.size || 0
  });
});

module.exports = router;