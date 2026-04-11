/*
  End-to-end developer API flow verifier.
  Requires a running server and valid user token.
*/

require("dotenv").config();

const axios = require("axios");

const baseUrl = process.env.DEV_API_BASE_URL || "http://localhost:3000";
const jwtToken = process.env.DEV_JWT_TOKEN;
const runtimeSessionId = process.env.DEV_RUNTIME_SESSION_ID;
const to = process.env.DEV_TEST_TO;
const content = process.env.DEV_TEST_MESSAGE || "Developer API flow test message";

function logStep(step, payload) {
  console.log(`\n[${step}]`);
  if (payload !== undefined) {
    console.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
  }
}

async function main() {
  if (!jwtToken) {
    throw new Error("Missing DEV_JWT_TOKEN");
  }
  if (!runtimeSessionId) {
    throw new Error("Missing DEV_RUNTIME_SESSION_ID");
  }
  if (!to) {
    throw new Error("Missing DEV_TEST_TO");
  }

  const jwtClient = axios.create({
    baseURL: baseUrl,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      "Content-Type": "application/json"
    }
  });

  logStep("1", "Linking runtime WhatsApp session to developer account");
  const linkResp = await jwtClient.post("/api/developer/sessions/link", {
    runtimeSessionId
  });
  const linkedSession = linkResp.data?.data?.session;
  if (!linkedSession?.id) {
    throw new Error("Failed to link session");
  }
  logStep("1 result", linkedSession);

  logStep("2", "Creating developer API key");
  const keyResp = await jwtClient.post("/api/developer/keys");
  const apiKey = keyResp.data?.data?.key;
  if (!apiKey) {
    throw new Error("Failed to create API key");
  }
  logStep("2 result", {
    keyPrefix: keyResp.data?.data?.keyMeta?.prefix,
    keyId: keyResp.data?.data?.keyMeta?.id
  });

  logStep("3", "Sending message via /v1/messages with API key");
  const apiClient = axios.create({
    baseURL: baseUrl,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const sendResp = await apiClient.post("/v1/messages", {
    sessionId: linkedSession.id,
    to,
    content
  });

  logStep("3 result", sendResp.data);

  console.log("\nSUCCESS: Developer API flow completed.");
}

main().catch(err => {
  const message = err?.response?.data || err?.message || err;
  console.error("\nFAILED:", message);
  process.exit(1);
});
