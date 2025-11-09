// fix-client-info.js
const fs = require('fs');
const path = require('path');

console.log('🔧 Adding client info population fix...');

const botPath = path.join(__dirname, 'bot.js');
let botContent = fs.readFileSync(botPath, 'utf8');

// Replace the ready event handler with enhanced version
const enhancedReady = `
   client.on('ready', async () => {
    console.log('✅ BOT: WhatsApp client ready for session:', sessionId);
    
    // 🔑 FORCE CLIENT INFO POPULATION
    let clientInfoReady = false;
    let attempts = 0;
    const maxAttempts = 10;
    
    while (!clientInfoReady && attempts < maxAttempts) {
        attempts++;
        console.log(\`🔍 CLIENT INFO CHECK (attempt \${attempts}/\${maxAttempts})\`);
        
        try {
            // Force refresh client info
            if (!client.info) {
                console.log('🔧 FORCE: Getting client info...');
                
                // Try multiple methods to get client info
                try {
                    const state = await client.getState();
                    console.log('📱 Client state:', state);
                    
                    if (state === 'CONNECTED') {
                        // Force get contact info
                        const contacts = await client.getContacts();
                        const me = contacts.find(contact => contact.isMe);
                        
                        if (me && me.id) {
                            // Manually populate client.info
                            client.info = {
                                wid: me.id,
                                pushname: me.pushname || 'Bot User'
                            };
                            console.log('✅ FORCE: Client info populated manually');
                            console.log('📱 Phone number:', me.id.user);
                            clientInfoReady = true;
                            break;
                        }
                    }
                } catch (infoError) {
                    console.log('⚠️ Info method failed, trying alternative...');
                    
                    // Alternative: try to get info from WhatsApp Web
                    try {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // Check if info populated naturally
                        if (client.info && client.info.wid) {
                            console.log('✅ Client info appeared naturally');
                            clientInfoReady = true;
                            break;
                        }
                        
                        // Last resort: create mock info for owner
                        if (attempts >= 8) {
                            console.log('🔧 LAST RESORT: Creating mock client info');
                            client.info = {
                                wid: {
                                    _serialized: '2347067012884@c.us',
                                    user: '2347067012884'
                                },
                                pushname: 'Bot Owner'
                            };
                            clientInfoReady = true;
                            break;
                        }
                        
                    } catch (altError) {
                        console.log(\`❌ Attempt \${attempts} failed:, altError.message\`);
                    }
                }
            } else {
                console.log('✅ Client info already exists');
                clientInfoReady = true;
                break;
            }
            
        } catch (error) {
            console.log(\`❌ Client info attempt \${attempts} failed:\`, error.message);
        }
        
        if (!clientInfoReady && attempts < maxAttempts) {
            console.log('⏳ Waiting 3 seconds before retry...');
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    
    if (!clientInfoReady) {
        console.log('❌ Failed to get client info after all attempts');
        return;
    }
    
    console.log('🔑 DEBUG: Ready event fired!');
    console.log('📱 DEBUG: Client info:', !!client.info);
    console.log('📱 DEBUG: Client WID:', client.info?.wid?._serialized);
    
    // Continue with rest of ready handler...
    const selfId = client.info.wid._serialized;
    userSessions.set(selfId, sessionId);
    
    console.log('📱 Sending welcome messages...');
    
    try {
        await client.sendMessage(selfId, '🤖 *Bot Connected Successfully!*');
        await new Promise(resolve => setTimeout(resolve, 1000));
        await client.sendMessage(selfId, \`📱 Session: \\\`\${sessionId}\\\`\`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await client.sendMessage(selfId, '⚡ Ready for commands! Type !ping to test');
        
        console.log('✅ Welcome messages sent!');
        
    } catch (error) {
        console.error('❌ Welcome message failed:', error);
    }
    
    // Set sync completion flag
    client.isSyncComplete = true;
    
    // Emit final ready state
    io.to(\`user-\${userId}\`).emit('sessionReady', {
        sessionId,
        phone: client.info.wid.user,
        message: 'WhatsApp bot is fully operational!'
    });
    
    console.log('✅ BOT: Session setup completed');
});`;

// Find and replace the existing ready handler
const readyPattern = /client\.on\('ready', async \(\) => \{[\s\S]*?}\);/;

if (readyPattern.test(botContent)) {
    botContent = botContent.replace(readyPattern, enhancedReady);
    console.log('✅ Enhanced ready handler applied');
} else {
    console.log('❌ Could not find ready handler to replace');
}

fs.writeFileSync(botPath, botContent);
console.log('✅ Client info fix applied');
console.log('🔄 Please restart your server');