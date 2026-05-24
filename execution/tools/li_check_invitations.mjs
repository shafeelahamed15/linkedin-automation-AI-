// Tool — Playwright action: read the action-button state on a lead's profile.
// Returns { state: 'pending' | 'accepted' | 'connect-back' | 'profile-not-found' | 'unknown' }.
// Implements SOP 07. NEVER clicks anything — pure observation.
import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from './stealth_browser.mjs';
import { checkPageForKillSwitch } from './li_kill_switch.mjs';

const STORAGE = 'linkedin_storage_state.json';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 768 };

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildNameTokens(first_name, last_name) {
  const tokens = [];
  for (const s of [first_name, last_name]) {
    if (!s) continue;
    for (const t of String(s).toLowerCase().split(/\s+/)) {
      if (t.length >= 2) tokens.push(t);
    }
  }
  return tokens;
}
function ariaMatchesLead(aria, displayedName, tokens) {
  if (!aria) return false;
  const a = aria.toLowerCase();
  if (displayedName && a.includes(displayedName.toLowerCase())) return true;
  return tokens.length > 0 && tokens.every((t) => a.includes(t));
}

/**
 * Check the action-button state on a single profile.
 *
 * @param {Object} params
 * @param {string} params.linkedin_url
 * @param {string} params.lead_id          Notion page id (for screenshot naming)
 * @param {string} [params.first_name]
 * @param {string} [params.last_name]
 * @param {object} [params.sharedBrowser]  pre-launched browser to reuse (preferred)
 * @returns {Promise<{state: string, displayedName?: string, screenshot?: string}>}
 */
export async function checkInvitationState({ linkedin_url, lead_id, first_name, last_name, sharedBrowser }) {
  const HEADLESS = (process.env.LI_HEADLESS ?? 'false').toLowerCase() === 'true';
  const browser = sharedBrowser ?? await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    storageState: STORAGE,
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
  });
  const page = await ctx.newPage();
  const tokens = buildNameTokens(first_name, last_name);

  async function snapshot(label) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir('./.tmp/li_screenshots', { recursive: true });
    const shot = join('./.tmp/li_screenshots', `${ts}__${lead_id ?? 'unknown'}__acceptance-${label}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    return shot;
  }

  try {
    await sleep(rand(1500, 4000));
    await page.goto(linkedin_url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await checkPageForKillSwitch(page);

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await sleep(rand(800, 2200));

    // Detect "profile not found" / deleted account.
    const title = (await page.title().catch(() => '')) ?? '';
    if (/page not found|this page (isn't|is not) available/i.test(title)) {
      const shot = await snapshot('profile-not-found');
      return { state: 'profile-not-found', screenshot: shot };
    }

    // 1. Locate displayed name.
    let heading = null;
    for (const cand of [
      page.locator('main h1'),
      page.locator('main [role="heading"][aria-level="1"]'),
      page.locator('main [role="heading"]'),
    ]) {
      if (await cand.first().isVisible({ timeout: 5000 }).catch(() => false)) { heading = cand.first(); break; }
    }
    if (!heading) {
      const shot = await snapshot('no-heading');
      return { state: 'unknown', screenshot: shot };
    }
    const displayedName = (await heading.innerText().catch(() => '')).trim();

    // 2. Read the visible action buttons in main, find the one that belongs to this lead.
    //    For acceptance detection, we care about which of these is present:
    //      - "Message"             → accepted (we're 1st-degree)
    //      - "Pending"             → still waiting
    //      - "Connect" (re-shown)  → withdrawn / declined / expired
    const allButtons = await page.locator('main button').all();
    const labelsForLead = [];
    for (const b of allButtons) {
      if (!(await b.isVisible().catch(() => false))) continue;
      const text = ((await b.innerText().catch(() => '')) ?? '').trim();
      const aria = ((await b.getAttribute('aria-label').catch(() => '')) ?? '').trim();
      // Buttons in the main profile card don't have the lead's name in aria-label
      // for "Message"/"Pending" — those just say e.g. "Message Karen Lang". So we
      // match on either the lead's name being in the aria-label, OR the button text
      // being a known action verb (Message/Pending/Connect) sitting in main.
      const lower = text.toLowerCase();
      const isVerb = lower === 'message' || lower === 'pending' || lower === 'connect';
      const leadInAria = ariaMatchesLead(aria, displayedName, tokens);
      if (leadInAria || isVerb) labelsForLead.push({ text, aria, lower });
    }

    // Decision priority: Message > Pending > Connect.
    if (labelsForLead.some((b) => b.lower === 'message')) {
      return { state: 'accepted', displayedName };
    }
    if (labelsForLead.some((b) => b.lower === 'pending')) {
      return { state: 'pending', displayedName };
    }
    if (labelsForLead.some((b) => b.lower === 'connect')) {
      return { state: 'connect-back', displayedName };
    }

    const shot = await snapshot('no-known-button');
    return { state: 'unknown', displayedName, screenshot: shot };
  } catch (err) {
    if (err?.name === 'KillSwitchTriggered') throw err;
    const shot = await snapshot('exception');
    return { state: 'unknown', screenshot: shot, error: err?.message ?? String(err) };
  } finally {
    await ctx.close().catch(() => {});
    if (!sharedBrowser) await browser.close().catch(() => {});
  }
}
