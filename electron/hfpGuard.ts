import { EventEmitter } from 'node:events';
import { AudioDefaults, isHfpRate, type AudioStatus, type DeviceInfo } from './audioDefaults';

/**
 * Keeps a Bluetooth headset out of hands-free mode during a session.
 *
 * 1. If the default output is Bluetooth, make the built-in microphone the
 *    system default input (so Zoom/Meet on "Same as System" stop opening the
 *    headset mic). Restored when the session stops.
 * 2. Poll the real stream rate; when the headset still drops to HFP (another
 *    app grabbed its mic), raise a visible warning with the fix.
 */
export interface HfpState {
  bluetoothOutput: boolean;
  outputName: string;
  hfp: boolean;
  switchedInputTo: string | null;
  previousInput: string | null;
  message: string | null;
}

const POLL_MS = 8000;

export class HfpGuard extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private previousInput: DeviceInfo | null = null;
  private state: HfpState = { bluetoothOutput: false, outputName: '', hfp: false, switchedInputTo: null, previousInput: null, message: null };

  constructor(private readonly defaults: AudioDefaults, private readonly forceBuiltInMic: boolean) {
    super();
  }

  available(): boolean {
    return this.defaults.available();
  }

  current(): HfpState {
    return this.state;
  }

  async start(): Promise<HfpState> {
    this.stopPolling();
    const status = await this.defaults.status();
    if (!status) return this.state;
    await this.applyRouting(status);
    await this.check(status);
    this.timer = setInterval(() => { void this.check(); }, POLL_MS);
    return this.state;
  }

  async stop(): Promise<void> {
    this.stopPolling();
    if (this.previousInput && this.state.switchedInputTo) {
      await this.defaults.setDefaultInput(this.previousInput.uid || this.previousInput.name);
    }
    this.previousInput = null;
    this.state = { bluetoothOutput: false, outputName: '', hfp: false, switchedInputTo: null, previousInput: null, message: null };
    this.emit('change', this.state);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async applyRouting(status: AudioStatus): Promise<void> {
    const out = status.output;
    this.state.bluetoothOutput = out?.transport === 'bluetooth';
    this.state.outputName = out?.name ?? '';
    if (!this.state.bluetoothOutput || !this.forceBuiltInMic) return;
    const builtIn = status.inputs.find((d) => d.transport === 'builtin');
    if (!builtIn) return;
    if (status.input && status.input.uid === builtIn.uid) return; // already there
    const previous = await this.defaults.setDefaultInput(builtIn.uid || builtIn.name);
    if (previous !== null) {
      this.previousInput = status.input ?? previous;
      this.state.switchedInputTo = builtIn.name;
      this.state.previousInput = this.previousInput?.name ?? null;
    }
  }

  private async check(status?: AudioStatus | null): Promise<void> {
    const s = status ?? await this.defaults.status();
    if (!s) return;
    const hfp = isHfpRate(s.output);
    const changed = hfp !== this.state.hfp || (s.output?.name ?? '') !== this.state.outputName;
    this.state.hfp = hfp;
    this.state.outputName = s.output?.name ?? '';
    this.state.bluetoothOutput = s.output?.transport === 'bluetooth';
    this.state.message = hfp
      ? `${this.state.outputName} está em modo chamada (HFP, ${Math.round(s.output!.sampleRate / 1000)} kHz): o áudio do entrevistador vai sair embaralhado. No Zoom/Meet, escolha o microfone "MacBook Pro Microphone" ou use fone com fio.`
      : null;
    if (changed) this.emit('change', this.state);
  }
}
