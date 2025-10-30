const { Client: WhatsAppClient, MessageMedia } = require('whatsapp-web.js');
const { generate } = require('qrcode-terminal');
const readline = require('readline');

// Create WhatsApp client
const client = new WhatsAppClient({
    puppeteer: { headless: true }
});

// Create readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const mediaPath = {
    audio: './media/audio.mp3',
    document: './media/document.pdf',
    image: './media/image.jpg'
};

const authorizedNumbers = [
    '1234567890@c.us',
    '9876543210@c.us',
    '5555555555@c.us'
];

// Helper functions
const isAuthorized = (number) => authorizedNumbers.includes(number);

const isGroupAdmin = async (chat, participant) => {
    const adminParticipants = chat.participants.filter(p => p.isAdmin);
    return adminParticipants.some(p => p.id._serialized === participant);
};

const handleShutdown = async (message) => {
    try {
        await message.reply('Bot shutting down...');
        await client.destroy();
        process.exit(0);
    } catch (error) {
        console.error('Shutdown error:', error);
    }
};

// QR Code Event
client.on('qr', (qr) => {
    console.log('Scan the QR code to log in:');
    generate(qr);
});

// Authenticated Event
client.on('authenticated', () => {
    console.log('Authentication successful.');
    rl.close();
});

// Ready Event
client.on('ready', () => {
    console.log('WhatsApp bot is ready!');
});

// Disconnected Event
client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
    client.initialize();
});

// Message Handler
client.on('message', async (msg) => {
    if (isAuthorized(msg.from)) {
        if (msg.body.startsWith('!command')) {
            // Handle command
        }
    }

    if (msg.body.toLowerCase() === 'hello') {
        await msg.reply('Hi there! How can I help you today?');
    } else if (msg.body.toLowerCase() === 'send audio') {
        try {
            const media = MessageMedia.fromFilePath(mediaPath.audio);
            await client.sendMessage(msg.from, media);
        } catch (error) {
            console.error('Audio sending error:', error);
            await msg.reply('Failed to send audio.');
        }
    }
});

// Signal Handlers for Cleanup
process.on('SIGTERM', () => {
    client.destroy();
    process.exit(0);
});

process.on('SIGINT', () => {
    client.destroy();
    process.exit(0);
});

// Initialize client
client.initialize();
