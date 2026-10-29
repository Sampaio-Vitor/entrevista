import fs from 'node:fs';
import type { Channel } from './audio';
import type { RecordedFile } from './recorder';
import type { Segment, SpeakerId } from './transcript';
import { speakerOf } from './transcript';
import { guessLang, majority, normalizeLang, type LangCounts } from './lang';

/**
 * Offline pass over the recorded WAVs with Deepgram pre-recorded. Batch
 * diarization sees the whole meeting at once, so speaker labels are stable
 * (no resets on reconnect) and the transcript is cleaner than the live one.
 */
export interface RefineOptions {
  apiKey: string;
  model: string;
  language: string;
  smartFormat: boolean;
  onProgress?: (stage: 'uploading' | 'transcribing', channel: Channel) => void;
}

export interface Participant {
  name: string;
}

export type Participants = Record<SpeakerId, Participant>;

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
  language?: string;
}

interface DgUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker?: number;
  words?: DgWord[];
}

const MAX_UTTERANCE_MS = 45_000;

export async function refineTranscript(files: RecordedFile[], opts: RefineOptions): Promise<Segment[]> {
  const all: Segment[] = [];
  let id = 1;
  for (const f of files) {
    const utterances = await transcribeFile(f, opts);
    for (const u of utterances) {
      const text = (u.transcript ?? '').trim();
      if (!text) continue;
      const startedAt = f.startedAt + Math.round(u.start * 1000);
      const updatedAt = f.startedAt + Math.round(u.end * 1000);
      const counts: LangCounts = {};
      for (const w of u.words ?? []) {
        const l = normalizeLang(w.language);
        if (l) counts[l] = (counts[l] ?? 0) + 1;
      }
      all.push({
        id: id++,
        channel: f.channel,
        speaker: speakerOf(f.channel, f.channel === 'them' && typeof u.speaker === 'number' ? u.speaker : null),
        text,
        final: true,
        startedAt,
        updatedAt,
        lang: majority(counts) ?? guessLang(text),
      });
    }
  }
  all.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  all.forEach((s, i) => { s.id = i + 1; });
  return all;
}

async function transcribeFile(f: RecordedFile, opts: RefineOptions): Promise<DgUtterance[]> {
  const params = new URLSearchParams({
    model: opts.model,
    language: opts.language,
    punctuate: 'true',
    smart_format: String(opts.smartFormat),
    utterances: 'true',
    utt_split: '1.2',
  });
  if (f.channel === 'them') params.set('diarize', 'true');
  opts.onProgress?.('uploading', f.channel);
  const body = fs.readFileSync(f.path);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Token ${opts.apiKey}`, 'Content-Type': 'audio/wav' },
    body,
  });
  opts.onProgress?.('transcribing', f.channel);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Deepgram ${res.status} (${f.channel}): ${detail.slice(0, 200)}`);
  }
  const json: any = await res.json();
  const utterances: DgUtterance[] = json?.results?.utterances ?? [];
  // A long single-speaker stretch is easier to read in a few pieces.
  const out: DgUtterance[] = [];
  for (const u of utterances) {
    if ((u.end - u.start) * 1000 <= MAX_UTTERANCE_MS || !u.words?.length) { out.push(u); continue; }
    out.push(...splitLong(u));
  }
  return out;
}

function splitLong(u: DgUtterance): DgUtterance[] {
  const words = u.words ?? [];
  const parts: DgUtterance[] = [];
  let cur: DgWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    parts.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      speaker: u.speaker,
      transcript: cur.map((w) => w.punctuated_word ?? w.word).join(' '),
      words: cur,
    });
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    const span = (w.end - cur[0].start) * 1000;
    const sentenceEnd = /[.!?]$/.test(w.punctuated_word ?? '');
    if (span >= MAX_UTTERANCE_MS * 0.6 && sentenceEnd) flush();
    else if (span >= MAX_UTTERANCE_MS) flush();
  }
  flush();
  return parts;
}

/**
 * Names given during the meeting refer to live speaker ids; the offline pass
 * numbers speakers differently. Carry each name over to the refined speaker
 * whose speech overlaps that live speaker the most.
 */
export function remapParticipants(live: Segment[], refined: Segment[], names: Participants): Participants {
  const out: Participants = {};
  if (names.me) out.me = names.me;
  const liveThem = live.filter((s) => s.channel === 'them' && s.final && s.text.trim());
  const refinedIds = new Set(refined.filter((s) => s.channel === 'them').map((s) => s.speaker));
  const pairs: Array<{ liveId: SpeakerId; refinedId: SpeakerId; overlap: number }> = [];
  for (const refinedId of refinedIds) {
    const segs = refined.filter((s) => s.speaker === refinedId);
    const byLive = new Map<SpeakerId, number>();
    for (const r of segs) {
      for (const l of liveThem) {
        const o = Math.min(r.updatedAt, l.updatedAt) - Math.max(r.startedAt, l.startedAt);
        if (o > 0) byLive.set(l.speaker, (byLive.get(l.speaker) ?? 0) + o);
      }
    }
    for (const [liveId, overlap] of byLive) pairs.push({ liveId, refinedId, overlap });
  }
  pairs.sort((a, b) => b.overlap - a.overlap);
  const usedLive = new Set<SpeakerId>();
  const usedRefined = new Set<SpeakerId>();
  for (const p of pairs) {
    if (usedLive.has(p.liveId) || usedRefined.has(p.refinedId)) continue;
    const name = names[p.liveId]?.name?.trim();
    usedLive.add(p.liveId);
    usedRefined.add(p.refinedId);
    if (name) out[p.refinedId] = { name };
  }
  return out;
}
