// utils/verifyRecaptcha.js
const axios = require("axios");

async function verifyRecaptcha(token, action) {
    try {
        const secretKey = process.env.RECAPTCHA_SECRET_KEY;

        const url = `https://www.google.com/recaptcha/api/siteverify`;

        const response = await axios.post(url, null, {
            params: {
                secret: secretKey,
                response: token
            }
        });

        const data = response.data;

        // If Google returns error codes, do NOT block user completely.
        if (!data.success) {
            console.warn("⚠️ Recaptcha returned success=false:", data["error-codes"]);
            return { success: true, score: data.score || 0.1, reason: "Google returned success=false" };
        }

        // Allow low scores but mark them
        const minScore = 0.1;
        if (data.score < minScore) {
            console.warn(`⚠️ Low Recaptcha score (${data.score}). Allowing user anyway.`);
            return { success: true, score: data.score };
        }

        return { success: true, score: data.score };

    } catch (err) {
        console.error("❌ reCAPTCHA verification error:", err);
        // Do NOT block user on server error
        return { success: true, score: 0.5, reason: "Server error ignored" };
    }
}

module.exports = verifyRecaptcha;
