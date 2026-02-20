#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function read(file) {
    return fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
}

function extractLegacyCommands(botJs) {
    const out = new Set();
    const re = /case\s+'([a-z0-9]+)'\s*:/g;
    let m;
    while ((m = re.exec(botJs)) !== null) {
        out.add(m[1]);
    }

    // Not bot commands; they are matchType labels in switch statements.
    ["exact", "starts", "ends", "contains"].forEach(x => out.delete(x));
    return out;
}

function extractNewCommands(botEngineJs) {
    const out = new Set();
    const re = /cmd\s*===\s*"([a-z0-9]+)"/g;
    let m;
    while ((m = re.exec(botEngineJs)) !== null) {
        out.add(m[1]);
    }
    return out;
}

function extractAliasMap(botEngineJs) {
    const aliasMap = new Map();
    const blockMatch = botEngineJs.match(/const\s+aliasMap\s*=\s*\{([\s\S]*?)\};/);
    if (!blockMatch) return aliasMap;

    const body = blockMatch[1];
    const re = /([a-z0-9]+)\s*:\s*"([a-z0-9]+)"/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        aliasMap.set(m[1], m[2]);
    }
    return aliasMap;
}

function extractOwnerOnly(botEngineJs) {
    const out = new Set();
    const blockMatch = botEngineJs.match(/const\s+ownerOnly\s*=\s*new\s+Set\(\[([\s\S]*?)\]\);/);
    if (!blockMatch) return out;
    const body = blockMatch[1];
    const re = /"([a-z0-9]+)"/g;
    let m;
    while ((m = re.exec(body)) !== null) out.add(m[1]);
    return out;
}

function main() {
    const botJs = read("worker/bot.js");
    const engineJs = read("worker/botEngine.js");

    const legacy = extractLegacyCommands(botJs);
    const current = extractNewCommands(engineJs);
    const aliasMap = extractAliasMap(engineJs);
    const ownerOnly = extractOwnerOnly(engineJs);

    const missing = [];
    for (const cmd of legacy) {
        if (current.has(cmd)) continue;
        const mapped = aliasMap.get(cmd);
        if (mapped && current.has(mapped)) continue;
        missing.push(cmd);
    }

    const badAliasTargets = [];
    for (const [src, dst] of aliasMap.entries()) {
        if (!current.has(dst)) badAliasTargets.push(`${src}->${dst}`);
    }

    const criticalCommands = [
        "help", "ping", "list", "listall", "status",
        "syncmembers", "mygroups", "use", "unset",
        "members", "admins",
        "tag", "tagexcept", "tagfew",
        "dmall", "dmallmulti", "dmselected",
        "forwardone", "forwardmulti", "forwardall",
        "broadcast", "broadcastdm",
        "autoreply", "keyword", "find",
        "allow", "unallow", "deny", "unblock", "whitelist", "blocklist",
        "schedule", "listschedules", "cancelschedule",
        "antilink", "antidelete", "welcome"
    ];

    const missingCritical = criticalCommands.filter(c => !current.has(c));
    const notOwnerOnly = criticalCommands.filter(c => c !== "ping" && c !== "help" && !ownerOnly.has(c));

    console.log("Legacy command count:", legacy.size);
    console.log("Current command count:", current.size);
    console.log("Alias count:", aliasMap.size);
    console.log("Owner-only command count:", ownerOnly.size);

    if (missing.length) {
        console.error("Missing legacy commands:", missing.join(", "));
    } else {
        console.log("Legacy parity: OK");
    }

    if (missingCritical.length) {
        console.error("Missing critical commands:", missingCritical.join(", "));
    } else {
        console.log("Critical command coverage: OK");
    }

    if (badAliasTargets.length) {
        console.error("Broken alias targets:", badAliasTargets.join(", "));
    } else {
        console.log("Alias wiring: OK");
    }

    if (notOwnerOnly.length) {
        console.error("Non-ownerOnly critical commands:", notOwnerOnly.join(", "));
    } else {
        console.log("Owner-only guard coverage: OK");
    }

    if (missing.length || missingCritical.length || badAliasTargets.length || notOwnerOnly.length) {
        process.exit(1);
    }

    console.log("Command wiring verification PASSED");
}

main();

