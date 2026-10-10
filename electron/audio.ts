import { EventEmitter } from 'node:events';
import path from 'node:path';
import { chooseMicrophoneDevice, type MicRoutingDecision } from './micRouting';

/**
 * Two independent 16 kHz PCM16 mono streams:
 *   - `me`   = microphone (cpal)
 *   - `them` = system output audio (Core Audio process tap, ScreenCaptureKit fallback)
 *
 * Backed by the natively-audio napi module (Rust) copied from the terapia app.
 * Speaker identity comes from the channel, so no diarization is needed.
 */
export type Channel = 'me' | 'them';

export interface ChannelStatus {
  channel: Channel;
  state: 'idle' | 'starting' | 'running' | 'error' | 'rebinding';
  detail?: string;
}

interface NativeCapture {
  getSampleRate(): number;
  getNativeSampleRate(): number;
  start(
    onPcm: (err: Error | null, chunk: Buffer) => void,
    onSpeechEnded?: (err: Error | null, ended: boolean) => void,
  ): void;
  stop(): void;
}

interface NativeModule {
  MicrophoneCapture: new (deviceId?: string | null) => NativeCapture;
  SystemAudioCapture: new (deviceId?: string | null) => NativeCapture;
  getDefaultOutputDeviceId(): string;
  getOutputDevices(): Array<{ id: string; name: string }>;
  getInputDevices(): Array<{ id: string; name: string }>;
}

const OUTPUT_ROUTE_POLL_MS = 4000;
const LEVEL_EMIT_MS = 100;

export class AudioEngine extends EventEmitter {
  private native: NativeModule | null = null;
  private loadError: string | null = null;
  private captures = new Map<Channel, NativeCapture>();
  private rates = new Map<Channel, number>();
  private running = false;
  private routeTimer: NodeJS.Timeout | null = null;
  private observedOutput = '';
  private lastLevelAt = new Map<Channel, number>();
  private chunkCount = new Map<Channel, number>();
  private micRouting: MicRoutingDecision | null = null;

  constructor(private readonly nativeDir: string) {
    super();
    try {
      // index.js picks index.darwin-arm64.node for this machine.
      this.native = require(path.join(nativeDir, 'index.js')) as NativeModule;
    } catch (err: any) {
      this.loadError = err?.message ?? String(err);
      console.error('[audio] native module failed to load:', this.loadError);
    }
  }

  available(): boolean {
    return this.native !== null;
  }

  unavailableReason(): string | null {
    return this.loadError;
  }

  isRunning(): boolean {
    return this.running;
  }

  sampleRate(channel: Channel): number {
    return this.rates.get(channel) ?? 16000;
  }

  chunksReceived(channel: Channel): number {
    return this.chunkCount.get(channel) ?? 0;
  }

  /** How the microphone was routed for the current capture (diagnostics / UI). */
  microphoneRouting(): MicRoutingDecision | null {
    return this.micRouting;
  }

  /**
   * Bluetooth output means: open the built-in mic, never the headset's, so
   * the headset stays in A2DP and the tap on it delivers clean audio.
   */
  private decideMicrophone(): MicRoutingDecision {
    if (!this.native) return { deviceId: null, deviceName: null, reason: 'default', outputName: '' };
    const { inputs, outputs } = this.devices();
    let defaultOutputId = '';
    try { defaultOutputId = this.native.getDefaultOutputDeviceId() || ''; } catch { /* keep empty */ }
    return chooseMicrophoneDevice({ inputs, outputs, defaultOutputId });
  }

  devices(): { inputs: Array<{ id: string; name: string }>; outputs: Array<{ id: string; name: string }> } {
    if (!this.native) return { inputs: [], outputs: [] };
    try {
      return { inputs: this.native.getInputDevices(), outputs: this.native.getOutputDevices() };
    } catch {
      return { inputs: [], outputs: [] };
    }
  }

  async start(): Promise<{ started: Channel[]; failures: Array<{ channel: Channel; error: string }> }> {
    if (!this.native) throw new Error(`Native audio engine unavailable: ${this.loadError}`);
    if (this.running) return { started: [...this.captures.keys()], failures: [] };
    this.running = true;
    const failures: Array<{ channel: Channel; error: string }> = [];
    // Mic first: opening the tap before the mic can push a Bluetooth headset
    // into its low-quality call profile (HFP) and mangle the system channel.
    for (const channel of ['me', 'them'] as const) {
      try {
        this.open(channel);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        failures.push({ channel, error: message });
        this.emitStatus(channel, 'error', message);
      }
    }
    if (this.captures.has('them')) this.startRouteWatcher();
    if (this.captures.size === 0) this.running = false;
    return { started: [...this.captures.keys()], failures };
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopRouteWatcher();
    for (const [channel, cap] of this.captures) {
      try { cap.stop(); } catch (err) { console.warn(`[audio] stop ${channel} failed`, err); }
      this.emitStatus(channel, 'idle');
    }
    this.captures.clear();
    // Native teardown is deferred on a DSP thread; give it a beat before a restart.
    await new Promise((r) => setTimeout(r, 150));
  }

  private open(channel: Channel): void {
    if (!this.native) return;
    this.emitStatus(channel, 'starting');
    let cap: NativeCapture;
    if (channel === 'me') {
      this.micRouting = this.decideMicrophone();
      cap = new this.native.MicrophoneCapture(this.micRouting.deviceId);
    } else {
      cap = new this.native.SystemAudioCapture(null);
    }
    this.chunkCount.set(channel, 0);
    cap.start(
      (err, chunk) => {
        if (err) {
          this.emitStatus(channel, 'error', err.message);
          this.emit('error', { channel, error: err });
          return;
        }
        if (!this.running || !chunk || chunk.length === 0) return;
        if (this.captures.get(channel) !== cap) return; // stale capture after a rebind
        const n = (this.chunkCount.get(channel) ?? 0) + 1;
        this.chunkCount.set(channel, n);
        if (n === 1) {
          this.rates.set(channel, this.safeRate(cap));
          this.emitStatus(channel, 'running', this.describe(channel, cap));
        }
        this.emit('pcm', channel, chunk);
        this.maybeEmitLevel(channel, chunk);
      },
      (err, ended) => {
        if (!err && ended && this.running) this.emit('speech-ended', channel);
      },
    );
    this.captures.set(channel, cap);
    this.rates.set(channel, this.safeRate(cap));
    if (channel === 'them') {
      try { this.observedOutput = this.native.getDefaultOutputDeviceId() || ''; } catch { this.observedOutput = ''; }
    }
  }

  private describe(channel: Channel, cap: NativeCapture): string {
    let nativeRate = 0;
    try { nativeRate = cap.getNativeSampleRate(); } catch { /* ignore */ }
    if (channel === 'me') {
      const r = this.micRouting;
      const mic = r?.deviceName ?? 'microfone padrão';
      const why = r?.reason === 'avoid_bluetooth_hfp' ? ` (saída Bluetooth: ${r.outputName})` : '';
      return `${mic}${why}, ${nativeRate || '?'} Hz`;
    }
    const out = this.micRouting?.outputName || 'saída padrão';
    const hfp = nativeRate > 0 && nativeRate <= 24000 ? ' · ATENÇÃO: taxa de HFP, áudio degradado' : '';
    return `${out}, ${nativeRate || '?'} Hz${hfp}`;
  }

  private safeRate(cap: NativeCapture): number {
    try {
      const r = cap.getSampleRate();
      return r > 0 ? r : 16000;
    } catch {
      return 16000;
    }
  }

  private maybeEmitLevel(channel: Channel, chunk: Buffer): void {
    const now = Date.now();
    if (now - (this.lastLevelAt.get(channel) ?? 0) < LEVEL_EMIT_MS) return;
    this.lastLevelAt.set(channel, now);
    const samples = chunk.length >> 1;
    if (samples === 0) return;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
      const s = chunk.readInt16LE(i * 2) / 32768;
      sum += s * s;
    }
    this.emit('level', channel, Math.sqrt(sum / samples));
  }

  /** The tap binds to the default output at open time; follow headphone switches. */
  private startRouteWatcher(): void {
    this.stopRouteWatcher();
    this.routeTimer = setInterval(() => {
      if (!this.running || !this.native || !this.captures.has('them')) return;
      let current = '';
      try { current = this.native.getDefaultOutputDeviceId() || ''; } catch { return; }
      if (!current || current === this.observedOutput) return;
      if (!this.observedOutput) { this.observedOutput = current; return; }
      this.observedOutput = current;
      this.emitStatus('them', 'rebinding', 'output device changed');
      // The new output may be a Bluetooth headset, which changes which mic is
      // safe to open. Reopen the mic first so the headset never enters HFP
      // before the tap binds to it, then rebind the tap.
      const wanted = this.decideMicrophone();
      const micChanged = this.captures.has('me') && wanted.deviceId !== (this.micRouting?.deviceId ?? null);
      const oldTap = this.captures.get('them');
      this.captures.delete('them');
      try { oldTap?.stop(); } catch { /* ignore */ }
      if (micChanged) {
        const oldMic = this.captures.get('me');
        this.captures.delete('me');
        try { oldMic?.stop(); } catch { /* ignore */ }
      }
      setTimeout(() => {
        if (!this.running) return;
        for (const ch of (micChanged ? ['me', 'them'] : ['them']) as Channel[]) {
          try {
            this.open(ch);
          } catch (err: any) {
            this.emitStatus(ch, 'error', err?.message ?? String(err));
          }
        }
      }, 400);
    }, OUTPUT_ROUTE_POLL_MS);
  }

  private stopRouteWatcher(): void {
    if (this.routeTimer) clearInterval(this.routeTimer);
    this.routeTimer = null;
  }

  private emitStatus(channel: Channel, state: ChannelStatus['state'], detail?: string): void {
    const status: ChannelStatus = { channel, state, detail };
    this.emit('status', status);
  }
}
