import { app, BrowserWindow, globalShortcut, ipcMain, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnv, loadProfile, profileSavedAt, saveConfigPatch, saveProfile, type AppConfig, type ModelConfig } from './config';
import { AudioEngine, type Channel, type ChannelStatus } from './audio';
import { DeepgramStream } from './stt/deepgram';
import { Transcript, defaultLabel, type Segment, type SpeakerId } from './transcript';
import { initialLang, majority, type Lang, type LangCounts } from './lang';
import { ClaudeSession, type DoneEvent } from './claude';
import { captureScreen } from './screenshot';
import { AudioDefaults } from './audioDefaults';
import { HfpGuard, type HfpState } from './hfpGuard';
import { SessionStore, speakerNames, type ChatMessage, type SessionEvent, type SessionKind, type StoredSession } from './sessions';
import { CalendarReader, guestNames } from './calendar';
import { Recorder } from './recorder';
import { refineTranscript, remapParticipants } from './refine';
import * as prompts from './prompts';
import { nativeImage } from 'electron';

// dist/main.js -> project root
const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'ui');
const NATIVE_DIR = path.join(ROOT, 'native');
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const SESSIONS_DIR = path.join(ROOT, 'sessions');

type Phase = 'setup' | 'live';

const config: AppConfig = loadConfig(ROOT);
// `entrevista --dev`: keep the window visible to screenshots and screen sharing.
const devMode = process.argv.includes('--dev') || process.env.ENTREVISTA_DEV === '1';
if (devMode) config.window.hideFromScreenCapture = false;
const env = loadEnv(ROOT);
const deepgramKey = env.DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || '';

let win: BrowserWindow | null = null;
let phase: Phase = 'setup';
let mode: SessionKind = 'meeting';
let startedAt: number | null = null;
// Deepgram language of the live session (meetings pick it per session).
let sessionLanguage: string = config.stt.language;

const audio = new AudioEngine(NATIVE_DIR);
const audioDefaults = new AudioDefaults(NATIVE_DIR);
const calendar = new CalendarReader(NATIVE_DIR);
const hfpGuard = new HfpGuard(audioDefaults, config.audio.forceBuiltInMicWhenBluetooth);
const transcript = new Transcript();
const sessions = new SessionStore(SESSIONS_DIR, config.meeting.myName);
const recorder = new Recorder();
const stt: Partial<Record<Channel, DeepgramStream>> = {};
const sttOpen: Record<Channel, boolean> = { me: false, them: false };
const channelStatus: Record<Channel, ChannelStatus> = {
  me: { channel: 'me', state: 'idle' },
  them: { channel: 'them', state: 'idle' },
};

// Interview copilot
let answerSession: ClaudeSession | null = null;
let codeSession: ClaudeSession | null = null;
let setupSession: ClaudeSession | null = null;
let answerSinceId = 0;
let codeSinceId = 0;
let codeAsks = 0;
// Meeting assistant: one chat for the live meeting, one for whichever past
// meeting is open in the viewer, one-shot summaries.
let liveChat: ClaudeSession | null = null;
let liveChatSinceId = 0;
let viewerChat: { sessionId: string; session: ClaudeSession; sent: boolean } | null = null;
const summaryJobs = new Map<string, ClaudeSession>();
type JobStage = 'uploading' | 'transcribing' | 'summarizing' | 'done' | 'error';
const jobs = new Map<string, { stage: JobStage; error?: string }>();

// Language Claude answers in. Follows my last closed utterance; until I have
// spoken, the interviewer's. The flag button overrides it until I speak again.
let answerLang: Lang = initialLang(config.stt.language);
let heardMyLang = false;
let lastToastAt = new Map<string, number>();
// Set once the live session's system channel carries sound (see the level handler).
let systemAudioHeard = false;

app.setName('Entrevista');

// ---------- helpers ----------

function send(channel: string, data: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function toast(level: 'info' | 'warn' | 'error', message: string, throttleKey?: string): void {
  if (throttleKey) {
    const last = lastToastAt.get(throttleKey) ?? 0;
    if (Date.now() - last < 8000) return;
    lastToastAt.set(throttleKey, Date.now());
  }
  console.log(`[toast:${level}] ${message}`);
  send('toast', { level, message });
}

function currentStatus() {
  return {
    phase,
    mode,
    startedAt,
    running: audio.isRunning(),
    recording: recorder.active,
    audio: channelStatus,
    micRouting: audio.microphoneRouting(),
    hfp: hfpGuard.current(),
    stt: { ...sttOpen, enabled: Boolean(deepgramKey) },
    lang: answerLang,
    claude: {
      answer: answerSession ? { ...answerSession.config, speed: answerSession.speed, model: answerSession.model, busy: answerSession.busy } : null,
      code: codeSession ? { ...codeSession.config, speed: codeSession.speed, model: codeSession.model, busy: codeSession.busy } : null,
      chat: liveChat ? { ...liveChat.config, speed: liveChat.speed, model: liveChat.model, busy: liveChat.busy } : null,
    },
  };
}

function pushStatus(): void {
  send('status', currentStatus());
}

function boundsFile(): string {
  return path.join(app.getPath('userData'), 'window.json');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Names for the live transcript (meeting) or the fixed interview labels. */
function liveNames(): Record<SpeakerId, string> {
  const s = sessions.currentSession();
  return speakerNames({ segments: transcript.segments(), participants: s?.participants ?? {}, kind: mode }, config.meeting.myName);
}

function pushTranscript(segments: Segment[]): void {
  send('transcript', { segments: segments.slice(-400), names: liveNames() });
}

function pushParticipants(s: StoredSession | null): void {
  if (!s) return;
  const live = sessions.currentId() === s.id;
  send('participants', {
    sessionId: s.id,
    live,
    participants: s.participants,
    names: live ? liveNames() : sessions.names(s),
  });
}

function setJob(id: string, stage: JobStage, error?: string): void {
  if (stage === 'done') jobs.delete(id);
  else jobs.set(id, { stage, error });
  send('job', { id, stage, error: error ?? null });
}

function transcriptLang(segments: Segment[]): Lang {
  const counts: LangCounts = {};
  for (const s of segments) if (s.lang) counts[s.lang] = (counts[s.lang] ?? 0) + 1;
  return majority(counts) ?? (segments.length ? (segments[0].lang ?? 'pt') : 'pt');
}

// ---------- window ----------

// Background opacity (0.3-1). The window itself is transparent; the renderer
// paints rgba(255,255,255,alpha) so text stays solid while the white fades.
let alpha = clampAlpha(config.window.opacity);

function clampAlpha(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  return Math.min(1, Math.max(0.3, Math.round(n * 20) / 20));
}

function persistWindowState(): void {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getBounds(), alpha })); } catch { /* ignore */ }
}

function setAlpha(v: number, announce = true): void {
  alpha = clampAlpha(v);
  send('opacity', { alpha });
  persistWindowState();
  if (announce) toast('info', `Opacidade ${Math.round(alpha * 100)}%`, undefined);
}

function applyWindowMode(): void {
  if (!win || win.isDestroyed()) return;
  const floating = phase === 'live' && mode === 'meeting' ? config.meeting.alwaysOnTop : config.window.alwaysOnTop;
  win.setAlwaysOnTop(floating, 'floating');
}

function createWindow(): void {
  let saved: Partial<Electron.Rectangle> & { alpha?: number } = {};
  try { saved = JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch { /* first run */ }
  if (typeof saved.alpha === 'number') alpha = clampAlpha(saved.alpha);

  win = new BrowserWindow({
    width: saved.width ?? config.window.width,
    height: saved.height ?? config.window.height,
    x: saved.x,
    y: saved.y,
    minWidth: 420,
    minHeight: 320,
    title: 'Entrevista',
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  applyWindowMode();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Excluded from screen recording and screen sharing (and from our own screenshots).
  win.setContentProtection(config.window.hideFromScreenCapture);

  win.loadFile(path.join(UI_DIR, 'index.html'));
  // Renderer console goes to the main-process log, so `npm start` shows UI errors.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const src = sourceId ? `${path.basename(sourceId)}:${line}` : '';
    console.log(`[renderer${level >= 2 ? ':error' : ''}] ${message} ${src}`.trim());
  });
  win.webContents.on('did-finish-load', () => console.log('[window] ui loaded'));
  // Dev aid: the window is excluded from screen capture, so `screencapture`
  // cannot see it. With this set, the page saves itself there every 2 s.
  const shotDir = process.env.ENTREVISTA_DEBUG_SHOT_DIR;
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    setInterval(async () => {
      if (!win || win.isDestroyed()) return;
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'latest.png'), img.toPNG());
      } catch { /* ignore */ }
    }, 2000);
  }

  let saveTimer: NodeJS.Timeout | null = null;
  const saveBounds = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistWindowState, 400);
  };
  win.on('move', saveBounds);
  win.on('resize', saveBounds);
  win.on('closed', () => { win = null; });
}

function toggleWindow(): void {
  if (!win) { createWindow(); return; }
  if (win.isVisible()) win.hide();
  else win.showInactive(); // do not steal focus from Zoom
}

// ---------- claude sessions ----------

type SessionLabel = 'answer' | 'code' | 'setup' | 'chat' | 'summary';

function makeSession(label: SessionLabel, mc: ModelConfig, systemPrompt: string): ClaudeSession {
  const s = new ClaudeSession({
    label,
    model: mc.model,
    fastMode: mc.fastMode,
    effort: mc.effort,
    systemPrompt,
    cwd: ROOT,
  });
  s.on('start', (e) => send('answer:start', { id: e.id, kind: e.meta.kind, meta: e.meta }));
  s.on('delta', (e) => send('answer:delta', { id: e.id, kind: e.meta.kind, text: e.text, full: e.full, meta: e.meta }));
  s.on('done', (e: DoneEvent) => {
    send('answer:done', { ...e, kind: e.meta.kind });
    if (e.meta.kind === 'answer' || e.meta.kind === 'code') {
      sessions.recordAnswer({
        id: e.id, kind: e.meta.kind, at: Number(e.meta.at) || Date.now(), text: e.text, status: 'done',
        ms: e.ms, ttftMs: e.ttftMs, model: e.model, shotFile: (e.meta.file as string | undefined) ?? null,
      });
    }
    if (e.meta.kind === 'setup') {
      const briefing = prompts.extractBriefing(e.text);
      if (briefing) send('setup:briefing', { briefing });
    }
    if (e.meta.kind === 'chat') {
      storeChat(e.meta.sessionId as string | null, { id: e.id, role: 'assistant', text: e.text, at: Date.now(), status: 'done' });
    }
    if (e.meta.kind === 'summary') {
      const id = String(e.meta.sessionId);
      const { title, text } = prompts.splitSummaryTitle(e.text);
      const updated = sessions.update(id, { summary: { text, at: Date.now(), model: e.model, ...(title ? { title } : {}) } });
      summaryJobs.get(id)?.dispose();
      summaryJobs.delete(id);
      setJob(id, 'done');
      if (updated) toast('info', 'Resumo da reunião pronto.');
    }
    if (mc.fastMode && e.speed && e.speed !== 'fast') {
      toast('warn', 'Fast mode não ativou (velocidade padrão). Ative usage credits em claude.ai > Settings > Usage.', 'fast-off');
    }
    pushStatus();
  });
  s.on('error', (e) => {
    send('answer:error', { id: e.id, kind: e.meta?.kind, message: e.message, partial: e.partial ?? '', meta: e.meta });
    if (e.meta?.kind === 'answer' || e.meta?.kind === 'code') {
      sessions.recordAnswer({
        id: e.id, kind: e.meta.kind, at: Number(e.meta.at) || Date.now(), text: e.partial ?? '', status: 'error',
        error: e.message, shotFile: (e.meta.file as string | undefined) ?? null,
      });
    }
    if (e.meta?.kind === 'chat') {
      storeChat(e.meta.sessionId as string | null, { id: e.id, role: 'assistant', text: `${e.partial ?? ''}\n\n*Erro: ${e.message}*`.trim(), at: Date.now(), status: 'error' });
    }
    if (e.meta?.kind === 'summary') {
      const id = String(e.meta.sessionId);
      summaryJobs.get(id)?.dispose();
      summaryJobs.delete(id);
      setJob(id, 'error', e.message);
      toast('error', `Resumo falhou: ${e.message}`);
    }
    pushStatus();
  });
  s.on('queued', (e) => send('answer:queued', { id: e.id, kind: e.meta.kind, meta: e.meta }));
  s.on('notification', (text: string) => toast('warn', text, 'claude-notification'));
  s.on('stderr', (text: string) => console.error(`[claude:${label}] ${text}`));
  s.on('spawn', () => {
    // A fresh process has no memory of the transcript: resend everything next time.
    if (label === 'answer') answerSinceId = 0;
    if (label === 'code') codeSinceId = 0;
    if (label === 'chat' && s === liveChat) liveChatSinceId = 0;
    if (label === 'chat' && viewerChat && s === viewerChat.session) viewerChat.sent = false;
  });
  return s;
}

function storeChat(sessionId: string | null, msg: ChatMessage): void {
  if (!sessionId || sessions.currentId() === sessionId) sessions.recordChat(msg);
  else sessions.appendChat(sessionId, msg);
}

function setAnswerLang(lang: Lang): void {
  if (lang === answerLang) return;
  answerLang = lang;
  console.log(`[lang] answers in ${lang}`);
  pushStatus();
}

function onUtteranceClosed(seg: Segment): void {
  if (!seg.lang) return;
  if (seg.speaker === 'me') {
    heardMyLang = true;
    setAnswerLang(seg.lang);
  } else if (!heardMyLang) {
    setAnswerLang(seg.lang);
  }
}

function toggleAnswerLang(): void {
  setAnswerLang(answerLang === 'en' ? 'pt' : 'en');
  toast('info', answerLang === 'pt' ? 'Respostas em português' : 'Respostas em inglês');
}

function askAnswer(): void {
  if (phase !== 'live' || !answerSession) {
    toast('warn', mode === 'meeting' && phase === 'live' ? 'Resposta instantânea é do modo entrevista. Use o chat.' : 'Inicie a sessão antes de pedir uma resposta.');
    return;
  }
  const session = answerSession;
  session.ask(() => {
    const { text, nextSinceId, hasNew } = transcript.formatSince(answerSinceId);
    const message = prompts.answerUserMessage({
      transcript: text,
      isFirstTurn: session.fresh,
      hasNew,
      transcriptEmpty: transcript.isEmpty(),
      lang: answerLang,
    });
    answerSinceId = nextSinceId;
    return [{ type: 'text', text: message }];
  }, { kind: 'answer', at: Date.now() });
}

async function askCode(): Promise<void> {
  if (phase !== 'live' || !codeSession) {
    toast('warn', mode === 'meeting' && phase === 'live' ? 'Solução de código é do modo entrevista.' : 'Inicie a sessão antes de pedir uma solução.');
    return;
  }
  const session = codeSession;
  const hideWindow = !config.window.hideFromScreenCapture && win?.isVisible();
  if (hideWindow) { win!.hide(); await sleep(150); }
  let shot;
  try {
    shot = await captureScreen(SHOTS_DIR, config.screenshot.maxWidth);
  } catch (err: any) {
    toast('error', err?.message ?? String(err));
    return;
  } finally {
    if (hideWindow) win?.showInactive();
  }
  codeAsks++;
  // Every image stays in the conversation; start over every 3 problems.
  if (codeAsks > 1 && (codeAsks - 1) % 3 === 0) session.reset();
  const { base64, mediaType, thumbDataUrl, ms, file, display } = shot;
  session.ask(() => {
    const { text, nextSinceId, hasNew } = transcript.formatSince(codeSinceId);
    const message = prompts.codeUserMessage({ transcript: text, isFirstTurn: session.fresh, hasNew, lang: answerLang });
    codeSinceId = nextSinceId;
    return [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: message },
    ];
  }, { kind: 'code', thumb: thumbDataUrl, shotMs: ms, file, display: display.label, at: Date.now() });
}

// ---------- meeting: chat, summary, offline pass ----------

function participantList(s: Pick<StoredSession, 'segments' | 'participants' | 'kind'>): string[] {
  const names = speakerNames(s, config.meeting.myName);
  return Object.keys(names).map((id) => id === 'me' ? `${names[id]} (me)` : names[id]);
}

/** Question about the live meeting (sessionId null) or a stored one. */
function askMeetingChat(sessionId: string | null, question: string): { ok: boolean; id?: string; error?: string } {
  const q = question.trim();
  if (!q) return { ok: false, error: 'empty' };
  const live = !sessionId || sessions.currentId() === sessionId;
  if (live) {
    if (phase !== 'live' || mode !== 'meeting' || !liveChat) return { ok: false, error: 'Nenhuma reunião em andamento.' };
    const session = liveChat;
    const userMsg: ChatMessage = { id: `u-${Date.now().toString(36)}`, role: 'user', text: q, at: Date.now() };
    sessions.recordChat(userMsg);
    const id = session.ask(() => {
      const { text, nextSinceId, hasNew } = transcript.formatSince(liveChatSinceId);
      liveChatSinceId = nextSinceId;
      return [{ type: 'text', text: prompts.meetingChatUserMessage({ transcript: text, isFirstTurn: session.fresh, hasNew, question: q }) }];
    }, { kind: 'chat', sessionId: null, at: Date.now() });
    return { ok: true, id };
  }
  const stored = sessions.load(sessionId!);
  if (!stored) return { ok: false, error: 'Sessão não encontrada.' };
  if (!viewerChat || viewerChat.sessionId !== stored.id) {
    viewerChat?.session.dispose();
    const sys = prompts.meetingChatSystemPrompt({ context: stored.briefing, participants: participantList(stored), live: false });
    viewerChat = { sessionId: stored.id, session: makeSession('chat', config.meeting.chat, sys), sent: false };
  }
  const vc = viewerChat;
  sessions.appendChat(stored.id, { id: `u-${Date.now().toString(36)}`, role: 'user', text: q, at: Date.now() });
  const id = vc.session.ask(() => {
    const fresh = !vc.sent;
    vc.sent = true;
    const names = sessions.names(stored);
    const text = stored.segments.map((seg) => `${names[seg.speaker] ?? seg.speaker}: ${seg.text}`).join('\n');
    return [{ type: 'text', text: prompts.meetingChatUserMessage({ transcript: fresh ? text : '', isFirstTurn: fresh, hasNew: fresh && Boolean(text), question: q }) }];
  }, { kind: 'chat', sessionId: stored.id, at: Date.now() });
  return { ok: true, id };
}

function runSummary(sessionId: string): { ok: boolean; error?: string } {
  const s = sessions.load(sessionId);
  if (!s) return { ok: false, error: 'Sessão não encontrada.' };
  if (!s.segments.length) return { ok: false, error: 'Sem transcrição para resumir.' };
  if (summaryJobs.has(s.id)) return { ok: true };
  let session: ClaudeSession;
  try {
    session = makeSession('summary', config.meeting.summary, prompts.meetingSummarySystemPrompt());
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  summaryJobs.set(s.id, session);
  setJob(s.id, 'summarizing');
  const names = sessions.names(s);
  const text = s.segments.map((seg) => `${names[seg.speaker] ?? seg.speaker}: ${seg.text}`).join('\n');
  session.ask(() => [{
    type: 'text',
    text: prompts.meetingSummaryUserMessage({ context: s.briefing, participants: participantList(s), transcript: text, lang: transcriptLang(s.segments) }),
  }], { kind: 'summary', sessionId: s.id, at: Date.now() });
  return { ok: true };
}

async function runRefine(sessionId: string): Promise<void> {
  const s = sessions.load(sessionId);
  if (!s) return;
  if (!s.audio.length) { toast('warn', 'Sem áudio gravado para refinar.'); return; }
  if (!deepgramKey) { toast('warn', 'Sem chave Deepgram: transcrição não refinada.'); return; }
  const missing = s.audio.filter((f) => !fs.existsSync(f.path));
  if (missing.length) { toast('warn', `Áudio não encontrado: ${missing.map((f) => path.basename(f.path)).join(', ')}`); return; }
  sessions.update(s.id, { refined: 'pending', refineError: undefined });
  setJob(s.id, 'uploading');
  try {
    const refined = await refineTranscript(s.audio, {
      apiKey: deepgramKey,
      model: config.stt.model,
      language: s.language || config.meeting.language,
      smartFormat: config.stt.smartFormat,
      onProgress: (stage) => setJob(s.id, stage),
    });
    if (!refined.length) throw new Error('Deepgram não retornou falas.');
    const live = s.liveSegments ?? s.segments;
    const participants = remapParticipants(live, refined, s.participants);
    const updated = sessions.update(s.id, { segments: refined, liveSegments: live, participants, refined: 'done' });
    setJob(s.id, 'done');
    pushParticipants(updated);
    toast('info', `Transcrição refinada: ${refined.length} falas.`);
    if (config.meeting.autoSummary) runSummary(s.id);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error('[refine]', message);
    sessions.update(s.id, { refined: 'error', refineError: message });
    setJob(s.id, 'error', message);
    toast('error', `Refino da transcrição falhou: ${message}`);
    if (config.meeting.autoSummary) runSummary(s.id);
  }
}

// ---------- stt ----------

function connectStt(channel: Channel): void {
  stt[channel]?.close();
  const s = new DeepgramStream({
    apiKey: deepgramKey,
    channel,
    sampleRate: audio.sampleRate(channel),
    model: config.stt.model,
    language: sessionLanguage,
    endpointingMs: config.stt.endpointingMs,
    utteranceEndMs: config.stt.utteranceEndMs,
    smartFormat: config.stt.smartFormat,
    diarize: mode === 'meeting' && config.meeting.diarize && channel === 'them',
  });
  s.on('open', () => { sttOpen[channel] = true; pushStatus(); });
  s.on('close', () => { sttOpen[channel] = false; pushStatus(); });
  s.on('error', (err: Error) => {
    console.error(`[deepgram:${channel}]`, err.message);
    toast('error', `Deepgram (${channel === 'me' ? 'mic' : 'sistema'}): ${err.message}`, `dg-${channel}`);
  });
  s.on('result', (r) => transcript.applyResult(r));
  s.on('utterance-end', (c: Channel) => transcript.closeUtterance(c));
  stt[channel] = s;
  s.connect();
}

// ---------- session lifecycle ----------

async function startSession(kind: SessionKind, briefing: string, language: string, extra: { event?: SessionEvent; job?: string } = {}): Promise<{ ok: boolean; failures: Array<{ channel: Channel; error: string }>; warnings: string[] }> {
  const warnings: string[] = [];
  if (phase === 'live') return { ok: true, failures: [], warnings };
  mode = kind;
  sessionLanguage = kind === 'meeting' ? (language.trim() || config.meeting.language) : config.stt.language;
  systemAudioHeard = false;

  setupSession?.dispose();
  setupSession = null;
  answerSession?.dispose();
  codeSession?.dispose();
  liveChat?.dispose();
  answerSession = null;
  codeSession = null;
  liveChat = null;
  viewerChat?.session.dispose();
  viewerChat = null;

  transcript.clear();
  transcript.setLabeler(kind === 'meeting' ? (spk) => liveNames()[spk] ?? spk : defaultLabel);
  const session = sessions.begin(kind, briefing, sessionLanguage, kind === 'meeting' ? { event: extra.event } : { job: extra.job }); // a new interview/meeting every Começar

  try {
    if (kind === 'interview') {
      answerSession = makeSession('answer', config.answer, prompts.answerSystemPrompt(briefing));
      codeSession = makeSession('code', config.code, prompts.codeSystemPrompt(briefing));
      answerSession.warm();
      codeSession.warm();
    } else {
      liveChat = makeSession('chat', config.meeting.chat, prompts.meetingChatSystemPrompt({ context: briefing, participants: [], live: true }));
      liveChatSinceId = 0;
      liveChat.warm();
    }
  } catch (err: any) {
    warnings.push(err?.message ?? String(err));
    toast('error', err?.message ?? String(err));
  }

  if (process.platform === 'darwin') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) warnings.push('Permissão de microfone negada.');
  }

  let failures: Array<{ channel: Channel; error: string }> = [];
  if (audio.available()) {
    const r = await audio.start();
    failures = r.failures;
    for (const f of failures) toast('error', `Áudio ${f.channel === 'me' ? 'mic' : 'sistema'}: ${f.error}`);
    if (kind === 'meeting' && config.meeting.saveAudio) {
      for (const ch of r.started) {
        try { recorder.start(ch, sessions.audioPath(session.id, ch), audio.sampleRate(ch)); } catch (err: any) {
          warnings.push(`gravação ${ch} não iniciada: ${err?.message ?? err}`);
        }
      }
    }
  } else {
    const msg = `Motor de áudio nativo indisponível: ${audio.unavailableReason()}`;
    warnings.push(msg);
    toast('error', msg);
  }

  // Bluetooth headset: keep it out of hands-free mode for the whole session.
  if (hfpGuard.available()) {
    const st = await hfpGuard.start();
    if (st.switchedInputTo) {
      toast('info', `Fone Bluetooth (${st.outputName}): microfone padrão do sistema trocado para ${st.switchedInputTo} durante a sessão, para o Zoom/Meet não derrubar o fone para modo chamada.`);
    }
    if (st.hfp && st.message) toast('warn', st.message, 'hfp');
  } else {
    warnings.push('native/audio-defaults não compilado: sem detecção de modo chamada (HFP). Rode npm install.');
  }

  if (!deepgramKey) {
    const msg = 'DEEPGRAM_API_KEY ausente no .env: transcrição desligada.';
    warnings.push(msg);
    toast('error', msg);
  } else {
    connectStt('me');
    connectStt('them');
  }

  answerSinceId = 0;
  codeSinceId = 0;
  codeAsks = 0;
  answerLang = initialLang(sessionLanguage);
  heardMyLang = false;
  phase = 'live';
  startedAt = Date.now();
  applyWindowMode();
  send('phase', { phase, mode, startedAt, sessionId: session.id });
  pushStatus();
  pushTranscript([]);
  return { ok: true, failures, warnings };
}

async function stopSession(): Promise<{ savedId: string | null }> {
  const wasMeeting = mode === 'meeting';
  phase = 'setup';
  startedAt = null;
  for (const ch of ['me', 'them'] as const) {
    stt[ch]?.close();
    delete stt[ch];
    sttOpen[ch] = false;
  }
  await audio.stop();
  const files = recorder.stop();
  await hfpGuard.stop(); // restores the previous system default input
  for (const ch of ['me', 'them'] as const) transcript.closeUtterance(ch, true);
  sessions.recordTranscript(transcript.segments());
  const saved = sessions.end(files);
  if (saved) toast('info', `Sessão salva: sessions/${saved.id}.md`);
  answerSession?.dispose();
  codeSession?.dispose();
  liveChat?.dispose();
  answerSession = null;
  codeSession = null;
  liveChat = null;
  applyWindowMode();
  send('phase', { phase, mode, startedAt, sessionId: saved?.id ?? null });
  pushStatus();
  if (saved && wasMeeting) {
    if (files.length && config.meeting.refine && deepgramKey) void runRefine(saved.id);
    else if (config.meeting.autoSummary) runSummary(saved.id);
  }
  return { savedId: saved?.id ?? null };
}

// ---------- settings ----------

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const HOTKEY_NAMES = ['answer', 'code', 'toggleWindow', 'language', 'opacityUp', 'opacityDown'] as const;
type Hotkeys = AppConfig['hotkeys'];

/** What the renderer gets: everything it shows or edits, nothing about the window. */
function publicConfig() {
  return {
    hotkeys: config.hotkeys,
    answer: config.answer,
    code: config.code,
    setup: config.setup,
    stt: config.stt,
    meeting: config.meeting,
  };
}

/** Registers every global shortcut; returns the ones another app already owns. */
function registerHotkeys(hk: Hotkeys): string[] {
  globalShortcut.unregisterAll();
  const bindings: Array<[string, () => void]> = [
    [hk.answer, askAnswer],
    [hk.code, () => { void askCode(); }],
    [hk.toggleWindow, toggleWindow],
    [hk.language, toggleAnswerLang],
    [hk.opacityUp, () => setAlpha(alpha + 0.1)],
    [hk.opacityDown, () => setAlpha(alpha - 0.1)],
  ];
  const failed: string[] = [];
  for (const [accel, fn] of bindings) {
    let ok = false;
    try { ok = globalShortcut.register(accel, fn); } catch { ok = false; }
    if (!ok) failed.push(accel);
  }
  return failed;
}

function cleanModel(raw: any): Partial<ModelConfig> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Partial<ModelConfig> = {};
  if (typeof raw.model === 'string' && /^[a-z0-9][a-z0-9.\-[\]]{0,59}$/i.test(raw.model)) out.model = raw.model;
  if (EFFORTS.includes(raw.effort)) out.effort = raw.effort;
  return Object.keys(out).length ? out : null;
}

/** Keeps only the settings the Ajustes sheet edits, with valid values. */
function cleanSettings(raw: any): Record<string, any> {
  const patch: Record<string, any> = {};
  if (!raw || typeof raw !== 'object') return patch;
  for (const key of ['answer', 'code', 'setup'] as const) {
    const m = cleanModel(raw[key]);
    if (m) patch[key] = m;
  }
  if (raw.meeting && typeof raw.meeting === 'object') {
    const meeting: Record<string, any> = {};
    for (const flag of ['diarize', 'saveAudio', 'refine', 'autoSummary'] as const) {
      if (typeof raw.meeting[flag] === 'boolean') meeting[flag] = raw.meeting[flag];
    }
    for (const key of ['summary', 'chat'] as const) {
      const m = cleanModel(raw.meeting[key]);
      if (m) meeting[key] = m;
    }
    if (Object.keys(meeting).length) patch.meeting = meeting;
  }
  if (raw.hotkeys && typeof raw.hotkeys === 'object') {
    const hotkeys: Partial<Hotkeys> = {};
    for (const name of HOTKEY_NAMES) {
      const v = raw.hotkeys[name];
      if (typeof v === 'string' && /^[\w+\-=,./;'`[\]\\]{1,60}$/.test(v) && v.includes('+')) hotkeys[name] = v;
    }
    if (Object.keys(hotkeys).length) patch.hotkeys = hotkeys;
  }
  return patch;
}

/** Ajustes: validate, register new shortcuts, write config.json, apply in memory. */
function saveSettings(raw: unknown): { ok: boolean; error?: string; config?: ReturnType<typeof publicConfig> } {
  const patch = cleanSettings(raw);
  if (!Object.keys(patch).length) return { ok: false, error: 'Ajuste inválido.' };
  const previous = config.hotkeys;
  if (patch.hotkeys) {
    const next: Hotkeys = { ...config.hotkeys, ...patch.hotkeys };
    const values = Object.values(next);
    if (new Set(values).size !== values.length) {
      registerHotkeys(previous);
      return { ok: false, error: 'Esse atalho já é de outra ação.' };
    }
    const failed = registerHotkeys(next);
    if (failed.length) {
      registerHotkeys(previous);
      return { ok: false, error: `Atalho em uso por outro app: ${failed.join(', ')}.` };
    }
  }
  let merged: AppConfig;
  try {
    merged = saveConfigPatch(ROOT, patch);
  } catch (err: any) {
    if (patch.hotkeys) registerHotkeys(previous);
    return { ok: false, error: `config.json não salvo: ${err?.message ?? err}` };
  }
  // Only the edited sections: window settings (and the --dev override) stay as they are.
  for (const key of Object.keys(patch) as Array<keyof AppConfig>) (config as any)[key] = merged[key];
  console.log(`[settings] saved ${JSON.stringify(patch)}`);
  return { ok: true, config: publicConfig() };
}

function appStateFile(): string {
  return path.join(app.getPath('userData'), 'app-state.json');
}

/** Small facts the app learns about this Mac (not settings), kept next to window.json. */
function loadAppState(): { systemAudioOkAt?: number } {
  try { return JSON.parse(fs.readFileSync(appStateFile(), 'utf8')); } catch { return {}; }
}

function saveAppState(patch: { systemAudioOkAt?: number }): void {
  try { fs.writeFileSync(appStateFile(), JSON.stringify({ ...loadAppState(), ...patch })); } catch { /* ignore */ }
}

// ---------- wiring ----------

audio.on('pcm', (channel: Channel, chunk: Buffer) => {
  stt[channel]?.send(chunk);
  recorder.write(channel, chunk);
});
audio.on('speech-ended', (channel: Channel) => stt[channel]?.finalize());
audio.on('level', (channel: Channel, rms: number) => {
  send('level', { channel, rms });
  // macOS hands the tap silence until "System Audio Recording" is allowed, so
  // any real sound on the system channel proves the permission works.
  if (channel === 'them' && phase === 'live' && !systemAudioHeard && rms > 0.002) {
    systemAudioHeard = true;
    saveAppState({ systemAudioOkAt: Date.now() });
  }
});
audio.on('status', (st: ChannelStatus) => { channelStatus[st.channel] = st; pushStatus(); });
audio.on('error', (e: { channel: Channel; error: Error }) => {
  toast('error', `Áudio ${e.channel === 'me' ? 'mic' : 'sistema'}: ${e.error.message}`, `audio-${e.channel}`);
});
transcript.on('update', (segments: Segment[]) => {
  pushTranscript(segments);
  sessions.recordTranscript(segments);
});
transcript.on('closed', onUtteranceClosed);
hfpGuard.on('change', (st: HfpState) => {
  if (st.hfp && st.message) toast('warn', st.message, 'hfp');
  pushStatus();
});

ipcMain.handle('state:get', async () => {
  let claudeBinary: string | null = null;
  try { claudeBinary = ClaudeSession.resolveBinary(); } catch { claudeBinary = null; }
  const devices = await audioDefaults.status();
  const live = sessions.currentSession();
  return {
    alpha,
    headset: devices?.output
      ? { outputName: devices.output.name, bluetooth: devices.output.transport === 'bluetooth', inputName: devices.input?.name ?? '', helper: true }
      : { outputName: '', bluetooth: false, inputName: '', helper: audioDefaults.available() },
    phase,
    mode,
    startedAt,
    sessionId: live?.id ?? null,
    config: publicConfig(),
    profile: loadProfile(ROOT),
    profileSavedAt: profileSavedAt(ROOT),
    systemAudioOkAt: loadAppState().systemAudioOkAt ?? null,
    deepgramKey: Boolean(deepgramKey),
    claudeBinary,
    native: { available: audio.available(), error: audio.unavailableReason() },
    permissions: process.platform === 'darwin'
      ? {
          microphone: systemPreferences.getMediaAccessStatus('microphone'),
          screen: systemPreferences.getMediaAccessStatus('screen'),
        }
      : { microphone: 'granted', screen: 'granted' },
    status: currentStatus(),
    segments: transcript.segments().slice(-400),
    names: liveNames(),
    participants: live?.participants ?? {},
    chat: live?.chat ?? [],
    jobs: Object.fromEntries(jobs),
  };
});

ipcMain.handle('setup:chat', (_e, payload: { text: string }) => {
  const text = (payload?.text ?? '').trim();
  if (!text) return { ok: false, error: 'empty' };
  if (!setupSession) setupSession = makeSession('setup', config.setup, prompts.setupSystemPrompt());
  const id = setupSession.ask(() => [{ type: 'text', text }], { kind: 'setup', at: Date.now() });
  return { ok: true, id };
});

ipcMain.handle('setup:reset', () => {
  setupSession?.dispose();
  setupSession = null;
  return { ok: true };
});

ipcMain.handle('session:start', (_e, payload: { mode?: SessionKind; briefing?: string; job?: string; language?: string; event?: SessionEvent }) => {
  if (payload?.mode === 'interview') {
    // The copilot gets the saved profile plus the notes for this interview.
    const job = String(payload?.job ?? '');
    return startSession('interview', prompts.interviewBriefing(loadProfile(ROOT), job), '', { job });
  }
  return startSession('meeting', String(payload?.briefing ?? ''), String(payload?.language ?? ''), { event: sessionEvent(payload?.event) });
});

ipcMain.handle('profile:save', (_e, payload: { text?: string }) => {
  try {
    saveProfile(ROOT, String(payload?.text ?? ''));
    return { ok: true, profile: loadProfile(ROOT), savedAt: profileSavedAt(ROOT) };
  } catch (err: any) {
    return { ok: false, error: `profile.md não salvo: ${err?.message ?? err}` };
  }
});

ipcMain.handle('settings:save', (_e, payload: unknown) => saveSettings(payload));
// While the settings sheet records a new shortcut, our own shortcuts must not swallow the keys.
ipcMain.handle('hotkeys:suspend', (_e, payload: { suspend?: boolean }) => {
  if (payload?.suspend) globalShortcut.unregisterAll();
  else registerHotkeys(config.hotkeys);
  return { ok: true };
});

function sessionEvent(raw: unknown): SessionEvent | undefined {
  const e = raw as Partial<SessionEvent> | undefined;
  if (!e || typeof e.title !== 'string' || typeof e.start !== 'number' || typeof e.end !== 'number') return undefined;
  return {
    title: e.title, start: e.start, end: e.end, source: String(e.source ?? ''),
    ...(typeof e.link === 'string' && /^https?:\/\//.test(e.link) ? { link: e.link } : {}),
    guests: Array.isArray(e.guests) ? e.guests.map(String) : [],
  };
}

// Upcoming meetings: events still running or ahead that have a call link or
// other guests (skips gym, lunch and other personal blocks).
ipcMain.handle('calendar:upcoming', async (_e, payload: { request?: boolean }) => {
  const snap = await calendar.fetch({ request: Boolean(payload?.request) });
  const now = Date.now();
  const events = snap.events
    .filter((e) => e.end > now && (e.link || e.attendees.some((a) => !a.me)))
    .map((e) => ({ ...e, guests: guestNames(e) }));
  if (snap.error) console.warn('[calendar]', snap.error);
  return { access: snap.access, events, fetchedAt: snap.fetchedAt };
});
ipcMain.handle('session:stop', () => stopSession());
ipcMain.handle('transcript:clear', () => { transcript.clear(); answerSinceId = 0; codeSinceId = 0; liveChatSinceId = 0; return { ok: true }; });
ipcMain.handle('answer:ask', () => { askAnswer(); return { ok: true }; });
ipcMain.handle('code:ask', () => { void askCode(); return { ok: true }; });
ipcMain.handle('lang:toggle', () => { toggleAnswerLang(); return { lang: answerLang }; });
ipcMain.handle('sessions:list', () => sessions.list());
ipcMain.handle('sessions:search', (_e, payload: { q?: string; person?: string }) => sessions.search(String(payload?.q ?? ''), String(payload?.person ?? '')));
ipcMain.handle('sessions:people', () => sessions.people());
ipcMain.handle('sessions:load', (_e, payload: { id: string }) => {
  const s = sessions.load(String(payload?.id ?? ''));
  if (!s) return null;
  // Small thumbnails for code answers, built from the saved screenshot files.
  for (const a of s.answers) {
    if (a.kind !== 'code' || !a.shotFile) continue;
    try {
      if (!fs.existsSync(a.shotFile)) continue;
      const img = nativeImage.createFromPath(a.shotFile);
      if (!img.isEmpty()) a.thumb = img.resize({ width: 320, quality: 'good' }).toDataURL();
    } catch { /* no thumb */ }
  }
  return { ...s, names: sessions.names(s), job: jobs.get(s.id) ?? null };
});
ipcMain.handle('sessions:delete', (_e, payload: { id: string }) => {
  const id = String(payload?.id ?? '');
  if (viewerChat?.sessionId === id) { viewerChat.session.dispose(); viewerChat = null; }
  return { ok: sessions.remove(id) };
});
ipcMain.handle('sessions:reveal', (_e, payload: { id: string }) => {
  const p = sessions.mdPath(String(payload?.id ?? ''));
  if (fs.existsSync(p)) shell.showItemInFolder(p);
  else shell.openPath(SESSIONS_DIR);
  return { ok: true };
});
ipcMain.handle('participants:rename', (_e, payload: { id?: string | null; speaker: string; name: string }) => {
  const id = payload?.id || sessions.currentId();
  if (!id) return { ok: false, error: 'Nenhuma sessão.' };
  const s = sessions.setParticipant(id, String(payload?.speaker ?? ''), String(payload?.name ?? ''));
  if (!s) return { ok: false, error: 'Sessão não encontrada.' };
  pushParticipants(s);
  if (sessions.currentId() === s.id) pushTranscript(transcript.segments());
  // A renamed voice in the open viewer chat: start that chat over so names line up.
  if (viewerChat?.sessionId === s.id) { viewerChat.session.dispose(); viewerChat = null; }
  return { ok: true, names: sessions.currentId() === s.id ? liveNames() : sessions.names(s), participants: s.participants };
});
ipcMain.handle('meeting:chat', (_e, payload: { id?: string | null; text: string }) => askMeetingChat(payload?.id ?? null, String(payload?.text ?? '')));
ipcMain.handle('meeting:summarize', (_e, payload: { id: string }) => runSummary(String(payload?.id ?? '')));
ipcMain.handle('meeting:refine', (_e, payload: { id: string }) => { void runRefine(String(payload?.id ?? '')); return { ok: true }; });
ipcMain.handle('window:toggle', () => { toggleWindow(); return { ok: true }; });
ipcMain.handle('window:opacity', (_e, payload: { alpha: number }) => { setAlpha(Number(payload?.alpha), false); return { alpha }; });

ipcMain.handle('permissions:request', async (_e, payload: { which: 'microphone' | 'screen' | 'audio' | 'calendars' }) => {
  if (process.platform !== 'darwin') return { ok: true };
  switch (payload?.which) {
    case 'microphone':
      // Once denied, macOS no longer prompts: only System Settings can turn it back on.
      if (systemPreferences.getMediaAccessStatus('microphone') === 'denied') {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
        return { ok: true };
      }
      return { ok: await systemPreferences.askForMediaAccess('microphone') };
    case 'screen':
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return { ok: true };
    case 'audio':
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture');
      return { ok: true };
    case 'calendars':
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
      return { ok: true };
    default:
      return { ok: false };
  }
});

ipcMain.handle('open:external', async (_e, payload: { url: string }) => {
  const url = String(payload?.url ?? '');
  if (!/^https?:\/\//.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  createWindow();

  for (const accel of registerHotkeys(config.hotkeys)) {
    // Another app owns it. Report after the renderer is up.
    setTimeout(() => toast('error', `Atalho ${accel} não pôde ser registrado (em uso por outro app). Troque em Ajustes.`), 1500);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win?.show();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  globalShortcut.unregisterAll();
  setupSession?.dispose();
  answerSession?.dispose();
  codeSession?.dispose();
  liveChat?.dispose();
  viewerChat?.session.dispose();
  for (const s of summaryJobs.values()) s.dispose();
  for (const ch of ['me', 'them'] as const) stt[ch]?.close();
  if (sessions.isActive()) {
    for (const ch of ['me', 'them'] as const) transcript.closeUtterance(ch, true);
    sessions.recordTranscript(transcript.segments());
    sessions.end(recorder.stop());
  }
  audio.stop()
    .then(() => hfpGuard.stop())
    .finally(() => app.quit());
});
