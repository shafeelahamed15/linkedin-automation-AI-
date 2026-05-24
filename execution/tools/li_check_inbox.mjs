// Tool — LinkedIn messaging poll via Playwright. Reads the /messaging/ inbox,
// opens threads matching known leads (by name), parses recent messages.
// No business logic; navigator decides what to do with the results.
import 'dotenv/config';
import { chromium } from './stealth_browser.mjs';
import { checkPageForKillSwitch } from './li_kill_switch.mjs';

const STORAGE = 'linkedin_storage_state.json';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 768 };

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OPERATOR_NAME = (process.env.LI_OPERATOR_NAME || 'Operator Name').toLowerCase();

/**
 * Normalize a participant name from the LI conversation list.
 * LinkedIn appends connection-degree badges and pronoun separators that break
 * exact-match lookup, e.g.:
 *   "Karen Lang • 1st"      → "karen lang"
 *   "Karen Lang · He/Him"   → "karen lang"
 *   "Karen Lang (She/Her)"  → "karen lang"
 *   "Karen Lang, Founder"   → "karen lang"
 * Strips anything from the first `•`, `·`, `(`, or `,` and lowercases.
 */
function normalizeParticipantName(s) {
  if (!s) return '';
  return String(s).split(/[•·(,]/)[0].trim().toLowerCase();
}

/**
 * Poll the LI messaging inbox for activity in conversations matching a known
 * set of leads (by their full name).
 *
 * @param {Object} args
 * @param {Array<{lead_id: string, full_name: string, linkedin_url: string}>} args.knownLeads
 * @param {Date} [args.since]            ignore messages older than this (default: 24h ago)
 * @param {boolean} [args.dryRun=false]  if true, skip the browser entirely and return []
 * @returns {Promise<Array<{
 *   lead_id: string,
 *   thread_url: string,
 *   conversation_seen: boolean,
 *   new_inbound_messages: Array<{message_id: string, at: string, body: string}>
 * }>>}
 */
export async function liCheckInbox({ knownLeads, since, dryRun = false }) {
  if (dryRun) return [];
  if (!knownLeads.length) return [];

  const sinceMs = (since ?? new Date(Date.now() - 24 * 3600 * 1000)).getTime();
  // Index leads by normalized name so row matching survives LI's "• 1st" suffix.
  const byNameLower = new Map(knownLeads.map((l) => [normalizeParticipantName(l.full_name), l]));

  // Honor LI_HEADLESS env override; default to headed because LinkedIn's anti-bot
  // serves a stripped DOM in headless Chromium (no msg-conversation-listitem rows).
  // Matches the convention in li_send_connection.mjs.
  const HEADLESS = (process.env.LI_HEADLESS ?? 'false').toLowerCase() === 'true';
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    storageState: STORAGE,
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
  });
  const page = await ctx.newPage();
  const results = [];

  try {
    await sleep(rand(1500, 4000));
    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await checkPageForKillSwitch(page);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await sleep(rand(800, 2200));

    // Each conversation list row
    const rows = await page.locator('li.msg-conversation-listitem').all().catch(() => []);
    for (const row of rows) {
      const nameRaw = (await row.locator('.msg-conversation-listitem__participant-names').innerText().catch(() => '')).trim();
      const matchKey = normalizeParticipantName(nameRaw);
      const match = byNameLower.get(matchKey);
      if (!match) continue;  // not a known lead, skip silently

      // Open this thread
      await row.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await sleep(rand(700, 1500));

      const threadUrl = page.url();
      const messageEls = await page.locator('.msg-s-event-listitem').all().catch(() => []);
      const inbound = [];

      // Walk messages from oldest to newest; carry the "current sender" forward
      // (LI groups consecutive messages under a single sender header).
      let currentSender = '';
      for (let i = 0; i < messageEls.length; i++) {
        const el = messageEls[i];
        const senderHeader = (await el.locator('.msg-s-message-group__name').innerText().catch(() => '')).trim();
        if (senderHeader) currentSender = senderHeader;

        const body = (await el.locator('.msg-s-event-listitem__body').innerText().catch(() => '')).trim();
        if (!body) continue;

        const ts = await el.locator('time.msg-s-message-group__timestamp').first().getAttribute('datetime').catch(() => null);
        const atMs = ts ? Date.parse(ts) : Date.now();
        if (Number.isNaN(atMs) || atMs < sinceMs) continue;

        const isFromOperator = currentSender.toLowerCase().includes(OPERATOR_NAME);
        if (isFromOperator) continue;

        inbound.push({
          message_id: `${threadUrl}__${i}`,
          at: new Date(atMs).toISOString(),
          body,
        });
      }

      results.push({
        lead_id: match.lead_id,
        thread_url: threadUrl,
        conversation_seen: true,
        new_inbound_messages: inbound,
      });

      // Be polite: pause between conversations.
      await sleep(rand(800, 2000));
    }
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return results;
}
