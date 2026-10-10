#!/usr/bin/env node
// Compiles scripts/audio-defaults.swift into native/audio-defaults with swiftc.
// Skipped (with a warning) when swiftc is missing; the app then runs without
// HFP detection and without the system-default-input switch.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const src = path.join(__dirname, 'audio-defaults.swift');
const out = path.join(__dirname, '..', 'native', 'audio-defaults');

try {
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
    console.log('[build-helper] native/audio-defaults is up to date.');
    process.exit(0);
  }
  execFileSync('xcrun', ['swiftc', '-O', '-o', out, src], { stdio: 'inherit' });
  fs.chmodSync(out, 0o755);
  console.log('[build-helper] built native/audio-defaults');
} catch (err) {
  console.warn('[build-helper] could not build audio-defaults (is Xcode or the Command Line Tools installed?):', err.message);
}
