const express = require("express");
const mongoose = require("mongoose");

const app = express();
app.use(express.json());

const License = mongoose.model("License", new mongoose.Schema({
  sessionId: String,
  plan: String,
  expiresAt: Date
}));

app.post("/verify", async (req, res) => {
  const { sessionId } = req.body;

  const license = await License.findOne({ sessionId });

  if (!license)
    return res.json({ valid: false });

  if (new Date() > license.expiresAt)
    return res.json({ valid: false });

  res.json({ valid: true, plan: license.plan });
});

app.listen(4000);