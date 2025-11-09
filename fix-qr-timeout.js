// fix-qr-timeout.js
const fs = require('fs');
const path = require('path');

console.log('🔧 Fixing QR code timeout settings...');

const botPath = path.join(__dirname, 'bot.js');
let botContent = fs.readFileSync(botPath, 'utf8');

// Find and update client config
const oldConfig = `qrMaxRetries: clientConfig.qrMaxRetries,
    authTimeoutMs: clientConfig.authTimeoutMs,`;

const newConfig = `qrMaxRetries: 10, // Increased from 3
    authTimeoutMs: 300000, // Increased to 5 minutes
    qrTimeoutMs: 60000, // 1 minute per QR code`;

if (botContent.includes('qrMaxRetries: clientConfig.qrMaxRetries')) {
    botContent = botContent.replace(oldConfig, newConfig);
    console.log('✅ Updated QR timeout settings');
} else {
    console.log('⚠️ Could not find exact config pattern');
    
    // Alternative: find clientConfig object
    if (botContent.includes('qrMaxRetries: 3')) {
        botContent = botContent.replace('qrMaxRetries: 3', 'qrMaxRetries: 10');
        console.log('✅ Updated qrMaxRetries');
    }
    
    if (botContent.includes('authTimeoutMs: 120000')) {
        botContent = botContent.replace('authTimeoutMs: 120000', 'authTimeoutMs: 300000');
        console.log('✅ Updated authTimeoutMs');
    }
}

fs.writeFileSync(botPath, botContent);
console.log('✅ QR timeout fix applied');
console.log('🔄 Please restart your server');