#!/usr/bin/env node
// Adds the macOS privacy usage-description keys to the DEV Electron.app bundle.
// Without NSAudioCaptureUsageDescription macOS never shows the "System Audio
// Recording" prompt, so the Core Audio tap would deliver silence. Idempotent;
// runs on every `npm install` (postinstall). Packaged builds get the same keys
// through electron-builder `mac.extendInfo` (see package.json when added).
const fs = require('fs');
const path = require('path');

const plist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');
if (!fs.existsSync(plist)) {
  console.log('[patch-electron-plist] Info.plist not found, skipping (non-macOS or electron not installed yet).');
  process.exit(0);
}
const keys = {
  NSAudioCaptureUsageDescription: 'Entrevista captures system audio to transcribe the interviewer in real time.',
  NSMicrophoneUsageDescription: 'Entrevista captures your microphone to transcribe your own answers.',
  NSScreenCaptureUsageDescription: 'Entrevista takes screenshots of coding problems when you press the hotkey.',
};
let xml = fs.readFileSync(plist, 'utf8');
let changed = false;
for (const [key, text] of Object.entries(keys)) {
  if (xml.includes(`<key>${key}</key>`)) continue;
  xml = xml.replace('</dict>\n</plist>', `\t<key>${key}</key>\n\t<string>${text}</string>\n</dict>\n</plist>`);
  changed = true;
  console.log(`[patch-electron-plist] added ${key}`);
}
if (changed) fs.writeFileSync(plist, xml);
else console.log('[patch-electron-plist] all keys already present.');
