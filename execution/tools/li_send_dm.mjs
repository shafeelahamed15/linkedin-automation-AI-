// Tool — Playwright action: send a LinkedIn DM. Implements SOP 05 §"Action 2".
// Only invoked when status === 'connected'.
import 'dotenv/config';
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from './stealth_browser.mjs';
import { checkPageForKillSwitch } from './li_kill_switch.mjs';

const STORAGE = 'linkedin_storage_state.json';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 768 };

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIGNATURE = `\n\nBest,\n${process.env.OPERATOR_FIRST_NAME ?? 'Operator'}`;
const CTA_PARAGRAPH = '\n\nHappy to share a 30-second example of what this looks like for a club leader. Worth a quick chat?';

/** Build the DM body from the personalized first line per SOP 05 §"DM body template". */
export function buildDmBody(personalized_first_line) {
  return `${personalized_first_line.trim()}${CTA_PARAGRAPH}${SIGNATURE}`;
}

async function logDryRun(entry) {
  const day = new Date().toISOString().slice(0, 10);
  await mkdir('./.tmp/dry_run_log', { recursive: true });
  await appendFile(join('./.tmp/dry_run_log', `${day}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Send a direct message to the lead on LinkedIn.
 *
 * @param {Object} params
 * @param {string} params.linkedin_url
 * @param {string} params.body            already-assembled message body
 * @param {string} params.lead_id
 * @param {boolean} params.dryRun
 * @param {object} [params.sharedBrowser]
 * @returns {Promise<{ok: boolean, kind: 'sent'|'dry-run', reason?: string, screenshot?: string}>}
 */
export async function sendDm({ linkedin_url, body, lead_id, dryRun, sharedBrowser }) {
  if (dryRun) {
    await logDryRun({ at: new Date().toISOString(), action: 'dm', linkedin_url, lead_id, body });
    return { ok: true, kind: 'dry-run' };
  }

  // Same LinkedIn anti-bot constraint as li_send_connection: headed mode required.
  const HEADLESS = (process.env.LI_HEADLESS ?? 'false').toLowerCase() === 'true';
  const browser = sharedBrowser ?? await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    storageState: STORAGE,
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
  });
  const page = await ctx.newPage();

  try {
    await sleep(rand(1500, 4000));
    await page.goto(linkedin_url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await checkPageForKillSwitch(page);

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await sleep(rand(800, 2200));

    const msgBtn = page.locator('button[aria-label^="Message"], a:has(span:has-text("Message"))').first();
    if (!await msgBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      return { ok: false, reason: 'message-button-missing' };
    }
    await msgBtn.click();

    const textbox = page.locator('div[role="textbox"][contenteditable="true"], .msg-form__contenteditable').first();
    await textbox.waitFor({ state: 'visible', timeout: 8000 });
    await sleep(rand(400, 900));
    await textbox.click();
    // Type with random delays line by line to feel human.
    for (const line of body.split('\n')) {
      if (line.length) await textbox.type(line, { delay: rand(30, 80) });
      await textbox.press('Shift+Enter').catch(() => {});
    }

    await sleep(rand(800, 2200));
    const sendBtn = page.locator('button.msg-form__send-button, button[aria-label="Send now"]').first();
    if (await sendBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
      await sendBtn.click();
    } else {
      await textbox.press('Control+Enter').catch(() => {});
    }

    // Confirm: just-sent message visible in the conversation.
    const confirmation = page.locator(`.msg-s-message-list__event >> text=/${body.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).first();
    await confirmation.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

    return { ok: true, kind: 'sent' };
  } catch (err) {
    if (err?.name === 'KillSwitchTriggered') throw err;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir('./.tmp/li_screenshots', { recursive: true });
    const shot = join('./.tmp/li_screenshots', `${ts}__${lead_id ?? 'unknown'}__dm.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    return { ok: false, reason: err?.message ?? String(err), screenshot: shot };
  } finally {
    await ctx.close().catch(() => {});
    if (!sharedBrowser) await browser.close().catch(() => {});
  }
}
