// patch-subscription.js
// This will patch the subscription check to be less aggressive

const fs = require('fs');
const path = require('path');

console.log('🔧 Patching subscription check logic...');

// Read the current bot.js file
const botPath = path.join(__dirname, 'bot.js');
let botContent = fs.readFileSync(botPath, 'utf8');

// Find and replace the problematic subscription check
const oldCheck = `// 🔑 SKIP CHECK for recently created sessions (give them 5 minutes to set up)
                const sessionAge = Date.now() - new Date(session.createdAt).getTime();
                if (sessionAge < 5 * 60 * 1000) { // 5 minutes`;

const newCheck = `// 🔑 SKIP CHECK for recently created sessions (give them 15 minutes to set up)
                const sessionAge = Date.now() - new Date(session.createdAt).getTime();
                if (sessionAge < 15 * 60 * 1000) { // 15 minutes`;

// Replace the check
if (botContent.includes(oldCheck)) {
    botContent = botContent.replace(oldCheck, newCheck);
    console.log('✅ Updated session age check from 5 to 15 minutes');
} else {
    console.log('⚠️ Could not find exact match for session age check');
}

// Also add owner bypass logic
const ownerBypassLogic = `
        // 🔑 OWNER BYPASS: Skip check if user ID matches owner
        if (session.userId && session.userId.toString() === '68f8cc03463c75fb02668fd1') {
            console.log('👑 Skipping subscription check for owner user');
            continue;
        }`;

// Find where to insert owner bypass
const insertPoint = `// Check subscription status
                const subscriptionCheck = await checkUserSubscriptionStatus(session.userId);`;

if (botContent.includes(insertPoint)) {
    botContent = botContent.replace(insertPoint, ownerBypassLogic + '\n\n                ' + insertPoint);
    console.log('✅ Added owner bypass logic');
}

// Write the patched file
fs.writeFileSync(botPath, botContent);
console.log('✅ Bot.js patched successfully');
console.log('🔄 Please restart your server');