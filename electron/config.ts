import fs from 'node:fs';
import path from 'node:path';

export interface ModelConfig {
  /** Alias (`sonnet`, `opus`) or full model id. */
  model: string;
  /** Opus-only. Needs usage credits on Pro/Max. Ignored for Sonnet. */
  fastMode: boolean;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface AppConfig {
  hotkeys: { answer: string; code: string; toggleWindow: string; language: string; opacityUp: string; opacityDown: string };
  answer: ModelConfig;
  code: ModelConfig;
  /** Pre-session briefing chat. Standard speed on purpose: no fast-mode credits. */
  setup: ModelConfig;
  stt: {
    model: string;
    /** `multi` auto-detects English/Portuguese per word; `en` or `pt-BR` fixes one. */
    language: string;
    endpointingMs: number;
    utteranceEndMs: number;
    smartFormat: boolean;
  };
  window: {
    alwaysOnTop: boolean;
    hideFromScreenCapture: boolean;
    width: number;
    height: number;
    /** Background opacity 0.3-1. Text stays fully opaque; only the white fades. */
    opacity: number;
  };
  screenshot: { maxWidth: number };
  /** Meeting mode: recorder without the copilot. */
  meeting: {
    /** Label for the microphone channel in transcripts and prompts. */
    myName: string;
    /**
     * Default STT language for meetings, overridable per meeting in the UI.
     * A fixed language (`pt-BR`, `en`) transcribes better and lets Deepgram
     * tell voices apart; `multi` (interview default) breaks diarization.
     */
    language: string;
    /** Deepgram speaker labels on the system channel (who said what among the others). */
    diarize: boolean;
    /** Keep one 16 kHz mono WAV per channel next to the session for the offline pass. */
    saveAudio: boolean;
    /** After Parar: re-transcribe the WAVs with Deepgram pre-recorded + diarization. */
    refine: boolean;
    /** After refining: summary with decisions and actions per person. */
    autoSummary: boolean;
    /** Meeting windows stay normal (not floating) unless this is on. */
    alwaysOnTop: boolean;
    summary: ModelConfig;
    chat: ModelConfig;
  };
  audio: {
    /**
     * With a Bluetooth headset as output, make the built-in mic the system
     * default input for the session (restored at stop). Keeps the headset in
     * A2DP so the system-audio tap stays clean even when Zoom follows the
     * system default. Needs native/audio-defaults (built on npm install).
     */
    forceBuiltInMicWhenBluetooth: boolean;
  };
  autoStart: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  hotkeys: {
    answer: 'CommandOrControl+Shift+Space',
    code: 'CommandOrControl+Shift+Return',
    toggleWindow: 'CommandOrControl+Shift+H',
    language: 'CommandOrControl+Shift+L',
    opacityUp: 'CommandOrControl+Shift+Up',
    opacityDown: 'CommandOrControl+Shift+Down',
  },
  // Subscription only: no fast mode (it bills usage credits). Sonnet 5.5 is
  // the fastest standard-speed model measured here (~100 tok/s, ~1.3 s TTFT).
  answer: { model: 'sonnet', fastMode: false, effort: 'low' },
  code: { model: 'sonnet', fastMode: false, effort: 'low' },
  setup: { model: 'sonnet', fastMode: false, effort: 'medium' },
  stt: {
    model: 'nova-3',
    language: 'multi',
    endpointingMs: 300,
    utteranceEndMs: 1000,
    smartFormat: true,
  },
  window: { alwaysOnTop: true, hideFromScreenCapture: true, width: 1120, height: 720, opacity: 1 },
  screenshot: { maxWidth: 1568 },
  meeting: {
    myName: 'Eu',
    language: 'pt-BR',
    diarize: true,
    saveAudio: true,
    refine: true,
    autoSummary: true,
    alwaysOnTop: false,
    summary: { model: 'sonnet', fastMode: false, effort: 'medium' },
    chat: { model: 'sonnet', fastMode: false, effort: 'low' },
  },
  audio: { forceBuiltInMicWhenBluetooth: true },
  autoStart: false,
};

function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
  if (!patch || typeof patch !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as any)) {
    const cur = (base as any)[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object'
      ? deepMerge(cur, v as any)
      : v;
  }
  return out as T;
}

export function loadConfig(root: string): AppConfig {
  const file = path.join(root, 'config.json');
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch (err) {
    console.error('[config] config.json invalid, using defaults:', err);
    return DEFAULT_CONFIG;
  }
}

/** Tiny .env reader: KEY=value lines, `#` comments, optional quotes. */
export function loadEnv(root: string): Record<string, string> {
  const file = path.join(root, '.env');
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadProfile(root: string): string {
  const file = path.join(root, 'profile.md');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').trim();
}
