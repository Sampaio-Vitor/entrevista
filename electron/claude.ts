import { EventEmitter } from 'node:events';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A long-lived `claude -p` process in streaming-input mode. One process is
 * one conversation: every ask() is a new user turn in the same session, so
 * the model keeps the whole interview in context and we skip the 0.6-1.3 s
 * CLI start-up on every request. Tools are disabled; the only output is text,
 * streamed as deltas.
 *
 * Nothing is sent to the API until ask() is called.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string } };

export interface ClaudeSessionOptions {
  label: string;
  /** Alias (`sonnet`, `opus`) or full model id. */
  model: string;
  /** Opus only; silently runs at standard speed when the account lacks usage credits. */
  fastMode: boolean;
  effort: string;
  systemPrompt: string;
  cwd: string;
  requestTimeoutMs?: number;
}

export interface AskMeta {
  kind: 'answer' | 'code' | 'setup';
  [key: string]: unknown;
}

export interface DoneEvent {
  id: string;
  meta: AskMeta;
  text: string;
  ms: number;
  ttftMs: number | null;
  apiMs: number | null;
  costUsd: number | null;
  model: string | null;
  /** `fast` or `standard` as reported by the API for this turn. */
  speed: string | null;
}

interface Inflight {
  id: string;
  meta: AskMeta;
  text: string;
  sentAt: number;
  firstDeltaAt: number | null;
  timer: NodeJS.Timeout;
}

interface Pending {
  id: string;
  meta: AskMeta;
  build: () => ContentBlock[];
}

const DEFAULT_TIMEOUT_MS = 90_000;

export class ClaudeSession extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private inflight: Inflight | null = null;
  private pending: Pending | null = null;
  private turns = 0;
  private lastSpeed: string | null = null;
  private lastModel: string | null = null;
  private disposed = false;
  private static binaryPath: string | null = null;

  constructor(private readonly opts: ClaudeSessionOptions) {
    super();
  }

  get label(): string { return this.opts.label; }
  get busy(): boolean { return this.inflight !== null; }
  /** No turn has been sent on the current process yet. */
  get fresh(): boolean { return this.turns === 0; }
  get speed(): string | null { return this.lastSpeed; }
  get model(): string | null { return this.lastModel; }
  get config(): Pick<ClaudeSessionOptions, 'model' | 'fastMode' | 'effort'> {
    return { model: this.opts.model, fastMode: this.opts.fastMode, effort: this.opts.effort };
  }

  /** Locate the `claude` binary even when launched from Finder with a bare PATH. */
  static resolveBinary(): string {
    if (ClaudeSession.binaryPath) return ClaudeSession.binaryPath;
    const candidates = [
      process.env.CLAUDE_BIN,
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ].filter(Boolean) as string[];
    try {
      const found = execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();
      if (found) candidates.unshift(found);
    } catch { /* fall through to the fixed candidates */ }
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        ClaudeSession.binaryPath = c;
        return c;
      }
    }
    throw new Error('claude binary not found. Install Claude Code or set CLAUDE_BIN.');
  }

  /** Spawn the process ahead of time so the first ask() skips CLI start-up. */
  warm(): void {
    if (this.disposed || this.proc) return;
    this.spawnProcess();
  }

  /**
   * Queue a turn. `build` runs at send time, so a request that waits behind
   * another one sees the transcript as it is when it is actually sent.
   * While a turn is in flight, only the newest pending request is kept.
   */
  ask(build: () => ContentBlock[], meta: AskMeta): string {
    const id = `${this.opts.label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    if (this.inflight) {
      if (this.pending) this.emit('dropped', { id: this.pending.id, meta: this.pending.meta });
      this.pending = { id, meta, build };
      this.emit('queued', { id, meta });
      return id;
    }
    this.send({ id, meta, build });
    return id;
  }

  /** Kill the conversation and start a fresh one (same system prompt). */
  reset(): void {
    this.killProcess('reset');
    this.emit('reset');
    if (!this.disposed) this.warm();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.killProcess('dispose');
  }

  private send(req: Pending): void {
    this.warm();
    if (!this.proc) {
      this.emit('error', { id: req.id, meta: req.meta, message: 'claude process unavailable' });
      return;
    }
    let content: ContentBlock[];
    try {
      content = req.build();
    } catch (err: any) {
      this.emit('error', { id: req.id, meta: req.meta, message: err?.message ?? String(err) });
      return;
    }
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inflight = {
      id: req.id,
      meta: req.meta,
      text: '',
      sentAt: Date.now(),
      firstDeltaAt: null,
      timer: setTimeout(() => this.onTimeout(), timeoutMs),
    };
    this.emit('start', { id: req.id, meta: req.meta });
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
    this.proc.stdin.write(line, (err) => {
      if (err) this.failInflight(`stdin write failed: ${err.message}`);
    });
  }

  private spawnProcess(): void {
    const o = this.opts;
    const args = [
      '-p',
      '--model', o.model,
      '--effort', o.effort,
      '--tools', '',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--setting-sources', '',
      '--system-prompt', o.systemPrompt,
    ];
    if (o.fastMode) args.push('--settings', JSON.stringify({ fastMode: true }));

    const env: NodeJS.ProcessEnv = { ...process.env };
    // A nested Claude Code marker makes the child refuse to start.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
    env.PATH = [...extraPath, env.PATH ?? ''].join(':');

    const bin = ClaudeSession.resolveBinary();
    const proc = spawn(bin, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.turns = 0;
    this.buf = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        this.handleEvent(j);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) this.emit('stderr', text);
    });
    proc.on('error', (err) => {
      this.emit('stderr', `spawn error: ${err.message}`);
      if (this.proc === proc) this.proc = null;
      this.failInflight(`claude failed to start: ${err.message}`);
    });
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null;
      if (this.inflight) this.failInflight(`claude exited (${code ?? signal})`);
      this.emit('exit', { code, signal });
    });
    this.emit('spawn');
  }

  private handleEvent(j: any): void {
    switch (j.type) {
      case 'system': {
        if (j.subtype === 'notification') {
          const text = typeof j.message === 'string' ? j.message : j.text ?? JSON.stringify(j);
          this.emit('notification', text);
        }
        break;
      }
      case 'stream_event': {
        const ev = j.event;
        if (!this.inflight || !ev) break;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          if (this.inflight.firstDeltaAt === null) this.inflight.firstDeltaAt = Date.now();
          this.inflight.text += ev.delta.text;
          this.emit('delta', { id: this.inflight.id, meta: this.inflight.meta, text: ev.delta.text, full: this.inflight.text });
        }
        break;
      }
      case 'assistant': {
        // Fallback when no partial deltas arrived for some reason.
        if (this.inflight && this.inflight.text === '' && Array.isArray(j.message?.content)) {
          const text = j.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
          if (text) {
            this.inflight.text = text;
            this.emit('delta', { id: this.inflight.id, meta: this.inflight.meta, text, full: text });
          }
        }
        break;
      }
      case 'result': {
        const inflight = this.inflight;
        if (!inflight) break;
        clearTimeout(inflight.timer);
        this.inflight = null;
        this.turns++;
        this.lastSpeed = j.usage?.speed ?? null;
        const models = j.modelUsage ? Object.keys(j.modelUsage) : [];
        this.lastModel = models[0] ?? null;
        if (j.is_error) {
          const message = typeof j.result === 'string' && j.result ? j.result : (j.error ?? j.subtype ?? 'unknown error');
          this.emit('error', { id: inflight.id, meta: inflight.meta, message });
        } else {
          const done: DoneEvent = {
            id: inflight.id,
            meta: inflight.meta,
            text: inflight.text || (typeof j.result === 'string' ? j.result : ''),
            ms: Date.now() - inflight.sentAt,
            ttftMs: inflight.firstDeltaAt ? inflight.firstDeltaAt - inflight.sentAt : null,
            apiMs: typeof j.duration_api_ms === 'number' ? j.duration_api_ms : null,
            costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
            model: this.lastModel,
            speed: this.lastSpeed,
          };
          this.emit('done', done);
        }
        this.flushPending();
        break;
      }
      default:
        break;
    }
  }

  private flushPending(): void {
    const next = this.pending;
    this.pending = null;
    if (next && !this.disposed) this.send(next);
  }

  private onTimeout(): void {
    this.failInflight('timed out waiting for claude');
    this.killProcess('timeout');
    if (!this.disposed) this.warm();
    this.flushPending();
  }

  private failInflight(message: string): void {
    const inflight = this.inflight;
    if (!inflight) return;
    clearTimeout(inflight.timer);
    this.inflight = null;
    this.emit('error', { id: inflight.id, meta: inflight.meta, message, partial: inflight.text });
  }

  private killProcess(reason: string): void {
    const proc = this.proc;
    this.proc = null;
    if (this.inflight) this.failInflight(`claude session ${reason}`);
    if (!proc) return;
    try { proc.stdin.end(); } catch { /* ignore */ }
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
    this.turns = 0;
  }
}
