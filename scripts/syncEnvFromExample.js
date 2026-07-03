#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envExamplePath = path.join(root, '.env.example');
const envPath = path.join(root, '.env');

const PROTECTED_KEYS = new Set([
    'PRIVATE_KEY',
    'FUNDER_ADDRESS',
    'TARGET_WALLETS',
    'SOURCE_WALLET',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
]);

function shouldProtect(key) {
    if (PROTECTED_KEYS.has(key)) return true;
    const upper = key.toUpperCase();
    return upper.includes('KEY') || upper.includes('TOKEN') || upper.includes('WALLET');
}

function parseEnvLines(text) {
    const entries = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const i = line.indexOf('=');
        if (i <= 0) continue;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1);
        if (!/^[A-Z0-9_]+$/.test(key)) continue;
        entries.push({ key, value });
    }
    return entries;
}

function parseEnvMap(text) {
    const map = new Map();
    for (const { key, value } of parseEnvLines(text)) {
        map.set(key, value);
    }
    return map;
}

function main() {
    if (!fs.existsSync(envExamplePath)) {
        throw new Error('.env.example not found');
    }

    const exampleText = fs.readFileSync(envExamplePath, 'utf8');
    const exampleEntries = parseEnvLines(exampleText);

    const envExists = fs.existsSync(envPath);
    const currentText = envExists ? fs.readFileSync(envPath, 'utf8') : '';
    const currentMap = parseEnvMap(currentText);

    const updates = [];
    const additions = [];

    for (const { key, value } of exampleEntries) {
        if (shouldProtect(key)) continue;
        if (currentMap.has(key)) {
            if (currentMap.get(key) !== value) {
                currentMap.set(key, value);
                updates.push(key);
            }
        } else {
            currentMap.set(key, value);
            additions.push(key);
        }
    }

    const sortedEntries = [...currentMap.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
    );
    const output = sortedEntries.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

    fs.writeFileSync(envPath, output, 'utf8');

    console.log(`[env:sync] wrote ${envPath}`);
    console.log(
        `[env:sync] updated ${updates.length} var(s), added ${additions.length} var(s), protected secrets skipped`,
    );
    if (updates.length) {
        console.log(`[env:sync] updated: ${updates.join(', ')}`);
    }
    if (additions.length) {
        console.log(`[env:sync] added: ${additions.join(', ')}`);
    }
}

main();
