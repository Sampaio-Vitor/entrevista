import fs from 'node:fs';
import type { Channel } from './audio';

/**
 * One 16 kHz mono PCM16 WAV per channel, appended chunk by chunk while the
 * session runs. The header is written with zero sizes and patched on close,
 * so a crash mid-session still leaves a file that most tools can repair.
 */
export interface RecordedFile {
  channel: Channel;
  path: string;
  /** Wall-clock time of the first PCM chunk: offsets in the file map to this. */
  startedAt: number;
  bytes: number;
  sampleRate: number;
}

const HEADER_BYTES = 44;

class WavFile {
  private fd: number | null = null;
  private bytes = 0;
  private startedAt = 0;

  constructor(readonly channel: Channel, readonly path: string, readonly sampleRate: number) {
    this.fd = fs.openSync(path, 'w');
    fs.writeSync(this.fd, header(sampleRate, 0));
  }

  append(chunk: Buffer, now: number): void {
    if (this.fd === null || chunk.length === 0) return;
    if (this.startedAt === 0) this.startedAt = now;
    fs.writeSync(this.fd, chunk);
    this.bytes += chunk.length;
  }

  close(): RecordedFile | null {
    if (this.fd === null) return null;
    const fd = this.fd;
    this.fd = null;
    try {
      fs.writeSync(fd, header(this.sampleRate, this.bytes), 0, HEADER_BYTES, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (this.bytes === 0) {
      try { fs.rmSync(this.path, { force: true }); } catch { /* ignore */ }
      return null;
    }
    return { channel: this.channel, path: this.path, startedAt: this.startedAt, bytes: this.bytes, sampleRate: this.sampleRate };
  }
}

export class Recorder {
  private files = new Map<Channel, WavFile>();

  get active(): boolean {
    return this.files.size > 0;
  }

  start(channel: Channel, path: string, sampleRate: number): void {
    this.files.get(channel)?.close();
    this.files.set(channel, new WavFile(channel, path, sampleRate));
  }

  write(channel: Channel, chunk: Buffer): void {
    this.files.get(channel)?.append(chunk, Date.now());
  }

  /** Close every file; returns the ones that got audio. */
  stop(): RecordedFile[] {
    const out: RecordedFile[] = [];
    for (const f of this.files.values()) {
      try {
        const r = f.close();
        if (r) out.push(r);
      } catch (err) {
        console.error(`[recorder] close ${f.channel} failed`, err);
      }
    }
    this.files.clear();
    return out;
  }
}

function header(sampleRate: number, dataBytes: number): Buffer {
  const b = Buffer.alloc(HEADER_BYTES);
  const channels = 1;
  const bits = 16;
  const blockAlign = channels * (bits / 8);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);              // fmt chunk size
  b.writeUInt16LE(1, 20);               // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}
