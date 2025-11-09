// quick-test.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'quick-test' }),
    puppeteer: { headless: true, args: ['--no-sandbox'] },
    qrMaxRetries: 10,
    authTimeoutMs: 300000
});

client.on('qr', (qr) => {
    console.log('📱 QUICK TEST: Scan this QR NOW!');
    qrcode.generate(qr, {small: true});
});

client.on('authenticated', () => console.log('✅ QUICK TEST: Authenticated!'));
client.on('ready', () => console.log('✅ QUICK TEST: Ready!'));

client.initialize();