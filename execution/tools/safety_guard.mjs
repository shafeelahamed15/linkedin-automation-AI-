// Tool — deterministic safety gate. Pure functions, no I/O except `existsSync(LOCK)`.
// Implements SOP 04 §"Safety gate".
import { existsSync } from 'node:fs';

const LOCK_PATH = './LOCK';

// Default caps are conservative — tune for your own LinkedIn account's trust level.
// A brand-new account should start at 5-10/day; an established account can sustain
// 25-50/day. Higher values raise the risk of LinkedIn restricting account features.
export const DAILY_CAPS = Object.freeze({ connection: 15, dm: 10, email: 30 });

// Weekly caps catch a failure mode that daily caps miss: pushing the daily cap
// every single day adds up to bot-like sustained volume. LinkedIn's heuristic
// score takes ~7-day rolling history into account. We cap weekly at ~3× the
// daily cap (not 7× — that would equal max-everything-every-day).
export const WEEKLY_CAPS = Object.freeze({ connection: 150, dm: 240, email: 100 });
export const QUIET_START_HOUR = 9;   // 09:00 local
export const QUIET_END_HOUR   = 17;  // 17:00 local
export const MIN_JITTER_MS = 60_000;
export const MAX_JITTER_MS = 180_000;

/**
 * Format a Date into a record of { hour, minute, dow } in the given IANA timezone.
 * dow: 0=Sun, 1=Mon, ... 6=Sat (matches JS Date.getDay()).
 */
export function localParts(now, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hour:   parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    dow:    dowMap[parts.weekday] ?? -1,
  };
}

export function isWithinHours(now, timeZone) {
  const { hour } = localParts(now, timeZone);
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

export function isWeekend(now, timeZone) {
  const { dow } = localParts(now, timeZone);
  return dow === 0 || dow === 6;
}

export function checkLock() {
  return existsSync(LOCK_PATH);
}

/**
 * Aggregate a safety report. Pure — caller decides what to do.
 * Optionally accepts weekCounts for the weekly-cap check (added 2026-05-20).
 *
 * @param {Object} args
 * @param {Date} args.now
 * @param {string} args.timeZone
 * @param {{connection: number, dm: number, email?: number}} args.todayCounts
 * @param {{connection: number, dm: number, email?: number}} [args.weekCounts]   optional; if omitted, weekly cap is not enforced
 * @returns {{ok: boolean, reasons: string[], remaining: {connection: number, dm: number, email?: number}}}
 */
export function evaluateSafety({ now, timeZone, todayCounts, weekCounts }) {
  const reasons = [];
  if (checkLock())                       reasons.push('LOCK file present — manual reset required');
  if (isWeekend(now, timeZone))          reasons.push('weekend — operator timezone forbids weekend sends');
  if (!isWithinHours(now, timeZone))     reasons.push(`outside quiet hours (${QUIET_START_HOUR}:00–${QUIET_END_HOUR}:00 ${timeZone})`);

  const dailyRemaining = {
    connection: Math.max(0, DAILY_CAPS.connection - (todayCounts.connection ?? 0)),
    dm:         Math.max(0, DAILY_CAPS.dm         - (todayCounts.dm         ?? 0)),
    email:      Math.max(0, DAILY_CAPS.email      - (todayCounts.email      ?? 0)),
  };
  if (dailyRemaining.connection === 0 && dailyRemaining.dm === 0 && dailyRemaining.email === 0) {
    reasons.push(`daily caps reached (${todayCounts.connection}/${DAILY_CAPS.connection} conn, ${todayCounts.dm}/${DAILY_CAPS.dm} dm, ${todayCounts.email}/${DAILY_CAPS.email} email)`);
  }

  // Weekly cap (optional — if weekCounts not supplied, skip this check)
  let weeklyRemaining = null;
  if (weekCounts) {
    weeklyRemaining = {
      connection: Math.max(0, WEEKLY_CAPS.connection - (weekCounts.connection ?? 0)),
      dm:         Math.max(0, WEEKLY_CAPS.dm         - (weekCounts.dm         ?? 0)),
      email:      Math.max(0, WEEKLY_CAPS.email      - (weekCounts.email      ?? 0)),
    };
    if (weeklyRemaining.connection === 0 && weeklyRemaining.dm === 0 && weeklyRemaining.email === 0) {
      reasons.push(`weekly caps reached (${weekCounts.connection}/${WEEKLY_CAPS.connection} conn, ${weekCounts.dm}/${WEEKLY_CAPS.dm} dm last 7d)`);
    }
  }

  // The effective `remaining` is the MIN of daily and weekly (since each is a separate ceiling).
  const remaining = weeklyRemaining ? {
    connection: Math.min(dailyRemaining.connection, weeklyRemaining.connection),
    dm:         Math.min(dailyRemaining.dm,         weeklyRemaining.dm),
    email:      Math.min(dailyRemaining.email,      weeklyRemaining.email),
  } : dailyRemaining;

  return { ok: reasons.length === 0, reasons, remaining };
}

/** Random integer in [min, max] inclusive. */
export function jitterMs() {
  return MIN_JITTER_MS + Math.floor(Math.random() * (MAX_JITTER_MS - MIN_JITTER_MS + 1));
}

export const LOCK_FILE_PATH = LOCK_PATH;
