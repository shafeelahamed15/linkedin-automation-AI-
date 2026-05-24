// Tool — inspects the current Playwright page for any of the four LinkedIn
// safety triggers per SOP 05 §"Action 3". Writes ./LOCK on detection.
// Pure: doesn't decide what to do beyond writing LOCK; caller throws.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TRIGGERS = [
  {
    name: '429-rate-limit',
    matches: async (page) => {
      const url = page.url();
      if (/\/(error|uas\/login)/i.test(url)) return true;
      const title = await page.title().catch(() => '');
      return /too many requests/i.test(title);
    },
  },
  {
    name: 'captcha',
    matches: async (page) => {
      const hasRecaptcha = await page.locator('iframe[src*="recaptcha"], iframe[src*="captcha"]').count().catch(() => 0);
      if (hasRecaptcha > 0) return true;
      const text = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      return /please verify|prove you('re| are) human/i.test(text);
    },
  },
  {
    name: 'security-checkpoint',
    matches: async (page) => {
      const url = page.url();
      if (/\/checkpoint\/|\/security\//i.test(url)) return true;
      const text = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      return /restricted some account features|we've detected unusual activity/i.test(text);
    },
  },
  {
    name: 'logged-out',
    matches: async (page) => /\/login|\/uas\/login/i.test(page.url()),
  },
];

export class KillSwitchTriggered extends Error {
  constructor(reason, screenshotPath) {
    super(`LinkedIn kill-switch triggered: ${reason}`);
    this.reason = reason;
    this.screenshot = screenshotPath;
    this.name = 'KillSwitchTriggered';
  }
}

/**
 * Run all four checks against the current page. Returns null if all-clear.
 * Returns the trigger name (and writes LOCK + screenshot) if any tripped.
 */
export async function checkPageForKillSwitch(page) {
  for (const t of TRIGGERS) {
    if (await t.matches(page)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await mkdir('./.tmp/li_safety_alerts', { recursive: true });
      const screenshotPath = join('./.tmp/li_safety_alerts', `${ts}__${t.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      const lockBody = JSON.stringify(
        { at: new Date().toISOString(), reason: t.name, screenshot: screenshotPath },
        null, 2,
      );
      await writeFile('./LOCK', lockBody, 'utf8');
      throw new KillSwitchTriggered(t.name, screenshotPath);
    }
  }
  return null;
}
