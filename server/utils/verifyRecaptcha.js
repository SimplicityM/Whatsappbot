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

        // EXPECTED TRUE VALIDATION
        if (!data.success) {
            return { success: false, score: 0, reason: "Recaptcha failed" };
        }

        // SCORE CHECK (Google recommends >= 0.5)
        if (data.score < 0.1) {
            return { success: false, score: data.score, reason: "Low Recaptcha score" };
        }

        return { success: true, score: data.score };
    } catch (err) {
        console.error("reCAPTCHA verification error:", err);
        return { success: false, reason: "Server recaptcha error" };
    }
}

module.exports = verifyRecaptcha;
