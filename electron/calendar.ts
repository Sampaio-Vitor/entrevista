import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Upcoming meetings from the macOS calendar store (every account added in
 * System Settings > Internet Accounts), read by native/EntrevistaCalendar.app
 * (see scripts/calendar.swift). The helper runs through `open` so it is its
 * own app for the privacy prompt; it answers through a temp file.
 */
export type CalendarAccess = 'granted' | 'denied' | 'restricted' | 'writeOnly' | 'notDetermined' | 'unknown' | 'unavailable';

export interface CalendarAttendee {
  name?: string;
  email?: string;
  me: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  calendar: string;
  source: string;
  color?: string;
  link?: string;
  organizer?: string;
  attendees: CalendarAttendee[];
}

export interface CalendarSnapshot {
  access: CalendarAccess;
  events: CalendarEvent[];
  fetchedAt: number;
  error?: string;
}

export class CalendarReader {
  private readonly app: string;
  private inflight: Promise<CalendarSnapshot> | null = null;

  constructor(nativeDir: string) {
    this.app = path.join(nativeDir, 'EntrevistaCalendar.app');
  }

  available(): boolean {
    return process.platform === 'darwin' && fs.existsSync(path.join(this.app, 'Contents', 'MacOS', 'EntrevistaCalendar'));
  }

  /** `request` shows the macOS permission prompt when access is still undecided. */
  fetch(opts: { request?: boolean; backHours?: number; aheadHours?: number } = {}): Promise<CalendarSnapshot> {
    if (!this.available()) return Promise.resolve({ access: 'unavailable', events: [], fetchedAt: Date.now() });
    if (this.inflight) return this.inflight;
    const out = path.join(os.tmpdir(), `entrevista-calendar-${process.pid}-${Date.now()}.json`);
    const args = ['-g', '-W', '-n', this.app, '--args', 'events', '--out', out,
      '--back-hours', String(opts.backHours ?? 2), '--ahead-hours', String(opts.aheadHours ?? 36)];
    if (opts.request) args.push('--request');
    this.inflight = new Promise<CalendarSnapshot>((resolve) => {
      // The permission prompt waits for the user, so allow it a while.
      execFile('/usr/bin/open', args, { timeout: opts.request ? 120000 : 20000 }, (err) => {
        let snap: CalendarSnapshot;
        try {
          const raw = JSON.parse(fs.readFileSync(out, 'utf8'));
          snap = { access: raw.access ?? 'unknown', events: dedupe(raw.events ?? []), fetchedAt: Date.now() };
        } catch {
          snap = { access: 'unknown', events: [], fetchedAt: Date.now(), error: err?.message ?? 'calendar helper gave no answer' };
        }
        try { fs.unlinkSync(out); } catch { /* already gone */ }
        resolve(snap);
      });
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

/**
 * The same meeting shows up once per account that was invited (work Google
 * plus Exchange, say). Keep one per title + start, preferring the copy with a
 * call link and the longest guest list.
 */
function dedupe(events: CalendarEvent[]): CalendarEvent[] {
  const byKey = new Map<string, CalendarEvent>();
  const score = (e: CalendarEvent) => (e.link ? 1000 : 0) + e.attendees.length;
  for (const e of events) {
    const key = `${e.title.trim().toLowerCase()}|${e.start}`;
    const cur = byKey.get(key);
    if (!cur || score(e) > score(cur)) byKey.set(key, e);
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start);
}

/** Display names of the other guests (not you), for the meeting context. */
export function guestNames(e: CalendarEvent): string[] {
  return e.attendees
    .filter((a) => !a.me)
    .map((a) => a.name || (a.email ? a.email.split('@')[0] : ''))
    .filter(Boolean);
}
