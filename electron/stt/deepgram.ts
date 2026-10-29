import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Channel } from '../audio';
import { normalizeLang, type LangCounts } from '../lang';

/**
 * One Deepgram Nova-3 streaming socket per channel (mono, linear16).
 * Two mono sockets cost the same as one multichannel socket and avoid
 * interleaving two capture clocks into one stereo stream.
 */

/** A run of consecutive words from one speaker inside a result. */
export interface SttPiece {
  /** Deepgram speaker index, offset per connection; null without diarization. */
  speaker: number | null;
  text: string;
  langCounts: LangCounts;
}

export interface SttResult {
  channel: Channel;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  fromFinalize: boolean;
  start: number;
  duration: number;
  /** Words per language, from `language=multi` word tags. Empty otherwise. */
  langCounts: LangCounts;
  /**
   * The result split by speaker, in order. One piece when diarization is off
   * or the whole result is one voice. Always non-empty when `text` is.
   */
  pieces: SttPiece[];
}

export interface DeepgramOptions {
  apiKey: string;
  channel: Channel;
  sampleRate: number;
  model: string;
  language: string;
  endpointingMs: number;
  utteranceEndMs: number;
  smartFormat: boolean;
  /** Ask for per-word speaker labels. */
  diarize?: boolean;
}

const KEEPALIVE_MS = 5000;
const MAX_BACKOFF_MS = 10000;

export class DeepgramStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private backoff = 1000;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private lastAudioAt = 0;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private bytesSent = 0;
  // Speaker indices restart at 0 on every socket. Offsetting them per
  // connection means a new voice is never merged into an old label; the
  // offline pass later unifies the labels anyway.
  private speakerBase = 0;
  private maxSpeakerSeen = -1;

  constructor(private readonly opts: DeepgramOptions) {
    super();
  }

  get channel(): Channel {
    return this.opts.channel;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  stats(): { bytesSent: number } {
    return { bytesSent: this.bytesSent };
  }

  connect(): void {
    this.closedByUser = false;
    const o = this.opts;
    const params = new URLSearchParams({
      model: o.model,
      language: o.language,
      encoding: 'linear16',
      sample_rate: String(o.sampleRate),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: String(o.smartFormat),
      endpointing: String(o.endpointingMs),
      utterance_end_ms: String(o.utteranceEndMs),
      vad_events: 'true',
    });
    if (o.diarize) params.set('diarize', 'true');
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${o.apiKey}` } });
    this.ws = ws;
    if (this.maxSpeakerSeen >= 0) {
      this.speakerBase += this.maxSpeakerSeen + 1;
      this.maxSpeakerSeen = -1;
    }

    ws.on('open', () => {
      this.backoff = 1000;
      this.emit('open');
      // Flush audio that arrived while connecting (bounded, see send()).
      for (const b of this.pending) ws.send(b);
      this.bytesSent += this.pendingBytes;
      this.pending = [];
      this.pendingBytes = 0;
      this.lastAudioAt = Date.now();
      this.startKeepalive();
    });

    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.type) {
        case 'Results': {
          const alt = msg.channel?.alternatives?.[0];
          const text: string = alt?.transcript ?? '';
          const result: SttResult = {
            channel: o.channel,
            text,
            isFinal: Boolean(msg.is_final),
            speechFinal: Boolean(msg.speech_final),
            fromFinalize: Boolean(msg.from_finalize),
            start: Number(msg.start ?? 0),
            duration: Number(msg.duration ?? 0),
            langCounts: countLanguages(alt?.words),
            pieces: this.splitBySpeaker(alt?.words, text),
          };
          // Empty interims carry no information; empty finals still matter
          // (they can carry speech_final / from_finalize).
          if (text || result.isFinal) this.emit('result', result);
          break;
        }
        case 'UtteranceEnd':
          this.emit('utterance-end', o.channel);
          break;
        case 'SpeechStarted':
          this.emit('speech-started', o.channel);
          break;
        case 'Metadata':
          break;
        case 'Error':
          this.emit('error', new Error(`Deepgram: ${msg.description ?? msg.message ?? JSON.stringify(msg)}`));
          break;
        default:
          break;
      }
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });

    ws.on('close', (code, reason) => {
      this.stopKeepalive();
      this.emit('close', { code, reason: reason.toString() });
      if (this.ws === ws) this.ws = null;
      if (!this.closedByUser) {
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        setTimeout(() => { if (!this.closedByUser) this.connect(); }, delay);
      }
    });
  }

  send(pcm: Buffer): void {
    if (this.isOpen()) {
      this.ws!.send(pcm);
      this.bytesSent += pcm.length;
      this.lastAudioAt = Date.now();
      return;
    }
    // Buffer at most ~2 s of 16 kHz PCM16 while (re)connecting.
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes > 64000 && this.pending.length > 0) {
      this.pendingBytes -= this.pending.shift()!.length;
    }
  }

  /** Force Deepgram to flush the current utterance as final right now. */
  finalize(): void {
    if (this.isOpen()) this.ws!.send(JSON.stringify({ type: 'Finalize' }));
  }

  close(): void {
    this.closedByUser = true;
    this.stopKeepalive();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
      ws.close();
    } catch { /* ignore */ }
  }

  /** Group the words of one result into runs of the same speaker. */
  private splitBySpeaker(words: unknown, text: string): SttPiece[] {
    if (!text) return [];
    if (!this.opts.diarize || !Array.isArray(words) || words.length === 0) {
      return [{ speaker: null, text, langCounts: countLanguages(words) }];
    }
    const pieces: SttPiece[] = [];
    let cur: { speaker: number | null; words: string[]; langCounts: LangCounts } | null = null;
    for (const w of words as any[]) {
      const raw = typeof w?.speaker === 'number' ? w.speaker : null;
      if (raw !== null && raw > this.maxSpeakerSeen) this.maxSpeakerSeen = raw;
      const speaker = raw === null ? null : raw + this.speakerBase;
      const token: string = w?.punctuated_word ?? w?.word ?? '';
      if (!token) continue;
      if (!cur || cur.speaker !== speaker) {
        if (cur) pieces.push({ speaker: cur.speaker, text: cur.words.join(' '), langCounts: cur.langCounts });
        cur = { speaker, words: [], langCounts: {} };
      }
      cur.words.push(token);
      const lang = normalizeLang(w?.language);
      if (lang) cur.langCounts[lang] = (cur.langCounts[lang] ?? 0) + 1;
    }
    if (cur) pieces.push({ speaker: cur.speaker, text: cur.words.join(' '), langCounts: cur.langCounts });
    // One voice: keep Deepgram's own formatting of the transcript string.
    if (pieces.length === 1) pieces[0].text = text;
    return pieces.length ? pieces : [{ speaker: null, text, langCounts: countLanguages(words) }];
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (!this.isOpen()) return;
      if (Date.now() - this.lastAudioAt >= KEEPALIVE_MS - 500) {
        this.ws!.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}

function countLanguages(words: unknown): LangCounts {
  const counts: LangCounts = {};
  if (!Array.isArray(words)) return counts;
  for (const w of words) {
    const lang = normalizeLang(w?.language);
    if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
  }
  return counts;
}
