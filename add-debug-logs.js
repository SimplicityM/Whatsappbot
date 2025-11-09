// add-debug-logs.js
const fs = require('fs');
const path = require('path');

console.log('🔧 Adding debug logs to bot.js...');

const botPath = path.join(__dirname, 'bot.js');
let botContent = fs.readFileSync(botPath, 'utf8');

// Add debug logs to authentication events
const authDebug = `
        // 🔍 DEBUG: Authentication event
        client.on('authenticated', (session) => {
            console.log('🔑 DEBUG: Authentication event fired!');
            console.log('📱 DEBUG: Session data received');
        });

        client.on('auth_failure', (message) => {
            console.log('❌ DEBUG: Authentication failed:', message);
        });

        client.on('disconnected', (reason) => {
            console.log('❌ DEBUG: Client disconnected:', reason);
        });
`;

// Find where to insert debug logs
const insertPoint = "client.on('qr', async (qr) => {";

if (botContent.includes(insertPoint)) {
    botContent = botContent.replace(insertPoint, authDebug + '\n        ' + insertPoint);
    console.log('✅ Added authentication debug logs');
} else {
    console.log('❌ Could not find QR event handler');
}

// Add debug to ready event
const readyDebug = `
    console.log('🔑 DEBUG: Ready event fired!');
    console.log('📱 DEBUG: Client info:', !!client.info);
    console.log('📱 DEBUG: Client WID:', client.info?.wid?._serialized);
`;

const readyInsert = "console.log('✅ BOT: WhatsApp client ready for session:', sessionId);";

if (botContent.includes(readyInsert)) {
    botContent = botContent.replace(readyInsert, readyInsert + '\n        ' + readyDebug);
    console.log('✅ Added ready event debug logs');
}

fs.writeFileSync(botPath, botContent);
console.log('✅ Debug logs added successfully');
console.log('🔄 Please restart your server');