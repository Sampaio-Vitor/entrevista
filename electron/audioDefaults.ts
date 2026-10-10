import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Wrapper for native/audio-defaults (CoreAudio HAL helper, see
 * scripts/audio-defaults.swift). Gives us what the capture module hides:
 * the real nominal sample rate of the default output (HFP shows as <= 24 kHz
 * on a Bluetooth device) and the ability to change the system default input.
 */
export interface DeviceInfo {
  id: number;
  name: string;
  uid: string;
  sampleRate: number;
  transport: string;
  inputChannels: number;
  outputChannels: number;
}

export interface AudioStatus {
  output?: DeviceInfo;
  input?: DeviceInfo;
  inputs: DeviceInfo[];
  outputs: DeviceInfo[];
}

export class AudioDefaults {
  private readonly bin: string;

  constructor(nativeDir: string) {
    this.bin = path.join(nativeDir, 'audio-defaults');
  }

  available(): boolean {
    return fs.existsSync(this.bin);
  }

  private run(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout: 4000 }, (err, stdout) => {
        const text = String(stdout || '').trim();
        let parsed: any = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* fall through */ }
        if (err && !parsed) return reject(new Error(`audio-defaults ${args[0]} failed: ${err.message}`));
        resolve(parsed);
      });
    });
  }

  async status(): Promise<AudioStatus | null> {
    if (!this.available()) return null;
    try {
      const s = await this.run(['status']);
      return s ? { inputs: [], outputs: [], ...s } : null;
    } catch {
      return null;
    }
  }

  /** Returns the previous default input (to restore later), or null on failure. */
  async setDefaultInput(nameOrUid: string): Promise<DeviceInfo | null> {
    if (!this.available()) return null;
    try {
      const r = await this.run(['set-input', nameOrUid]);
      return r && r.ok ? (r.previous ?? null) : null;
    } catch {
      return null;
    }
  }
}

/** Bluetooth output running at a telephone-grade rate = hands-free profile. */
export function isHfpRate(output: DeviceInfo | undefined): boolean {
  return Boolean(output && output.transport === 'bluetooth' && output.sampleRate > 0 && output.sampleRate <= 24000);
}
