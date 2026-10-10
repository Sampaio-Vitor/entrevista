import fs from 'node:fs';
import path from 'node:path';
import type { Segment } from './transcript';
import { label } from './transcript';

/**
 * One interview = one session file. Começar opens a new one, Parar closes it.
 * Saved as sessions/<id>.json (source of truth, written every couple of
 * seconds while live) plus sessions/<id>.md (readable export written at end).
 */
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

export interface StoredSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  briefing: string;
  segments: Segment[];
  answers: StoredAnswer[];
}

export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  answers: number;
  segments: number;
  title: string;
}

const SAVE_DEBOUNCE_MS = 2000;

export class SessionStore {
  private current: StoredSession | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  isActive(): boolean {
    return this.current !== null;
  }

  currentId(): string | null {
    return this.current?.id ?? null;
  }

  begin(briefing: string): StoredSession {
    if (this.current) this.end();
    const startedAt = Date.now();
    const id = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.current = { id, startedAt, endedAt: null, briefing, segments: [], answers: [] };
    this.write(this.current);
    return this.current;
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

  /** Close the live session. Empty sessions (no speech, no answers) are dropped. */
  end(): StoredSession | null {
    const s = this.current;
    if (!s) return null;
    this.current = null;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    s.endedAt = Date.now();
    s.segments = s.segments.filter((seg) => seg.text.trim()).map((seg) => ({ ...seg, final: true }));
    if (s.segments.length === 0 && s.answers.length === 0) {
      try { fs.rmSync(this.jsonPath(s.id), { force: true }); } catch { /* ignore */ }
      return null;
    }
    this.write(s);
    this.writeMarkdown(s);
    return s;
  }

  list(): SessionSummary[] {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out: SessionSummary[] = [];
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as StoredSession;
        if (this.current && s.id === this.current.id) continue; // live one is not history yet
        out.push(summarize(s));
      } catch { /* skip broken file */ }
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out.slice(0, 100);
  }

  load(id: string): StoredSession | null {
    try {
      return JSON.parse(fs.readFileSync(this.jsonPath(safeId(id)), 'utf8')) as StoredSession;
    } catch {
      return null;
    }
  }

  remove(id: string): boolean {
    const sid = safeId(id);
    if (this.current && this.current.id === sid) return false;
    let ok = false;
    for (const p of [this.jsonPath(sid), this.mdPath(sid)]) {
      try { if (fs.existsSync(p)) { fs.rmSync(p); ok = true; } } catch { /* ignore */ }
    }
    return ok;
  }

  mdPath(id: string): string {
    return path.join(this.dir, `${safeId(id)}.md`);
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
    try {
      fs.writeFileSync(this.jsonPath(s.id), JSON.stringify(s));
    } catch (err) {
      console.error('[sessions] write failed', err);
    }
  }

  private writeMarkdown(s: StoredSession): void {
    const when = new Date(s.startedAt);
    const minutes = s.endedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : 0;
    const lines: string[] = [];
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
      const t = new Date(seg.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      lines.push(`**[${t}] ${label(seg.speaker)}:** ${seg.text}`);
      lines.push('');
    }
    if (s.answers.length) {
      lines.push('## Respostas do Claude');
      lines.push('');
      for (const a of s.answers) {
        const t = new Date(a.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const head = a.kind === 'code' ? 'Código' : 'Resposta';
        const timing = a.ttftMs != null ? ` (${(a.ttftMs / 1000).toFixed(1)}s até a primeira palavra${a.ms != null ? `, ${(a.ms / 1000).toFixed(1)}s total` : ''})` : '';
        lines.push(`### ${head} às ${t}${timing}`);
        lines.push('');
        if (a.shotFile) lines.push(`Screenshot: ${a.shotFile}`), lines.push('');
        lines.push(a.status === 'error' ? `Erro: ${a.error ?? ''}\n\n${a.text}` : a.text);
        lines.push('');
      }
    }
    try {
      fs.writeFileSync(this.mdPath(s.id), lines.join('\n'));
    } catch (err) {
      console.error('[sessions] markdown export failed', err);
    }
  }
}

function summarize(s: StoredSession): SessionSummary {
  const firstThem = s.segments.find((seg) => seg.speaker === 'them' && seg.text.trim());
  const first = firstThem ?? s.segments.find((seg) => seg.text.trim());
  const title = first ? first.text.trim().slice(0, 90) + (first.text.length > 90 ? '…' : '') : '(sem fala registrada)';
  const end = s.endedAt ?? s.startedAt;
  return {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationMs: Math.max(0, end - s.startedAt),
    answers: s.answers.length,
    segments: s.segments.length,
    title,
  };
}

function safeId(id: string): string {
  return String(id).replace(/[^0-9A-Za-z_-]/g, '');
}
