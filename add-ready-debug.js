// add-ready-debug.js
const fs = require('fs');
const path = require('path');

console.log('🔧 Adding ready event debug logs...');

const botPath = path.join(__dirname, 'bot.js');
let botContent = fs.readFileSync(botPath, 'utf8');

// Add debug right after authenticated event
const authEventDebug = `
        client.on('authenticated', (session) => {
            console.log('🔑 DEBUG: Authentication event fired!');
            console.log('📱 DEBUG: Session data received');
            console.log('⏳ DEBUG: Waiting for ready event...');
        });

        client.on('loading_screen', (percent, message) => {
            console.log('📱 DEBUG: Loading screen:', percent + '%', message);
        });

        client.on('change_state', (state) => {
            console.log('📱 DEBUG: State changed to:', state);
        });
`;

// Find and replace the existing authenticated debug
const existingAuth = `        // 🔍 DEBUG: Authentication event
        client.on('authenticated', (session) => {
            console.log('🔑 DEBUG: Authentication event fired!');
            console.log('📱 DEBUG: Session data received');
        });`;

if (botContent.includes(existingAuth)) {
    botContent = botContent.replace(existingAuth, authEventDebug);
    console.log('✅ Enhanced authentication debug logs');
} else {
    console.log('⚠️ Could not find existing auth debug, adding new one');
    
    // Add before QR event
    const qrEvent = "client.on('qr', async (qr) => {";
    if (botContent.includes(qrEvent)) {
        botContent = botContent.replace(qrEvent, authEventDebug + '\n        ' + qrEvent);
        console.log('✅ Added new authentication debug logs');
    }
}

fs.writeFileSync(botPath, botContent);
console.log('✅ Ready debug logs added');
console.log('🔄 Please restart your server and test again');