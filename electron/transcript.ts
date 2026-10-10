import { EventEmitter } from 'node:events';
import type { Channel } from './audio';
import type { SttResult } from './stt/deepgram';
import { addCounts, guessLang, majority, type Lang, type LangCounts } from './lang';

export interface Segment {
  id: number;
  speaker: Channel;
  text: string;
  final: boolean;
  startedAt: number;
  updatedAt: number;
  /** Detected on close; null when too short or mixed to tell. */
  lang?: Lang | null;
}

interface OpenUtterance {
  seg: Segment;
  finals: string[];
  interim: string;
  finalCounts: LangCounts;
  interimCounts: LangCounts;
}

const MAX_DONE = 600;
const UPDATE_THROTTLE_MS = 40;

/**
 * Rolling transcript. Each channel has at most one open utterance that
 * absorbs interim results until Deepgram marks speech_final (or we force
 * a close from the native VAD / UtteranceEnd). Closed utterances are frozen.
 */
export class Transcript extends EventEmitter {
  private done: Segment[] = [];
  private open = new Map<Channel, OpenUtterance>();
  private nextId = 1;
  private updateTimer: NodeJS.Timeout | null = null;

  applyResult(r: SttResult): void {
    const text = r.text.trim();
    let u = this.open.get(r.channel);
    if (!u) {
      if (!text) return; // nothing to open an utterance with
      u = {
        seg: { id: this.nextId++, speaker: r.channel, text: '', final: false, startedAt: Date.now(), updatedAt: Date.now() },
        finals: [],
        interim: '',
        finalCounts: {},
        interimCounts: {},
      };
      this.open.set(r.channel, u);
    }
    if (r.isFinal) {
      if (text) u.finals.push(text);
      addCounts(u.finalCounts, r.langCounts);
      u.interim = '';
      u.interimCounts = {};
    } else {
      u.interim = text;
      u.interimCounts = r.langCounts;
    }
    u.seg.text = [...u.finals, u.interim].filter(Boolean).join(' ');
    u.seg.updatedAt = Date.now();
    if (r.speechFinal || r.fromFinalize) {
      this.closeUtterance(r.channel);
    } else {
      this.scheduleUpdate();
    }
  }

  /** Freeze the open utterance on this channel (speech ended). Emits `closed`. */
  closeUtterance(channel: Channel): void {
    const u = this.open.get(channel);
    if (!u) return;
    this.open.delete(channel);
    const text = [...u.finals, u.interim].filter(Boolean).join(' ').trim();
    if (text) {
      u.seg.text = text;
      u.seg.final = true;
      u.seg.updatedAt = Date.now();
      const counts: LangCounts = { ...u.finalCounts };
      addCounts(counts, u.interimCounts);
      u.seg.lang = majority(counts) ?? guessLang(text);
      this.done.push(u.seg);
      if (this.done.length > MAX_DONE) this.done.splice(0, this.done.length - MAX_DONE);
      this.emit('closed', u.seg);
    }
    this.scheduleUpdate();
  }

  clear(): void {
    this.done = [];
    this.open.clear();
    this.scheduleUpdate();
  }

  /** All segments in time order, open utterances included (final=false). */
  segments(): Segment[] {
    const all = [...this.done, ...[...this.open.values()].map((u) => u.seg)];
    all.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
    return all;
  }

  isEmpty(): boolean {
    return this.done.length === 0 && this.open.size === 0;
  }

  /** Last thing the interviewer said (open or closed). */
  lastFrom(speaker: Channel): Segment | undefined {
    const segs = this.segments().filter((s) => s.speaker === speaker);
    return segs[segs.length - 1];
  }

  /**
   * Text for the model: final segments with id > sinceId, plus whatever is
   * still being spoken. Returns the id to resume from next time.
   */
  formatSince(sinceId: number): { text: string; nextSinceId: number; hasNew: boolean } {
    const finals = this.done.filter((s) => s.id > sinceId);
    const opens = [...this.open.values()].map((u) => u.seg).filter((s) => s.text.trim());
    const lines: string[] = [];
    for (const s of finals) lines.push(`${label(s.speaker)}: ${s.text}`);
    for (const s of opens) lines.push(`${label(s.speaker)} (still speaking): ${s.text}`);
    const nextSinceId = finals.length ? finals[finals.length - 1].id : sinceId;
    return { text: lines.join('\n'), nextSinceId, hasNew: lines.length > 0 };
  }

  /** Last N segments, for the screenshot prompt. */
  tail(n: number): string {
    return this.segments().slice(-n).map((s) => `${label(s.speaker)}: ${s.text}`).join('\n');
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.emit('update', this.segments());
    }, UPDATE_THROTTLE_MS);
  }
}

export function label(speaker: Channel): string {
  return speaker === 'me' ? 'ME' : 'INTERVIEWER';
}
