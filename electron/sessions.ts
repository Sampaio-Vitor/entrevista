import fs from 'node:fs';
import path from 'node:path';
import type { Segment, SpeakerId } from './transcript';
import { channelOf, defaultLabel } from './transcript';
import type { Participants } from './refine';
import type { RecordedFile } from './recorder';

/**
 * One interview or meeting = one session file. Começar opens a new one,
 * Parar closes it. Saved as sessions/<id>.json (source of truth, written
 * every couple of seconds while live) plus sessions/<id>.md (readable export
 * rewritten whenever the stored session changes). Meeting audio lives next to
 * them as sessions/<id>-me.wav and sessions/<id>-them.wav.
 */
export type SessionKind = 'interview' | 'meeting';

export interface StoredAnswer {
  id: string;
  kind: 'answer' | 'code';
  at: number;
  text: string;
  status: 'done' | 'error';
  ms?: number | null;
  ttftMs?: number | null;
  model?: string | null;
  error?: string;
  shotFile?: string | null;
  /** Filled only when loading for the viewer (small data URL). */
  thumb?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  status?: 'done' | 'error';
}

export interface Summary {
  text: string;
  at: number;
  model: string | null;
}

export type RefineState = 'none' | 'pending' | 'done' | 'error';

export interface StoredSession {
  id: string;
  kind: SessionKind;
  startedAt: number;
  endedAt: number | null;
  /** Interview: the copilot briefing. Meeting: free-text context for the summary and chat. */
  briefing: string;
  /** Deepgram language used live; the offline pass reuses it. */
  language: string;
  segments: Segment[];
  answers: StoredAnswer[];
  participants: Participants;
  summary: Summary | null;
  chat: ChatMessage[];
  audio: RecordedFile[];
  refined: RefineState;
  refineError?: string;
  /** Live transcript kept after the offline pass replaced `segments`. */
  liveSegments?: Segment[];
}

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  answers: number;
  segments: number;
  title: string;
  participants: string[];
  hasSummary: boolean;
  refined: RefineState;
}

export interface SearchHit extends SessionSummary {
  matches: Array<{ speaker: string; text: string; at: number }>;
}

export interface Person {
  name: string;
  meetings: number;
  utterances: number;
  lastAt: number;
  sessionIds: string[];
}

const SAVE_DEBOUNCE_MS = 2000;
const MAX_MATCHES = 6;

export class SessionStore {
  private current: StoredSession | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private cache = new Map<string, { mtimeMs: number; session: StoredSession }>();

  constructor(private readonly dir: string, private readonly myName: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  isActive(): boolean {
    return this.current !== null;
  }

  currentId(): string | null {
    return this.current?.id ?? null;
  }

  currentSession(): StoredSession | null {
    return this.current;
  }

  begin(kind: SessionKind, briefing: string, language: string): StoredSession {
    if (this.current) this.end();
    const startedAt = Date.now();
    const id = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.current = {
      id, kind, startedAt, endedAt: null, briefing, language,
      segments: [], answers: [], participants: {}, summary: null, chat: [], audio: [], refined: 'none',
    };
    this.write(this.current);
    return this.current;
  }

  audioPath(id: string, channel: 'me' | 'them'): string {
    return path.join(this.dir, `${safeId(id)}-${channel}.wav`);
  }

  recordTranscript(segments: Segment[]): void {
    if (!this.current) return;
    this.current.segments = segments;
    this.scheduleSave();
  }

  recordAnswer(answer: StoredAnswer): void {
    if (!this.current) return;
    this.current.answers.push(answer);
    this.scheduleSave();
  }

  /** Append or update a chat message on the live session. */
  recordChat(msg: ChatMessage): void {
    if (!this.current) return;
    upsertChat(this.current, msg);
    this.scheduleSave();
  }

  /** Name a speaker on the live session or a stored one. Empty name removes it. */
  setParticipant(id: string, speaker: SpeakerId, name: string): StoredSession | null {
    const s = this.current && this.current.id === safeId(id) ? this.current : this.load(id);
    if (!s) return null;
    const clean = name.trim();
    const before = this.names(s);
    if (clean) s.participants[speaker] = { name: clean };
    else delete s.participants[speaker];
    // The summary was written with the old labels: carry the rename into it.
    const after = this.names(s);
    if (s.summary) {
      for (const id of Object.keys(after)) {
        if (before[id] && before[id] !== after[id]) s.summary.text = s.summary.text.split(before[id]).join(after[id]);
      }
    }
    this.persist(s);
    return s;
  }

  /** Patch a stored (not live) session and rewrite its files. */
  update(id: string, patch: Partial<Pick<StoredSession, 'segments' | 'participants' | 'summary' | 'chat' | 'audio' | 'refined' | 'refineError' | 'liveSegments' | 'briefing'>>): StoredSession | null {
    const s = this.load(id);
    if (!s) return null;
    Object.assign(s, patch);
    this.persist(s);
    return s;
  }

  appendChat(id: string, msg: ChatMessage): StoredSession | null {
    const s = this.current && this.current.id === safeId(id) ? this.current : this.load(id);
    if (!s) return null;
    upsertChat(s, msg);
    this.persist(s);
    return s;
  }

  /** Close the live session. Empty sessions (no speech, no answers) are dropped. */
  end(audio: RecordedFile[] = []): StoredSession | null {
    const s = this.current;
    if (!s) return null;
    this.current = null;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    s.endedAt = Date.now();
    s.audio = audio;
    s.segments = s.segments.filter((seg) => seg.text.trim()).map((seg) => ({ ...seg, final: true }));
    if (s.segments.length === 0 && s.answers.length === 0) {
      try { fs.rmSync(this.jsonPath(s.id), { force: true }); } catch { /* ignore */ }
      for (const f of audio) { try { fs.rmSync(f.path, { force: true }); } catch { /* ignore */ } }
      return null;
    }
    this.write(s);
    this.writeMarkdown(s);
    return s;
  }

  list(): SessionSummary[] {
    return this.all().map((s) => this.summarize(s)).slice(0, 200);
  }

  load(id: string): StoredSession | null {
    const file = this.jsonPath(safeId(id));
    try {
      const st = fs.statSync(file);
      const hit = this.cache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) return clone(hit.session);
      const session = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
      this.cache.set(file, { mtimeMs: st.mtimeMs, session });
      return clone(session);
    } catch {
      return null;
    }
  }

  remove(id: string): boolean {
    const sid = safeId(id);
    if (this.current && this.current.id === sid) return false;
    let ok = false;
    const files = [this.jsonPath(sid), this.mdPath(sid), this.audioPath(sid, 'me'), this.audioPath(sid, 'them')];
    for (const p of files) {
      try { if (fs.existsSync(p)) { fs.rmSync(p); ok = true; } } catch { /* ignore */ }
    }
    this.cache.delete(this.jsonPath(sid));
    return ok;
  }

  mdPath(id: string): string {
    return path.join(this.dir, `${safeId(id)}.md`);
  }

  /** Display names for every speaker of a session. */
  names(s: StoredSession): Record<SpeakerId, string> {
    return speakerNames(s, this.myName);
  }

  /** Full-text search over stored sessions, optionally limited to one person's speech. */
  search(query: string, person: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    const who = person.trim().toLowerCase();
    const out: SearchHit[] = [];
    for (const s of this.all()) {
      const names = this.names(s);
      const participantIds = Object.keys(names);
      if (who) {
        const match = participantIds.some((id) => names[id].toLowerCase() === who);
        if (!match) continue;
      }
      const matches: SearchHit['matches'] = [];
      if (q || who) {
        for (const seg of s.segments) {
          const name = names[seg.speaker] ?? seg.speaker;
          if (who && name.toLowerCase() !== who) continue;
          if (q && !seg.text.toLowerCase().includes(q)) continue;
          matches.push({ speaker: name, text: seg.text, at: seg.startedAt });
          if (matches.length >= MAX_MATCHES) break;
        }
        const inSummary = q && s.summary?.text.toLowerCase().includes(q);
        const inContext = q && s.briefing.toLowerCase().includes(q);
        if (!matches.length && !inSummary && !inContext) continue;
      }
      out.push({ ...this.summarize(s), matches });
    }
    return out;
  }

  /** Everyone named in any session, except the microphone side. */
  people(): Person[] {
    const byName = new Map<string, Person>();
    for (const s of this.all()) {
      const names = this.names(s);
      const seen = new Set<string>();
      for (const seg of s.segments) {
        if (seg.speaker === 'me') continue;
        if (!s.participants[seg.speaker]) continue; // unnamed voices are not people yet
        const name = names[seg.speaker];
        let p = byName.get(name.toLowerCase());
        if (!p) { p = { name, meetings: 0, utterances: 0, lastAt: 0, sessionIds: [] }; byName.set(name.toLowerCase(), p); }
        p.utterances++;
        if (!seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          p.meetings++;
          p.sessionIds.push(s.id);
          p.lastAt = Math.max(p.lastAt, s.startedAt);
        }
      }
    }
    return [...byName.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  private all(): StoredSession[] {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out: StoredSession[] = [];
    for (const f of files) {
      const id = f.slice(0, -5);
      if (this.current && id === this.current.id) continue; // live one is not history yet
      const s = this.load(id);
      if (s) out.push(s);
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  }

  private persist(s: StoredSession): void {
    if (this.current && this.current.id === s.id) {
      this.scheduleSave();
      return;
    }
    this.write(s);
    this.writeMarkdown(s);
  }

  private jsonPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.current) this.write(this.current);
    }, SAVE_DEBOUNCE_MS);
  }

  private write(s: StoredSession): void {
    const file = this.jsonPath(s.id);
    try {
      fs.writeFileSync(file, JSON.stringify(s));
      const st = fs.statSync(file);
      this.cache.set(file, { mtimeMs: st.mtimeMs, session: clone(s) });
    } catch (err) {
      console.error('[sessions] write failed', err);
    }
  }

  private summarize(s: StoredSession): SessionSummary {
    const names = this.names(s);
    const firstThem = s.segments.find((seg) => seg.channel === 'them' && seg.text.trim());
    const first = firstThem ?? s.segments.find((seg) => seg.text.trim());
    const fromSpeech = first ? first.text.trim().slice(0, 90) + (first.text.length > 90 ? '…' : '') : '(sem fala registrada)';
    const title = s.kind === 'meeting' && s.briefing.trim()
      ? s.briefing.trim().split('\n')[0].slice(0, 90)
      : fromSpeech;
    const end = s.endedAt ?? s.startedAt;
    return {
      id: s.id,
      kind: s.kind,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: Math.max(0, end - s.startedAt),
      answers: s.answers.length,
      segments: s.segments.length,
      title,
      participants: Object.keys(names).filter((id) => id !== 'me').map((id) => names[id]),
      hasSummary: Boolean(s.summary),
      refined: s.refined,
    };
  }

  private writeMarkdown(s: StoredSession): void {
    const when = new Date(s.startedAt);
    const minutes = s.endedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : 0;
    const names = this.names(s);
    const lines: string[] = [];
    const time = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (s.kind === 'meeting') {
      lines.push(`# Reunião ${when.toLocaleString('pt-BR')}`);
      lines.push('');
      lines.push(`Duração: ${minutes} min · ${s.segments.length} falas${s.refined === 'done' ? ' · transcrição refinada' : ''}`);
      lines.push('');
      if (s.briefing.trim()) {
        lines.push('## Contexto');
        lines.push('');
        lines.push(s.briefing.trim());
        lines.push('');
      }
      const others = Object.keys(names).filter((id) => id !== 'me');
      if (others.length) {
        lines.push('## Participantes');
        lines.push('');
        lines.push(`- ${names.me ?? this.myName} (eu)`);
        for (const id of others) lines.push(`- ${names[id]}`);
        lines.push('');
      }
      if (s.summary) {
        lines.push('## Resumo');
        lines.push('');
        // The summary carries its own "## " sections; nest them under this one.
        lines.push(s.summary.text.trim().replace(/^##\s+/gm, '### '));
        lines.push('');
      }
      lines.push('## Transcrição');
      lines.push('');
      for (const seg of s.segments) {
        lines.push(`**[${time(seg.startedAt)}] ${names[seg.speaker] ?? seg.speaker}:** ${seg.text}`);
        lines.push('');
      }
      if (s.audio.length) {
        lines.push('## Áudio');
        lines.push('');
        for (const f of s.audio) lines.push(`- ${f.channel === 'me' ? 'microfone' : 'sistema'}: ${path.basename(f.path)}`);
        lines.push('');
      }
    } else {
      lines.push(`# Entrevista ${when.toLocaleString('pt-BR')}`);
      lines.push('');
      lines.push(`Duração: ${minutes} min · ${s.segments.length} falas · ${s.answers.length} respostas`);
      lines.push('');
      if (s.briefing.trim()) {
        lines.push('## Briefing');
        lines.push('');
        lines.push(s.briefing.trim());
        lines.push('');
      }
      lines.push('## Transcrição');
      lines.push('');
      for (const seg of s.segments) {
        lines.push(`**[${time(seg.startedAt)}] ${defaultLabel(seg.speaker)}:** ${seg.text}`);
        lines.push('');
      }
      if (s.answers.length) {
        lines.push('## Respostas do Claude');
        lines.push('');
        for (const a of s.answers) {
          const head = a.kind === 'code' ? 'Código' : 'Resposta';
          const timing = a.ttftMs != null ? ` (${(a.ttftMs / 1000).toFixed(1)}s até a primeira palavra${a.ms != null ? `, ${(a.ms / 1000).toFixed(1)}s total` : ''})` : '';
          lines.push(`### ${head} às ${time(a.at)}${timing}`);
          lines.push('');
          if (a.shotFile) lines.push(`Screenshot: ${a.shotFile}`), lines.push('');
          lines.push(a.status === 'error' ? `Erro: ${a.error ?? ''}\n\n${a.text}` : a.text);
          lines.push('');
        }
      }
    }
    try {
      fs.writeFileSync(this.mdPath(s.id), lines.join('\n'));
    } catch (err) {
      console.error('[sessions] markdown export failed', err);
    }
  }
}

/**
 * Display names: the mic is `myName`, named voices use their name, the rest
 * are numbered in order of first appearance ("Participante 1", ...).
 */
export function speakerNames(s: Pick<StoredSession, 'segments' | 'participants' | 'kind'>, myName: string): Record<SpeakerId, string> {
  const out: Record<SpeakerId, string> = {};
  const order: SpeakerId[] = [];
  for (const seg of s.segments) if (!order.includes(seg.speaker)) order.push(seg.speaker);
  for (const id of Object.keys(s.participants)) if (!order.includes(id)) order.push(id);
  let n = 0;
  for (const id of order) {
    const named = s.participants[id]?.name?.trim();
    if (id === 'me') out.me = named || (s.kind === 'meeting' ? myName : 'ME');
    else if (named) out[id] = named;
    else if (id === 'them') out[id] = s.kind === 'meeting' ? 'Outros' : 'INTERVIEWER';
    else out[id] = `Participante ${++n}`;
  }
  if (!out.me) out.me = s.kind === 'meeting' ? myName : 'ME';
  return out;
}

function upsertChat(s: StoredSession, msg: ChatMessage): void {
  const i = s.chat.findIndex((m) => m.id === msg.id);
  if (i >= 0) s.chat[i] = msg;
  else s.chat.push(msg);
}

/** Older files predate kinds, channels and participants. */
function normalize(raw: any): StoredSession {
  const segments: Segment[] = Array.isArray(raw.segments)
    ? raw.segments.map((seg: any) => ({ ...seg, channel: seg.channel ?? channelOf(String(seg.speaker ?? 'them')) }))
    : [];
  return {
    id: String(raw.id),
    kind: raw.kind === 'meeting' ? 'meeting' : 'interview',
    startedAt: Number(raw.startedAt) || 0,
    endedAt: raw.endedAt == null ? null : Number(raw.endedAt),
    briefing: String(raw.briefing ?? ''),
    language: String(raw.language ?? 'multi'),
    segments,
    answers: Array.isArray(raw.answers) ? raw.answers : [],
    participants: raw.participants && typeof raw.participants === 'object' ? raw.participants : {},
    summary: raw.summary && typeof raw.summary.text === 'string' ? raw.summary : null,
    chat: Array.isArray(raw.chat) ? raw.chat : [],
    audio: Array.isArray(raw.audio) ? raw.audio : [],
    refined: ['none', 'pending', 'done', 'error'].includes(raw.refined) ? raw.refined : 'none',
    refineError: typeof raw.refineError === 'string' ? raw.refineError : undefined,
    liveSegments: Array.isArray(raw.liveSegments) ? raw.liveSegments : undefined,
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function safeId(id: string): string {
  return String(id).replace(/[^0-9A-Za-z_-]/g, '');
}
