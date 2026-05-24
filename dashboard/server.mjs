// Dashboard server. Localhost-only. Single GET /api/snapshot endpoint that
// aggregates everything the UI needs (lead counts, safety state, scheduled
// task health, recent activity). Snapshot is cached server-side for 15s so
// auto-refresh from the browser doesn't hammer Notion or PowerShell.
import 'dotenv/config';
import express from 'express';
import { Client } from '@notionhq/client';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DAILY_CAPS,
  WEEKLY_CAPS,
  QUIET_START_HOUR,
  QUIET_END_HOUR,
  localParts,
  isWithinHours,
  isWeekend,
  checkLock,
} from '../execution/tools/safety_guard.mjs';
import { countSentInWindow } from '../execution/tools/lead_counts_window.mjs';
import { evaluateAcceptanceHealth } from '../execution/tools/acceptance_health.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TZ = process.env.OPERATOR_TIMEZONE || 'America/New_York';
const PORT = 3000;
const CACHE_TTL_MS = 15_000;

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

// ────────────────────────────────────────────────────────────────────────────
// Helpers

function execPS(command) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) { resolve(''); return; }
        resolve(stdout.toString());
      },
    );
  });
}

async function getScheduledTasks() {
  const cmd = `Get-ScheduledTask -TaskName 'LinkedinLeads-*' -ErrorAction SilentlyContinue | ForEach-Object {
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName
    [PSCustomObject]@{
      name           = $_.TaskName
      state          = "$($_.State)"
      lastRunTime    = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { '' }
      lastTaskResult = $info.LastTaskResult
      nextRunTime    = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { '' }
    }
  } | ConvertTo-Json -Compress`;
  const out = await execPS(cmd);
  if (!out.trim()) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function readHeartbeats() {
  const dir = path.resolve('.tmp/triggers');
  if (!existsSync(dir)) return {};
  const hb = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.last.log')) continue;
    const job = f.replace('.last.log', '');
    try {
      const text = readFileSync(path.join(dir, f), 'utf8').trim();
      const mtime = statSync(path.join(dir, f)).mtime.toISOString();
      hb[job] = { text, mtime };
    } catch { /* ignore */ }
  }
  return hb;
}

function nextSendWindowOpen(now, timeZone) {
  // Returns ISO string for the next 9:00 in `timeZone` that falls on Mon-Fri.
  // We probe forward in 1-hour increments using localParts() — slow but tiny.
  for (let h = 0; h < 24 * 8; h++) {
    const probe = new Date(now.getTime() + h * 3600_000);
    const { hour, dow } = localParts(probe, timeZone);
    if (hour === QUIET_START_HOUR && dow !== 0 && dow !== 6) {
      // Round down to that exact hour-mark in the local timezone.
      // (Approximation acceptable for "next window opens" display.)
      const minutes = localParts(probe, timeZone).minute;
      return new Date(probe.getTime() - minutes * 60_000).toISOString();
    }
  }
  return null;
}

async function getAllLeads() {
  const all = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const p of res.results) {
      const props = p.properties;
      const messagesRaw = props.messages_sent_json?.rich_text?.map(r => r.plain_text).join('') ?? '';
      const repliesRaw  = props.replies_json?.rich_text?.map(r => r.plain_text).join('') ?? '';
      let messages = [], replies = [];
      try { messages = messagesRaw ? JSON.parse(messagesRaw) : []; } catch { messages = []; }
      try { replies  = repliesRaw  ? JSON.parse(repliesRaw)  : []; } catch { replies  = []; }
      all.push({
        id: p.id,
        first_name: props.first_name?.rich_text?.[0]?.plain_text ?? '',
        last_name:  props.last_name?.rich_text?.[0]?.plain_text ?? '',
        company:    props.company?.rich_text?.[0]?.plain_text ?? '',
        title:      props.job_title?.rich_text?.[0]?.plain_text ?? '',
        industry:   props.industry?.rich_text?.[0]?.plain_text ?? '',
        email:      props.email?.email ?? '',
        url:        props.linkedin_url?.url ?? '',
        status:     props.status?.select?.name ?? '(none)',
        campaign:   props.campaign?.rich_text?.[0]?.plain_text ?? '',
        opener:     props.personalized_first_line?.rich_text?.[0]?.plain_text ?? '',
        last_action_at: props.last_action_at?.date?.start ?? null,
        last_channel:   props.last_channel?.rich_text?.[0]?.plain_text ?? '',
        error:          props.error?.rich_text?.[0]?.plain_text ?? '',
        messages_count: messages.length,
        replies_count:  replies.length,
        messages, replies,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return all;
}

function buildActivityFeed(leads, limit = 20) {
  const events = [];
  for (const L of leads) {
    for (const m of L.messages) {
      events.push({
        at: m.at,
        kind: 'sent',
        channel: m.channel,
        type: m.kind,
        lead: `${L.first_name} ${L.last_name}`,
        company: L.company,
        body: (m.body ?? '').slice(0, 160),
      });
    }
    for (const r of L.replies) {
      events.push({
        at: r.at,
        kind: 'reply',
        channel: r.channel,
        lead: `${L.first_name} ${L.last_name}`,
        company: L.company,
        body: (r.body ?? '').slice(0, 160),
      });
    }
  }
  events.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return events.slice(0, limit);
}

// ────────────────────────────────────────────────────────────────────────────
// Snapshot builder with cache

let cache = { at: 0, data: null, building: null };

async function buildSnapshot() {
  const now = new Date();
  const [leads, today, week, health, tasks] = await Promise.all([
    getAllLeads(),
    countSentInWindow(now, TZ, 1),
    countSentInWindow(now, TZ, 7),
    evaluateAcceptanceHealth(now, TZ),
    getScheduledTasks(),
  ]);

  const heartbeats = readHeartbeats();
  const lockExists = checkLock();
  const sessionPath = path.resolve('linkedin_storage_state.json');
  const sessionFile = existsSync(sessionPath) ? { bytes: statSync(sessionPath).size, mtime: statSync(sessionPath).mtime.toISOString() } : null;

  // Status counts
  const statusCounts = {};
  for (const L of leads) statusCounts[L.status] = (statusCounts[L.status] ?? 0) + 1;

  // List cap: with thousands of leads, sending all to the browser freezes the
  // DOM render. Sort by actionability (replies/errors first, then in-flight,
  // then queued, then review/terminal) and slice top N.
  const LIST_CAP = 250;
  const LIST_PRIORITY = ['replied','error','connecting','messaged','connected','queued','manual_review','won','muted','irrelevant'];
  const prio = (s) => { const i = LIST_PRIORITY.indexOf(s); return i === -1 ? 999 : i; };
  const sortedLeads = [...leads].sort((a, b) => {
    const pd = prio(a.status) - prio(b.status);
    if (pd !== 0) return pd;
    return (b.last_action_at ?? '').localeCompare(a.last_action_at ?? '');
  });
  const cappedLeads = sortedLeads.slice(0, LIST_CAP);

  // Safety state
  const { hour, minute, dow } = localParts(now, TZ);
  const safety = {
    inWindow: isWithinHours(now, TZ),
    isWeekend: isWeekend(now, TZ),
    lock: lockExists,
    quietStart: QUIET_START_HOUR,
    quietEnd: QUIET_END_HOUR,
    operatorHour: hour,
    operatorMinute: minute,
    operatorDow: dow,
    operatorTimezone: TZ,
    dryRun: (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true',
    nextWindowOpenIso: isWithinHours(now, TZ) ? null : nextSendWindowOpen(now, TZ),
  };

  // Compose
  return {
    generatedAt: now.toISOString(),
    safety,
    caps: {
      daily: DAILY_CAPS,
      weekly: WEEKLY_CAPS,
      today, week,
    },
    acceptance: health,
    leads: {
      total: leads.length,
      byStatus: statusCounts,
      listCap: LIST_CAP,
      listTruncated: leads.length > LIST_CAP,
      list: cappedLeads.map(L => ({
        id: L.id, first_name: L.first_name, last_name: L.last_name,
        company: L.company, title: L.title, status: L.status,
        opener: L.opener, url: L.url, email: L.email,
        last_action_at: L.last_action_at, last_channel: L.last_channel,
        error: L.error, messages_count: L.messages_count, replies_count: L.replies_count,
      })),
    },
    activity: buildActivityFeed(leads, 20),
    tasks,
    heartbeats,
    sessionFile,
    env: {
      operatorFirstName: process.env.OPERATOR_FIRST_NAME ?? '',
      notionDbId: DB_ID ?? '',
      slackChannel: process.env.SLACK_CHANNEL_ID ?? '',
      gmailUser: process.env.GMAIL_USER ?? '',
    },
  };
}

async function getSnapshot() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (cache.building) return cache.building;
  cache.building = buildSnapshot()
    .then(d => { cache = { at: Date.now(), data: d, building: null }; return d; })
    .catch(e => { cache.building = null; throw e; });
  return cache.building;
}

// ────────────────────────────────────────────────────────────────────────────
// Express app

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/snapshot', async (req, res) => {
  try {
    const data = await getSnapshot();
    res.json(data);
  } catch (e) {
    console.error('snapshot error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard ready → http://localhost:${PORT}`);
});
