#!/usr/bin/env node
// Six-second capture check without the UI: opens the mic (with the same
// Bluetooth routing rule as the app) and the system-audio tap, plays a short
// phrase through the current output, and reports what each channel received.
// Run from a terminal that already has (or will be asked for) the
// "System Audio Recording" permission.
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
let AudioEngine;
try {
  ({ AudioEngine } = require(path.join(root, 'dist', 'audio.js')));
} catch (err) {
  console.error('dist/ not built. Run `npm run build` first.', err.message);
  process.exit(1);
}

const engine = new AudioEngine(path.join(root, 'native'));
if (!engine.available()) {
  console.error('native audio module unavailable:', engine.unavailableReason());
  process.exit(1);
}

const devs = engine.devices();
console.log('outputs:', devs.outputs.map((d) => d.name).join(' | '));
console.log('inputs :', devs.inputs.map((d) => d.name).join(' | '));

const stats = { me: { chunks: 0, bytes: 0, loud: 0, peak: 0 }, them: { chunks: 0, bytes: 0, loud: 0, peak: 0 } };
engine.on('pcm', (ch, buf) => {
  const s = stats[ch];
  s.chunks++; s.bytes += buf.length;
  let max = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const v = Math.abs(buf.readInt16LE(i)); if (v > max) max = v; }
  if (max > 500) s.loud++;
  if (max > s.peak) s.peak = max;
});
engine.on('status', (st) => console.log(`[${st.channel}] ${st.state}${st.detail ? ': ' + st.detail : ''}`));
engine.on('error', (e) => console.log(`[${e.channel}] error: ${e.error.message}`));

(async () => {
  const r = await engine.start();
  console.log('started:', r.started.join(','), r.failures.length ? 'failures: ' + JSON.stringify(r.failures) : '');
  const routing = engine.microphoneRouting();
  console.log('mic routing:', routing ? `${routing.deviceName || 'default'} (${routing.reason}${routing.outputName ? ', output ' + routing.outputName : ''})` : 'n/a');

  console.log('playing test phrase through the current output...');
  const say = spawn('say', ['-v', 'Samantha', 'System audio check. If you can read this in the transcript, the tap is working.']);
  await new Promise((res) => say.on('exit', res));
  await new Promise((res) => setTimeout(res, 1500));
  await engine.stop();

  const sec = (b) => (b / 32000).toFixed(1);
  for (const ch of ['them', 'me']) {
    const s = stats[ch];
    const label = ch === 'them' ? 'SISTEMA' : 'MIC    ';
    console.log(`${label}: ${s.chunks} chunks, ${sec(s.bytes)} s of 16 kHz audio, ${s.loud} chunks with signal, peak ${s.peak}`);
  }
  const t = stats.them;
  if (t.chunks === 0) {
    console.log('\nSISTEMA recebeu nada. Provável: permissão "Gravação de áudio do sistema" negada para este terminal/app. Ajustes > Privacidade e Segurança > Gravação de Tela e Áudio do Sistema.');
  } else if (t.loud === 0) {
    console.log('\nSISTEMA recebeu só silêncio. Verifique se o áudio saiu no dispositivo padrão e se o volume não está zerado.');
  } else {
    console.log('\nSISTEMA OK: o tap capturou a frase.');
  }
  process.exit(0);
})();
