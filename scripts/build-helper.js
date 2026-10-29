#!/usr/bin/env node
// Compiles the Swift helpers with swiftc:
//   scripts/audio-defaults.swift -> native/audio-defaults
//   scripts/calendar.swift       -> native/EntrevistaCalendar.app (bundle, so
//                                   macOS can show the calendar permission prompt)
// Each is skipped (with a warning) when swiftc is missing; the app then runs
// without HFP detection / the default-input switch, or without the calendar.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const scripts = __dirname;
const native = path.join(__dirname, '..', 'native');

function upToDate(src, out) {
  return fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs;
}

function buildAudioDefaults() {
  const src = path.join(scripts, 'audio-defaults.swift');
  const out = path.join(native, 'audio-defaults');
  if (upToDate(src, out)) return console.log('[build-helper] native/audio-defaults is up to date.');
  execFileSync('xcrun', ['swiftc', '-O', '-o', out, src], { stdio: 'inherit' });
  fs.chmodSync(out, 0o755);
  console.log('[build-helper] built native/audio-defaults');
}

function buildCalendar() {
  const src = path.join(scripts, 'calendar.swift');
  const app = path.join(native, 'EntrevistaCalendar.app');
  const bin = path.join(app, 'Contents', 'MacOS', 'EntrevistaCalendar');
  if (upToDate(src, bin)) return console.log('[build-helper] native/EntrevistaCalendar.app is up to date.');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const why = 'Entrevista lists your upcoming meetings so you can join and record them in one click.';
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key><string>local.entrevista.calendar</string>
\t<key>CFBundleName</key><string>Entrevista Calendar</string>
\t<key>CFBundleDisplayName</key><string>Entrevista</string>
\t<key>CFBundleExecutable</key><string>EntrevistaCalendar</string>
\t<key>CFBundlePackageType</key><string>APPL</string>
\t<key>LSUIElement</key><true/>
\t<key>NSCalendarsFullAccessUsageDescription</key><string>${why}</string>
\t<key>NSCalendarsUsageDescription</key><string>${why}</string>
</dict>
</plist>
`);
  execFileSync('xcrun', ['swiftc', '-O', '-o', bin, src], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
  console.log('[build-helper] built native/EntrevistaCalendar.app');
}

for (const build of [buildAudioDefaults, buildCalendar]) {
  try {
    build();
  } catch (err) {
    console.warn(`[build-helper] ${build.name} failed (is Xcode or the Command Line Tools installed?):`, err.message);
  }
}
