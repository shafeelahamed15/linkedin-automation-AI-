// Tool — Playwright action: send a LinkedIn connection request with a note.
// Implements SOP 05 §"Action 1". Honors DRY_RUN=true by skipping the browser.
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

/**
 * Truncate at word boundary, no ellipsis (ellipses are an AI-tell per
 * 2026-05-22 voice rewrite — see project_production_bug_log.md).
 */
export function truncateNote(s, max = 200) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '');
}

/**
 * The connection-request note IS the personalized opener — no CTA template, no
 * signature suffix. Recipient already sees "Shafeel sent you a connection
 * request" in the LinkedIn UI, so a "— Shafeel" suffix is redundant AND its
 * em-dash is an AI-tell. The personalize system prompt is responsible for
 * producing a complete, casual, in-voice note that ends with "love to connect".
 *
 * LinkedIn note ceiling: 300 chars (premium) / 200 chars (throttled / basic).
 * We cap at 200 to be safe across account states.
 */
const NOTE_MAX = 200;

export function buildConnectionNote(personalized_first_line) {
  const opener = (personalized_first_line ?? '').trim();
  return truncateNote(opener, NOTE_MAX);
}

/**
 * Logs the planned action to .tmp/dry_run_log/YYYY-MM-DD.jsonl. Used in dry-run mode.
 */
async function logDryRun(entry) {
  const day = new Date().toISOString().slice(0, 10);
  await mkdir('./.tmp/dry_run_log', { recursive: true });
  await appendFile(join('./.tmp/dry_run_log', `${day}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Build a name-match token set from a lead's first + last name. Used to verify
 * an aria-label belongs to our target lead (defends against sidebar matches).
 */
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

function ariaMatchesLead(ariaLabel, displayedName, nameTokens) {
  if (!ariaLabel) return false;
  const a = ariaLabel.toLowerCase();
  if (displayedName && a.includes(displayedName.toLowerCase())) return true;
  // Fallback: every supplied name token must appear in the aria-label.
  return nameTokens.length > 0 && nameTokens.every((t) => a.includes(t));
}

/**
 * Send a connection request.
 *
 * @param {Object} params
 * @param {string} params.linkedin_url
 * @param {string} params.note
 * @param {string} params.lead_id           Notion page id (for screenshots)
 * @param {string} [params.first_name]      used to verify the matched button belongs to this lead
 * @param {string} [params.last_name]       same
 * @param {boolean} params.dryRun           if true, do not launch a browser
 * @param {object} [params.sharedBrowser]   pre-launched browser to reuse (live mode only)
 * @returns {Promise<{ok: boolean, kind: 'sent'|'pending'|'dry-run', reason?: string}>}
 */
export async function sendConnection({ linkedin_url, note, lead_id, first_name, last_name, dryRun, sharedBrowser }) {
  const finalNote = truncateNote(note);
  if (dryRun) {
    const entry = { at: new Date().toISOString(), action: 'connection', linkedin_url, lead_id, note: finalNote };
    await logDryRun(entry);
    return { ok: true, kind: 'dry-run', reason: 'dry-run mode' };
  }

  // NOTE (2026-05-19): LinkedIn detects headless Chromium and serves a stripped DOM
  // without h1 / primary action buttons. Headed mode (visible window) is required
  // until proper stealth-mode is added in Phase S. Override via LI_HEADLESS=true.
  const HEADLESS = (process.env.LI_HEADLESS ?? 'false').toLowerCase() === 'true';
  const browser = sharedBrowser ?? await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    storageState: STORAGE,
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
  });
  const page = await ctx.newPage();
  const nameTokens = buildNameTokens(first_name, last_name);

  async function snapshot(label) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir('./.tmp/li_screenshots', { recursive: true });
    const shot = join('./.tmp/li_screenshots', `${ts}__${lead_id ?? 'unknown'}__${label}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    return shot;
  }

  try {
    await sleep(rand(1500, 4000));
    await page.goto(linkedin_url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await checkPageForKillSwitch(page);

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await sleep(rand(800, 2200));

    // 1) Anchor on the lead's name heading. LinkedIn may use <h1>, [role="heading"], or
    //    other variants. Try a few selectors and take the first that's visible in <main>.
    const main = page.locator('main');
    let heading = null;
    const headingCandidates = [
      main.locator('h1'),
      main.getByRole('heading', { level: 1 }),
      main.getByRole('heading'),
      main.locator('[class*="text-heading-xlarge"]'),
    ];
    for (const cand of headingCandidates) {
      if (await cand.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        heading = cand.first();
        break;
      }
    }
    if (!heading) {
      const shot = await snapshot('no-heading');
      return { ok: false, reason: 'profile-heading-missing', screenshot: shot };
    }
    const displayedName = (await heading.innerText().catch(() => '')).trim();

    // 2) Find ALL "Invite X to connect" actions in <main>; pick the one whose aria-label
    //    matches our lead's displayed name. This bypasses brittle section-scoping AND
    //    rejects sidebar suggestions whose aria-label names the wrong person.
    // NOTE (2026-05-21): LinkedIn renders Connect as <a> for out-of-network profiles
    //    and (historically) <button> for in-network. We accept both. The
    //    ariaMatchesLead filter below still prevents false-positive sidebar matches.
    const allInviteButtons = await page.locator('main button[aria-label*="Invite" i][aria-label*="connect" i], main a[aria-label*="Invite" i][aria-label*="connect" i]').all();
    let primaryConnect = null;
    for (const btn of allInviteButtons) {
      const aria = (await btn.getAttribute('aria-label').catch(() => '')) ?? '';
      if (ariaMatchesLead(aria, displayedName, nameTokens) && await btn.isVisible().catch(() => false)) {
        primaryConnect = btn;
        break;
      }
    }

    let usedMoreMenu = false;
    if (primaryConnect) {
      await primaryConnect.click();
    } else {
      // 3) Primary Connect not found for this lead. Two sub-cases:
      //    a) Already Pending — check the page for a Pending state near the heading.
      //    b) Need to go via the More menu.
      const pendingNearHeading = heading.locator('xpath=ancestor::div[1]//*[contains(text(),"Pending")]').first();
      if (await pendingNearHeading.isVisible({ timeout: 1500 }).catch(() => false)) {
        return { ok: true, kind: 'pending', reason: 'already-pending' };
      }
      // Try the More menu. Restrict to a More button that is near the heading.
      const more = heading.locator('xpath=ancestor::div[.//button[contains(@aria-label, "More actions")]][1]')
        .locator('button[aria-label*="More actions" i]').first();
      if (!await more.isVisible({ timeout: 4000 }).catch(() => false)) {
        const shot = await snapshot('no-connect-no-more');
        return { ok: false, reason: `connect-button-missing (heading="${displayedName}")`, screenshot: shot };
      }
      await more.click();
      await sleep(rand(800, 2200));
      const moreConnect = page.locator('[role="menu"]').last().locator('text=/^Connect$/i').first();
      if (!await moreConnect.isVisible({ timeout: 4000 }).catch(() => false)) {
        const shot = await snapshot('more-menu-no-connect');
        return { ok: false, reason: 'connect-not-in-more-menu', screenshot: shot };
      }
      await moreConnect.click();
      usedMoreMenu = true;
    }

    // 4) After the click, two possible next states:
    //    a) Note modal opens — we type and click Send
    //    b) LinkedIn directly sends a no-note request — primary Connect flips to "Pending"
    //    c) Email-verification modal opens — we must abort to manual_review
    const dialog = page.locator('[role="dialog"]').first();
    // Pending indicator — search near the heading.
    const pending = heading.locator('xpath=ancestor::div[1]//*[contains(text(),"Pending")]').first();

    const raceWinner = await Promise.race([
      dialog.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'dialog').catch(() => null),
      pending.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'pending').catch(() => null),
    ]);

    if (raceWinner === 'pending') {
      // LinkedIn fired the request without showing a modal. No personalized note was sent.
      const shot = await snapshot('pending-no-modal');
      return { ok: true, kind: 'sent', reason: 'sent-without-note (LinkedIn skipped the modal)', screenshot: shot };
    }
    if (raceWinner !== 'dialog') {
      const shot = await snapshot('no-modal-no-pending');
      return { ok: false, reason: 'no-modal-or-pending-after-click', screenshot: shot };
    }

    // Dialog appeared. Check for email-verification flow.
    const emailField = dialog.locator('input[name="email"], input[type="email"]').first();
    if (await emailField.isVisible({ timeout: 1500 }).catch(() => false)) {
      const shot = await snapshot('email-verify-required');
      // Close the modal by pressing Escape, don't submit anything.
      await page.keyboard.press('Escape').catch(() => {});
      return { ok: false, reason: 'email-verification-required', screenshot: shot };
    }

    const addNote = dialog.locator('button:has-text("Add a note")').first();
    if (await addNote.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sleep(rand(800, 2200));
      await addNote.click();
    }

    const textarea = dialog.locator('#custom-message, textarea[name="message"]').first();
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await sleep(rand(400, 900));
    await textarea.type(finalNote, { delay: rand(30, 80) });

    await sleep(rand(800, 2200));
    const sendBtn = dialog.locator('button:has-text("Send"), button:has-text("Send invitation")').first();

    // Bug-log Gap 2: before clicking, check the button's enabled state. A
    // disabled Send button (aria-disabled / artdeco-button--disabled) means
    // LinkedIn isn't going to accept the invite on this profile right now —
    // typically because an invite is already pending, the profile is restricted
    // (3rd+ degree), or premium-only. Without this guard, .click() waits the
    // full 30s timeout for "actionability" before throwing — wasted time that
    // also looks bot-like to LinkedIn's heuristic score.
    await sendBtn.waitFor({ state: 'attached', timeout: 5000 });
    const isDisabledNow = await sendBtn.evaluate((el) => {
      if (!el) return true;
      if (el.disabled) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      if (/(^|\s)artdeco-button--disabled(\s|$)/.test(el.className || '')) return true;
      return false;
    }).catch(() => true);
    if (isDisabledNow) {
      const shot = await snapshot('send-button-disabled');
      return {
        ok: false,
        reason: 'send-button-disabled (likely already-pending invite, restricted profile, or premium-gated)',
        screenshot: shot,
      };
    }

    await sendBtn.click();

    // Confirm success: profile-card pending OR toast.
    const success = page.locator('text=/invitation sent/i').first();
    const winner = await Promise.race([
      pending.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'pending').catch(() => null),
      success.waitFor({ state: 'visible', timeout: 12_000 }).then(() => 'toast').catch(() => null),
    ]);
    if (!winner) {
      const shot = await snapshot('post-send-no-confirmation');
      return { ok: false, reason: 'post-send-no-confirmation', screenshot: shot };
    }
    return { ok: true, kind: 'sent', via: usedMoreMenu ? 'more-menu' : 'primary' };
  } catch (err) {
    if (err?.name === 'KillSwitchTriggered') throw err;
    const shot = await snapshot('exception');
    return { ok: false, reason: err?.message ?? String(err), screenshot: shot };
  } finally {
    await ctx.close().catch(() => {});
    if (!sharedBrowser) await browser.close().catch(() => {});
  }
}
