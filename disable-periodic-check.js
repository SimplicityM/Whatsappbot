// disable-periodic-check.js
const fs = require('fs');
const path = require('path');

console.log('🔧 Disabling periodic subscription check...');

const botPath = path.join(__dirname, 'bot.js');
let botContent = fs.readFileSync(botPath, 'utf8');

// Find and disable the periodic check
const patterns = [
    'setInterval(periodicSubscriptionCheck, 5 * 60 * 1000);',
    'setTimeout(periodicSubscriptionCheck, 30000);'
];

patterns.forEach(pattern => {
    if (botContent.includes(pattern)) {
        botContent = botContent.replace(pattern, `// ${pattern} // DISABLED FOR TESTING`);
        console.log(`✅ Disabled: ${pattern}`);
    }
});

fs.writeFileSync(botPath, botContent);
console.log('✅ Periodic subscription check disabled');
console.log('🔄 Please restart your server');