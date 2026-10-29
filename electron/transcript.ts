import { EventEmitter } from 'node:events';
import type { Channel } from './audio';
import type { SttResult, SttPiece } from './stt/deepgram';
import { addCounts, guessLang, majority, type Lang, type LangCounts } from './lang';

/**
 * Speaker ids: `me` for the microphone, `them` for the system channel without
 * diarization, `them:N` for Deepgram speaker N on the system channel.
 */
export type SpeakerId = string;

export interface Segment {
  id: number;
  channel: Channel;
  speaker: SpeakerId;
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

export type Labeler = (speaker: SpeakerId) => string;

const MAX_DONE = 5000;
const UPDATE_THROTTLE_MS = 40;

/**
 * Rolling transcript. Each channel has at most one open utterance that
 * absorbs interim results until Deepgram marks speech_final (or we force
 * a close from the native VAD / UtteranceEnd). Closed utterances are frozen.
 * On a diarized channel, a final piece from another speaker closes the open
 * utterance and starts a new one, so one segment is always one voice.
 */
export class Transcript extends EventEmitter {
  private done: Segment[] = [];
  private open = new Map<Channel, OpenUtterance>();
  private nextId = 1;
  private updateTimer: NodeJS.Timeout | null = null;
  private labeler: Labeler = defaultLabel;

  /** How speakers are named in text for the model (ME/INTERVIEWER, or people's names). */
  setLabeler(fn: Labeler): void {
    this.labeler = fn;
  }

  label(speaker: SpeakerId): string {
    return this.labeler(speaker);
  }

  applyResult(r: SttResult): void {
    const text = r.text.trim();
    if (r.isFinal) {
      // A final supersedes the interim that announced it; drop the interim
      // first so a speaker change inside this final does not freeze it into
      // the previous voice's segment.
      const open = this.open.get(r.channel);
      if (open) { open.interim = ''; open.interimCounts = {}; }
      for (const piece of r.pieces) this.applyFinalPiece(r.channel, piece);
      const u = this.open.get(r.channel);
      if (u) {
        u.seg.text = u.finals.join(' ');
        u.seg.updatedAt = Date.now();
      }
    } else {
      let u = this.open.get(r.channel);
      if (!u) {
        if (!text) return; // nothing to open an utterance with
        u = this.openUtterance(r.channel, speakerOf(r.channel, r.pieces[0]?.speaker ?? null));
      }
      u.interim = text;
      u.interimCounts = r.langCounts;
      u.seg.text = [...u.finals, u.interim].filter(Boolean).join(' ');
      u.seg.updatedAt = Date.now();
    }
    if (r.speechFinal || r.fromFinalize) {
      this.closeUtterance(r.channel);
    } else {
      this.scheduleUpdate();
    }
  }

  private applyFinalPiece(channel: Channel, piece: SttPiece): void {
    const text = piece.text.trim();
    if (!text) return;
    const speaker = speakerOf(channel, piece.speaker);
    let u = this.open.get(channel);
    if (u && u.finals.length > 0 && u.seg.speaker !== speaker) {
      // Another voice took over mid-stream: freeze what the first one said.
      this.closeUtterance(channel);
      u = undefined;
    }
    if (!u) u = this.openUtterance(channel, speaker);
    else if (u.finals.length === 0) u.seg.speaker = speaker; // interim guess corrected by the first final
    u.finals.push(text);
    addCounts(u.finalCounts, piece.langCounts);
  }

  private openUtterance(channel: Channel, speaker: SpeakerId): OpenUtterance {
    const u: OpenUtterance = {
      seg: { id: this.nextId++, channel, speaker, text: '', final: false, startedAt: Date.now(), updatedAt: Date.now() },
      finals: [],
      interim: '',
      finalCounts: {},
      interimCounts: {},
    };
    this.open.set(channel, u);
    return u;
  }

  /**
   * Freeze the open utterance on this channel (speech ended). Emits `closed`.
   * Without `force`, an utterance that has only interim text stays open: a
   * late UtteranceEnd would otherwise freeze a half-word ("Pode") that the
   * final about to arrive repeats in full. `force` is for stopping a session.
   */
  closeUtterance(channel: Channel, force = false): void {
    const u = this.open.get(channel);
    if (!u) return;
    if (!force && u.finals.length === 0) return;
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

  /** Speaker ids in order of first appearance. */
  speakers(): SpeakerId[] {
    const seen = new Set<SpeakerId>();
    for (const s of this.segments()) seen.add(s.speaker);
    return [...seen];
  }

  /** Last thing said on a channel (open or closed). */
  lastFrom(channel: Channel): Segment | undefined {
    const segs = this.segments().filter((s) => s.channel === channel);
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
    for (const s of finals) lines.push(`${this.labeler(s.speaker)}: ${s.text}`);
    for (const s of opens) lines.push(`${this.labeler(s.speaker)} (still speaking): ${s.text}`);
    const nextSinceId = finals.length ? finals[finals.length - 1].id : sinceId;
    return { text: lines.join('\n'), nextSinceId, hasNew: lines.length > 0 };
  }

  /** Last N segments, for the screenshot prompt. */
  tail(n: number): string {
    return this.segments().slice(-n).map((s) => `${this.labeler(s.speaker)}: ${s.text}`).join('\n');
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.emit('update', this.segments());
    }, UPDATE_THROTTLE_MS);
  }
}

export function speakerOf(channel: Channel, deepgramSpeaker: number | null): SpeakerId {
  if (channel === 'me') return 'me';
  return deepgramSpeaker === null ? 'them' : `them:${deepgramSpeaker}`;
}

export function channelOf(speaker: SpeakerId): Channel {
  return speaker === 'me' ? 'me' : 'them';
}

/** Interview labels: the mic is the candidate, everything else the interviewer. */
export function defaultLabel(speaker: SpeakerId): string {
  return speaker === 'me' ? 'ME' : 'INTERVIEWER';
}

/** Kept for the interview-mode prompts and the markdown export. */
export const label = defaultLabel;
