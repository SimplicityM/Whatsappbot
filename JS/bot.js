const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// This increases the default limit for all EventEmitters
require('events').EventEmitter.defaultMaxListeners = 1000;

const COMMAND_PREFIX = '!';
const SESSION_DIR = './sessions';


if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync('./media')) fs.mkdirSync('./media', { recursive: true });

const mediaPath = {
    audio: './media/audio.mp3',
    document: './media/document.pdf',
    image: './media/image.jpg'
};

const clients = new Map();
const userSessions = new Map();

const scheduledReminders = new Map();
let reminderCounter = 1;

const clientConfig = {
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-gpu', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <- this one helps with memory usage
            '--disable-web-security'
        ],
        defaultViewport: null
    },
    qrMaxRetries: 5, // Reduced from 10 to prevent excessive attempts
    authTimeoutMs: 180000, // Increased to 3 minutes
    restartOnAuthFail: true, // Add this to automatically restart on auth failures
    takeoverOnConflict: true, // Add this to handle session conflicts
    takeoverTimeoutMs: 10000 // Timeout for takeover attempts
};


const authorizedNumbers = new Set(['your-admin-number@c.us']); // Replace with your actual admin number
const COOLDOWN_TIME = 60000; // 1 minute cooldown
const CALL_COOLDOWN = new Map();

const isAuthorized = (userId) => {
    return authorizedNumbers.has(userId);
};

const logger = {
    info: (message) => console.log(`[${new Date().toISOString()}] INFO: ${message}`),
    error: (message, error) => console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error)
};

// Setup call handlers function - moved to be defined before it's used
const setupCallHandlers = (client) => {
    // Handle incoming WhatsApp calls
    client.on('call', async (call) => {
        try {
            const caller = call.from;
            const isVideoCall = call.isVideo;
            
            logger.info(`Received ${isVideoCall ? 'video' : 'voice'} call from ${caller}`);
            
            // Check if contact exists in phonebook
            const contact = await client.getContactById(caller);
            
            if (!contact.name || contact.name === contact.pushname || contact.name === caller.split('@')[0]) {
                // Contact not properly saved in phonebook
                const saved = await saveNewContact(client, caller, contact.pushname || null);
                
                if (saved) {
                    // Notify admin about the new saved contact
                    for (const adminNumber of authorizedNumbers) {
                        try {
                            const adminChat = await client.getChatById(adminNumber);
                            await adminChat.sendMessage(`📞 Automatically saved new contact:\n*Number:* ${caller}\n*Name:* ${contact.pushname || 'Unknown'}`);
                        } catch (err) {
                            logger.error('Failed to notify admin about new contact:', err);
                        }
                    }
                }
            }
            
            // Optionally, you can reject or accept the call
            // await call.reject(); // Uncomment to automatically reject calls
            
        } catch (error) {
            logger.error('Error handling call event:', error);
        }
    });
};

// Define the SAVED_CONTACTS_FILE and savedContacts before they're used
const SAVED_CONTACTS_FILE = './saved_contacts.json';

let savedContacts = new Set();
try {
    if (fs.existsSync(SAVED_CONTACTS_FILE)) {
        savedContacts = new Set(JSON.parse(fs.readFileSync(SAVED_CONTACTS_FILE)));
        logger.info(`Loaded ${savedContacts.size} saved contacts`);
    }
} catch (error) {
    logger.error('Failed to load saved contacts:', error);
}

// Define saveNewContact before it's used
const saveNewContact = async (client, phoneNumber, name = null) => {
    try {
        if (savedContacts.has(phoneNumber)) {
            logger.info(`Contact ${phoneNumber} already saved`);
            return false;
        }
        
        // Format the name (use phone number if name not provided)
        const contactName = name || `New Contact ${phoneNumber}`;
        
        // Save contact using WhatsApp Web API
        await client.pupPage.evaluate((contact, name) => {
            return window.WWebJS.contactAdd(contact, name);
        }, phoneNumber, contactName);
        
        // Add to our saved contacts set and save to file
        savedContacts.add(phoneNumber);
        fs.writeFileSync(SAVED_CONTACTS_FILE, JSON.stringify([...savedContacts]));
        
        logger.info(`New contact saved: ${phoneNumber} as "${contactName}"`);
        return true;
    } catch (error) {
        logger.error(`Failed to save contact ${phoneNumber}:`, error);
        return false;
    }
};

const createNewSession = () => {
    try {
        const sessionId = Date.now().toString();
        logger.info(`Creating new session: ${sessionId}`);

        const client = createClient(sessionId);
        clients.set(sessionId, client);

        client.initialize().catch(err => {
            logger.error(`Failed to initialize client ${sessionId}:`, err);
            clients.delete(sessionId);
        });

        return sessionId;
    } catch (error) {
        logger.error('Failed to create new session:', error);
    }
};

const createClient = (sessionId) => {
    const sessionFile = path.join(SESSION_DIR, `session-${sessionId}.json`);
    let sessionData = null;

    try {
        if (fs.existsSync(sessionFile)) {
            sessionData = JSON.parse(fs.readFileSync(sessionFile));
        }
    } catch (error) {
        logger.error(`Failed to load session ${sessionId}:`, error);
    }

    const client = new Client({ session: sessionData, ...clientConfig });
    setupClientEvents(client, sessionId);
    setupCallHandlers(client);
    return client;
};

let keepAliveInterval;

const setupClientEvents = (client, sessionId) => {
    let qrRetryCount = 0;
    
    client.on('qr', (qr) => {
        logger.info(`QR Code received for session ${sessionId}`);
        qrcode.generate(qr, { small: true });
        
        // QR code will only be displayed in the console, not saved to a file
    });
    


    //client.on('qr', (qr) => {
      //  logger.info(`QR Code received for session ${sessionId}`);
        //qrcode.generate(qr, { small: true });
    
        //try {
          //  fs.writeFileSync(`./qr_code_${sessionId}.txt`, qr);
           // logger.info(`QR code saved to qr_code_${sessionId}.txt`);
        //} catch (error) {
          //  logger.error('Failed to save QR code to file:', error);
       // }
    //});
    

    //client.on('qr', (qr) => {
        //qrRetryCount++;
        //logger.info(`QR Code received for session ${sessionId} (Attempt ${qrRetryCount}/${clientConfig.qrMaxRetries})`);
        //qrcode.generate(qr, { small: true });

        //try {
            //fs.writeFileSync(`./qr_code_${sessionId}.txt`, qr);
            //logger.info(`QR code saved to qr_code_${sessionId}.txt`);
            
            // Also save as image if qrcode-terminal doesn't work well
            //try {
                //require('qrcode').toFile(`./qr_code_${sessionId}.png`, qr, {
                    //color: {
                      //  dark: '#000000',
                    //    light: '#ffffff'
                  //  }
                //}, (err) => {
                    //if (err) {
                     //   logger.error('Failed to save QR code as image:', err);
                   // } else {
                  //      logger.info(`QR code image saved to qr_code_${sessionId}.png`);
                //    }
              //  });
            //} catch (qrError) {
            //    logger.error('QR code image generation failed, you may need to install qrcode package:', qrError);
          //  }
        //} catch (error) {
        //    logger.error('Failed to save QR code to file:', error);
      //  }
    //});

    // Add a new event handler for when QR code generation fails
    client.on('qr_timeout', () => {
        logger.error(`QR Code generation timed out for session ${sessionId} after ${clientConfig.qrMaxRetries} attempts`);
        
        // Automatically create a new session when QR times out
        logger.info(`Creating new session after QR timeout of ${sessionId}`);
        setTimeout(() => {
            createNewSession();
        }, 1000);
        
        // Clean up the failed session
        clients.delete(sessionId);
    });

    client.on('authenticated', () => {
        logger.info(`Session ${sessionId} authenticated`);
    
        try {
            const sessionFile = path.join(SESSION_DIR, `session-${sessionId}.json`);
            const sessionData = client.base64EncodedAuthInfo();
            fs.writeFileSync(sessionFile, JSON.stringify(sessionData));
            logger.info(`Session ${sessionId} data saved successfully`);
        } catch (error) {
            logger.error(`Failed to save session data for ${sessionId}:`, error);
        }
        
        // Remove the automatic creation of new sessions after authentication
    });
    
    

    client.on('ready', async () => {
        logger.info(`Client ${sessionId} is ready`);
    
        const selfId = client.info.wid._serialized;
        const uniqueId = crypto.randomBytes(4).toString('hex').toUpperCase();
        userSessions.set(selfId, uniqueId);
    
        // Add the retry mechanism for sending session ID
        const sendSessionIdMessage = async (retries = 3, delay = 5000) => {
            try {
                await new Promise(resolve => setTimeout(resolve, delay));
                const message = `🤖 *Bot Connected*\n\nYour session ID: \`${uniqueId}\`\n\nSend the Above Session ID via Chat to Constumer Care and wait for Confirmation.`;
                const chat = await client.getChatById(selfId);
                await chat.sendMessage(message);
                logger.info(`Session ID ${uniqueId} sent to ${selfId}`);
            } catch (error) {
                logger.error(`Failed to send session ID (attempt ${4-retries}/3):`, error);
                if (retries > 0) {
                    logger.info(`Retrying to send session ID in ${delay/1000} seconds...`);
                    return sendSessionIdMessage(retries - 1, delay * 1.5);
                } else {
                    logger.error('Maximum retries reached. Could not send session ID.');
                }
            }
        };
    
        // Start the retry process
        sendSessionIdMessage();
        
        // Set up keep-alive mechanism
        keepAliveInterval = setInterval(async () => {
            try {
                // Perform a simple operation to keep the connection alive
                await client.getState();
                logger.info(`Keep-alive ping for session ${sessionId}`);
            } catch (error) {
                logger.error(`Keep-alive failed for session ${sessionId}:`, error);
            }
        }, 300000); // 5 minutes
    });
    
    // Replace the disconnected event handler:
    client.on('disconnected', (reason) => {
        logger.info(`Client ${sessionId} disconnected: ${reason}`);
        
        // Clear the keep-alive interval
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
        }
        
        clients.delete(sessionId);
        
        // If disconnected for a reason other than logout, try to recreate the session
        if (reason !== 'NAVIGATION' && reason !== 'LOGOUT') {
            logger.info(`Attempting to recreate session ${sessionId} after disconnection`);
            setTimeout(() => {
                createNewSession();
            }, 10000); // Wait 10 seconds before creating a new session
        }
    });
    
    
    
    client.on('message', async (message) => {
        const isSelfChat = message.fromMe && message.to === client.info.wid._serialized;
        if (!isSelfChat || !message.body.startsWith(COMMAND_PREFIX)) return;

        try { await message.react('🚗'); } catch (error) { logger.error('Failed to react to message:', error); }

        const [command, ...args] = message.body.slice(COMMAND_PREFIX.length).toLowerCase().split(' ');

        try {
            switch (command) {
                case 'ping':
                    await message.reply('Pong! 🏓');
                    break;
                    
                    case 'help':
    await message.reply(`*Available Commands:*
!ping - Check bot response
!info - Get chat info
!sessionid - Get your session ID
!media - Send test media
!status - Get bot status
!newsession - Create new session
!shutdown - Turn off bot (admin only)
!sudo - Admin commands
!document - Send document
!savecontact - Save a new contact (admin only)
!contacts - List all saved contacts (admin only)
!tagall - Mention all group members (admin only)
!tagallexcept - Mention all except specified members (admin only)
!meeting - Schedule a meeting with reminders
!event - Schedule an event with reminders
!reminders - List all active reminders
!cancelreminder - Cancel a scheduled reminder`);
    break;


                  case 'document':
                    await sendDocument(message);
                    break;
          
                case 'shutdown':
                    if (isAuthorized(message.from)) {
                        await handleShutdown(message);
                    } else {
                        await message.reply('You are not authorized to use this command');
                    }
                    break;

                case 'info': {
                    const chat = await message.getChat();
                    await message.reply(`*Chat Info:*\nName: ${chat.name}\nIs Group: ${chat.isGroup}\nParticipants: ${chat.participants?.length || 1}`);
                    break;
                }
                case 'sessionid': {
                    const userId = message.to;
                    const uniqueId = userSessions.get(userId) || 'Not available';
                    await message.reply(`Your current session ID: \`${uniqueId}\``);
                    break;
                }
                case 'media': {
                    const mediaType = args[0] || 'image';
                    if (mediaPath[mediaType]) {
                        if (fs.existsSync(mediaPath[mediaType])) {
                            const media = MessageMedia.fromFilePath(mediaPath[mediaType]);
                            await message.reply(media);
                        } else {
                            await message.reply(`Media file not found: ${mediaPath[mediaType]}`);
                        }
                    } else {
                        await message.reply('Invalid media type. Use: image, audio, or document');
                    }
                    break;
                }
                case 'status': {
                    const uptime = process.uptime();
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    await message.reply(`*Bot Status:*\nUptime: ${hours}h ${minutes}m ${seconds}s\nActive Sessions: ${clients.size}\nMemory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
                    break;
                }
                
// Add these at the top of the file with other global variables
const scheduledReminders = new Map();
let reminderCounter = 1;

// Add these cases to the switch statement in the message event handler
case 'meeting':
    await handleMeetingCommand(message, args, client);
    break;

case 'event':
    await handleEventCommand(message, args, client);
    break;

case 'reminders':
    await listReminders(message, client);
    break;

case 'cancelreminder':
    await cancelReminder(message, args);
    break;

                case 'tagall':
                    await handleGroupCommand(message, async (chat) => {
                        if (!isAuthorized(message.from)) {
                            await message.reply('🚫 You are not authorized to use this command');
                            return;
                        }
                        
                        // Get custom message or use default
                        const mentionText = args.join(' ') || 'mention';
                        const mentions = [];
                        
                        // Collect all participants for mention
                        for (const participant of chat.participants) {
                            const contact = await client.getContactById(participant.id._serialized);
                            mentions.push(contact);
                        }
                        
                        // Send the message with mentions but without showing names
                        await client.sendMessage(chat.id._serialized, mentionText, {
                            mentions: mentions
                        });
                        
                        await message.reply(`✅ Tagged all ${mentions.length} participants. They have been mentioned by you.`);
                    });
                    break;
                
                case 'tagallexcept':
                    await handleGroupCommand(message, async (chat) => {
                        if (!isAuthorized(message.from)) {
                            await message.reply('🚫 You are not authorized to use this command');
                            return;
                        }
                        
                        // Check if there are any mentions to exclude
                        const excludeIds = message.mentions.map(contact => contact.id._serialized);
                        
                        // Get custom message or use default
                        const mentionText = args.join(' ') || 'mention';
                        const mentions = [];
                        
                        // Collect participants for mention, excluding specified ones
                        for (const participant of chat.participants) {
                            const participantId = participant.id._serialized;
                            if (!excludeIds.includes(participantId)) {
                                const contact = await client.getContactById(participantId);
                                mentions.push(contact);
                            }
                        }
                        
                        // Send the message with mentions but without showing names
                        await client.sendMessage(chat.id._serialized, mentionText, {
                            mentions: mentions
                        });
                        
                        await message.reply(`✅ Tagged ${mentions.length} participants (excluded ${excludeIds.length}). They have been mentioned by you.`);
                    });
                    break;
                

                case 'sudo':
                    await handleSudoCommand(message, args);
                    break;

                case 'call':
                    await handleGroupCommand(message, async (chat) => {
                        const cooldownKey = `${chat.id}_call`;
                        const now = Date.now();
                        const lastCall = CALL_COOLDOWN.get(cooldownKey);

                        if (lastCall && (now - lastCall) < COOLDOWN_TIME) {
                            const remainingTime = Math.ceil((COOLDOWN_TIME - (now - lastCall)) / 1000);
                            await message.reply(`⏳ Please wait ${remainingTime} seconds`);
                            return;
                        }

                        CALL_COOLDOWN.set(cooldownKey, now);
                        await message.reply('📞 Call initiated');
                    });
                    break;

                case 'setsudo':
                    if (isAuthorized(message.from)) {
                        try {
                            if (!message.mentions || message.mentions.length === 0) {
                                await message.reply('Tag a user to set as sudo\nUsage: !setsudo @user');
                                break;
                            }
                            
                            const newSudoUser = message.mentions[0];
                            authorizedNumbers.add(newSudoUser);
                            
                            await message.reply(`✅ Successfully added ${newSudoUser} as sudo user!
                            
Privileges granted:
- Bot management
- Admin commands
- System controls`);
                            
                            logger.info(`New sudo user added: ${newSudoUser}`);
                        } catch (error) {
                            logger.error('setSudo error:', error);
                            await message.reply('Failed to set sudo user');
                        }
                    } else {
                        await message.reply('🚫 Only existing sudo users can add new sudo users');
                    break;
                    }

                    case 'delsudo':
                        if (isAuthorized(message.from)) {
                            try {
                                if (!message.mentions || message.mentions.length === 0) {
                                    await message.reply('Tag a user to remove sudo\nUsage: !delsudo @user');
                                    break;
                                }
                                
                                const targetUser = message.mentions[0];
                                if (authorizedNumbers.has(targetUser)) {
                                    authorizedNumbers.delete(targetUser);
                                    await message.reply(`✅ Successfully removed ${targetUser} from sudo users!
                                    
    Changes applied:
    - Sudo access revoked
    - Admin privileges removed
    - System access restricted`);
                                    
                                    logger.info(`Sudo user removed: ${targetUser}`);
                                } else {
                                    await message.reply('This user is not a sudo user');
                                }
                            } catch (error) {
                                logger.error('deleteSudo error:', error);
                                await message.reply('Failed to remove sudo user');
                            }
                        } else {
                            await message.reply('🚫 Only sudo users can remove other sudo users');
                        }
                        break;
    
                    case 'newsession': {
                        await message.reply('Creating a new session...');
                        createNewSession();
                        break;
                    }
                    case 'savecontact': {
                        if (!isAuthorized(message.from)) {
                            await message.reply('🚫 You are not authorized to use this command');
                            break;
                        }
                        
                        const phoneNumber = args[0];
                        if (!phoneNumber) {
                            await message.reply('Please provide a phone number\nUsage: !savecontact phoneNumber [name]');
                            break;
                        }
                        
                        // Format the phone number to ensure it has the correct format
                        let formattedNumber = phoneNumber;
                        if (!formattedNumber.includes('@')) {
                            formattedNumber = `${formattedNumber.replace(/[^0-9]/g, '')}@c.us`;
                        }
                        
                        const contactName = args.slice(1).join(' ') || null;
                        const saved = await saveNewContact(client, formattedNumber, contactName);
                        
                        if (saved) {
                            await message.reply(`✅ Successfully saved contact: ${formattedNumber}`);
                        } else {
                            await message.reply(`Contact already exists or couldn't be saved: ${formattedNumber}`);
                        }
                        break;
                    }
                    case 'contacts': {
                        if (!isAuthorized(message.from)) {
                            await message.reply('🚫 You are not authorized to use this command');
                            break;
                        }
                        
                        const contactsList = Array.from(savedContacts).map((contact, index) => 
                            `${index + 1}. ${contact}`
                        ).join('\n');
                        
                        await message.reply(`*Saved Contacts (${savedContacts.size}):*\n${contactsList || 'No contacts saved yet'}`);
                        break;
                    }
                    default:
                        await message.reply('Unknown command. Type !help for available commands.');
                }
            } catch (error) {            
                logger.error(`Command error (${command}):`, error);
                await message.reply('An error occurred while processing your command');
            }
        });
    
        client.on('disconnected', (reason) => {
            logger.info(`Client ${sessionId} disconnected: ${reason}`);
            clients.delete(sessionId);
        });
    
        client.on('auth_failure', (error) => {
            logger.error(`Authentication failed for session ${sessionId}:`, error);
            const sessionFile = path.join(SESSION_DIR, `session-${sessionId}.json`);
            if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
            clients.delete(sessionId);
        });
    };
    
    let isShuttingDown = false;
    
    process.on('uncaughtException', (err) => logger.error('Uncaught Exception:', err));
    process.on('unhandledRejection', (reason, promise) => logger.error('Unhandled Rejection at:', promise, 'reason:', reason));
    
    process.once('SIGTERM', () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        logger.info('SIGTERM received, shutting down...');
        for (const client of clients.values()) {
            try {
                client.destroy();
            } catch (error) {
                logger.error('Error during client shutdown:', error);
            }
        }
        process.exit(0);
    });
    
    process.once('SIGINT', () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        logger.info('SIGINT received, shutting down...');
        for (const client of clients.values()) {
            try {
                client.destroy();
            } catch (error) {
                logger.error('Error during client shutdown:', error);
            }
        }
        process.exit(0);
    });
    
    process.once('exit', () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        logger.info('Exit event received, shutting down...');
        for (const client of clients.values()) {
            try {
                client.destroy();
            } catch (error) {
                logger.error('Error during client shutdown:', error);
            }
        }
    });
    
    process.once('SIGHUP', () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        logger.info('SIGHUP received, shutting down...');
        for (const client of clients.values()) {
            try {
                client.destroy();
            } catch (error) {
                logger.error('Error during client shutdown:', error);
            }
        }
        process.exit(0);
    });
    
    const handleShutdown = async (message) => {
        await message.reply('🔄 Shutting down bot...');
        logger.info('Shutdown initiated by admin');
        
        // Gracefully close all clients
        for (const client of clients.values()) {
            try {
                await client.destroy();
            } catch (error) {
                logger.error('Error during client shutdown:', error);
            }
        }
        
        await message.reply('✅ Shutdown complete. Bot is now offline.');
        process.exit(0);
    };
    
    // Define handleSudoCommand and handleGroupCommand before they're used
    const handleSudoCommand = async (message, args) => {
        if (!isAuthorized(message.from)) {
            await message.reply('🚫 You are not authorized to use sudo commands');
            return;
        }
    
        if (!args.length) {
            await message.reply(`*Sudo Commands:*
    !sudo stats - Show detailed system stats
    !sudo list - List all active sessions
    !sudo clearsessions - Clear inactive sessions
    !sudo broadcast [message] - Send message to all chats`);
            return;
        }
    
        const subCommand = args[0];
        
        switch (subCommand) {
            case 'stats':
                const memUsage = process.memoryUsage();
                const stats = `*System Statistics:*
    - Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)} MB
    - Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB
    - RSS: ${Math.round(memUsage.rss / 1024 / 1024)} MB
    - Active Sessions: ${clients.size}
    - Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`;
                await message.reply(stats);
                break;
                
            case 'list':
                const sessionList = Array.from(clients.keys()).map((id, index) => 
                    `${index + 1}. Session ID: ${id}`
                ).join('\n');
                await message.reply(`*Active Sessions:*\n${sessionList || 'No active sessions'}`);
                break;
                
            case 'clearsessions':
                const sessionDir = fs.readdirSync(SESSION_DIR);
                let removed = 0;
                
                for (const file of sessionDir) {
                    const sessionId = file.replace('session-', '').replace('.json', '');
                    if (!clients.has(sessionId)) {
                        fs.unlinkSync(path.join(SESSION_DIR, file));
                        removed++;
                    }
                }
                
                await message.reply(`✅ Cleared ${removed} inactive session files`);
                break;
                
            case 'broadcast':
                const broadcastMsg = args.slice(1).join(' ');
                if (!broadcastMsg) {
                    await message.reply('Please provide a message to broadcast');
                    return;
                }
                
                let sent = 0;
                for (const client of clients.values()) {
                    try {
                        const chats = await client.getChats();
                        for (const chat of chats) {
                            await chat.sendMessage(`*BROADCAST*\n\n${broadcastMsg}`);
                            sent++;
                        }
                    } catch (error) {
                        logger.error('Broadcast error:', error);
                    }
                }
                
                await message.reply(`✅ Broadcast sent to ${sent} chats`);
                break;
                
            default:
                await message.reply('Unknown sudo command. Use !sudo for help.');
        }
    };
    
    const handleGroupCommand = async (message, callback) => {
        try {
            const chat = await message.getChat();
            
            if (!chat.isGroup) {
                await message.reply('This command can only be used in groups');
                return;
            }
            
            await callback(chat);
        } catch (error) {
            logger.error('Group command error:', error);
            await message.reply('An error occurred while processing the group command');
        }
    };
    
    const sendDocument = async (message) => {
        try {
            if (!fs.existsSync(mediaPath.document)) {
                await message.reply(`Document not found at ${mediaPath.document}`);
                return;
            }
            
            const document = MessageMedia.fromFilePath(mediaPath.document);
            await message.reply(document, undefined, { 
                caption: 'Here is your requested document',
                sendMediaAsDocument: true 
            });
            
            logger.info(`Document sent to ${message.from}`);
        } catch (error) {
            logger.error('Error sending document:', error);
            await message.reply('Failed to send document');
        }
    };
    
   // Start up to 1000 sessions (configurable)
const MAX_SESSIONS = 1000;
let current = 0; // Add this line right here, before createMultipleSessions
const createMultipleSessions = () => {
    if (current >= MAX_SESSIONS) return;
    if (clients.size >= 5) { // Limit to 5 active sessions at a time
        logger.info(`Already have ${clients.size} active sessions. Waiting before creating more.`);
        setTimeout(createMultipleSessions, 60000); // Check again in 1 minute
        return;
    }
    createNewSession();
    current++;
    setTimeout(createMultipleSessions, 30000); // Increased delay to 30 seconds
};
  

// Add this function to periodically clean up inactive sessions
const cleanupInactiveSessions = () => {
    for (const [sessionId, client] of clients.entries()) {
        try {
            // Check if client is still active
            const state = client.getState();
            if (state === 'DISCONNECTED') {
                logger.info(`Cleaning up inactive session ${sessionId}`);
                clients.delete(sessionId);
            }
        } catch (error) {
            logger.error(`Error checking session ${sessionId}:`, error);
            // If we can't check the state, assume it's inactive
            clients.delete(sessionId);
        }
    }
    
    // Run cleanup every 30 minutes
    setTimeout(cleanupInactiveSessions, 1800000);
};

// Add all the function implementations here:
const handleMeetingCommand = async (message, args, client) => {
    // Function implementation...
};

const handleEventCommand = async (message, args, client) => {
    // Function implementation...
};

const scheduleReminder = (reminder, client) => {
    // Function implementation...
};

const sendAdvanceNotification = async (reminder, client, timeFrame) => {
    // Function implementation...
};

const sendReminderNotification = async (reminder, client) => {
    // Function implementation...
};

const listReminders = async (message, client) => {
    // Function implementation...
};

const cancelReminder = async (message, args) => {
    // Function implementation...
};


// Start the cleanup process in the module.exports.start function
module.exports = {
  start: () => {
    createMultipleSessions();
    cleanupInactiveSessions(); // Add this line
  },
  createNewSession,
  clients
};


const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
    // Send real-time bot status to admin
    ws.send(JSON.stringify({
        type: 'status',
        data: { sessions: activeSessions, connected: true }
    }));
    
    // Receive commands from admin
    ws.on('message', (data) => {
        const command = JSON.parse(data);
        handleAdminCommand(command);
    });
});

// In bot.js - Add Express server
const express = require('express');
const app = express();

app.get('/api/sessions', (req, res) => {
    res.json({ sessions: activeSessions });
});

app.post('/api/broadcast', (req, res) => {
    // Send broadcast message
    sendBroadcast(req.body.message, req.body.recipients);
    res.json({ success: true });
});

// bot.js
const io = require('socket.io')(3000);

io.on('connection', (socket) => {
    console.log('Admin connected');
    
    // Send real-time updates
    socket.emit('sessionUpdate', activeSessions);
    
    // Listen for admin commands
    socket.on('sendMessage', (data) => {
        client.sendMessage(data.to, data.message);
    });
});
  
    module.exports = {
      start: () => {
        createMultipleSessions();
      },
      createNewSession,
      clients
    };
    

            
        



