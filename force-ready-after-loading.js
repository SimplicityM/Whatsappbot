// force-ready-after-loading.js
const fs = require('fs');
const path = require('path');

console.log('🔧 Adding forced ready trigger after loading...');

const botPath = path.join(__dirname, 'bot.js');
let botContent = fs.readFileSync(botPath, 'utf8');

// Add loading screen handler that triggers ready
const loadingHandler = `
        let loadingComplete = false;
        let authComplete = false;
        
        client.on('loading_screen', (percent, message) => {
            console.log('📱 DEBUG: Loading screen:', percent + '%', message);
            
            // If we reach 95% or higher, consider loading complete
            if (percent >= 95 && !loadingComplete) {
                loadingComplete = true;
                console.log('✅ DEBUG: Loading appears complete at', percent + '%');
                
                // Wait a bit then force ready if not already fired
                setTimeout(() => {
                    if (authComplete && !client.readyFired) {
                        console.log('🔧 FORCE: Triggering ready event manually');
                        client.readyFired = true;
                        client.emit('ready');
                    }
                }, 3000);
            }
        });

        client.on('authenticated', (session) => {
            console.log('🔑 DEBUG: Authentication event fired!');
            console.log('📱 DEBUG: Session data received');
            console.log('⏳ DEBUG: Waiting for ready event...');
            authComplete = true;
            
            // Also set a backup timer
            setTimeout(() => {
                if (!client.readyFired && loadingComplete) {
                    console.log('🔧 BACKUP: Forcing ready after 10 seconds');
                    client.readyFired = true;
                    client.emit('ready');
                }
            }, 10000);
        });
`;

// Find and replace existing loading_screen handler
const existingPattern = /client\.on\('loading_screen'[^}]+}\);[\s\S]*?client\.on\('authenticated'[^}]+}\);/;

if (existingPattern.test(botContent)) {
    botContent = botContent.replace(existingPattern, loadingHandler);
    console.log('✅ Replaced existing loading handlers');
} else {
    // Find where to insert
    const insertPoint = "client.on('qr', async (qr) => {";
    if (botContent.includes(insertPoint)) {
        botContent = botContent.replace(insertPoint, loadingHandler + '\n        ' + insertPoint);
        console.log('✅ Added new loading handlers');
    }
}

fs.writeFileSync(botPath, botContent);
console.log('✅ Force ready fix applied');
console.log('🔄 Please restart your server');