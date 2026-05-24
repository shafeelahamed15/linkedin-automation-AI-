// Tool — pre-send "warm up" routine. Mimics a normal LinkedIn session before
// the first connection-request fires, so a batch session looks like a regular
// LinkedIn visit (that happens to include some outreach) rather than a bot run.
//
// Pattern simulated:
//   1. Open the feed → wait a few seconds (reading)
//   2. Scroll the feed 2-4 times with realistic pauses
//   3. Visit notifications page (very common human behavior)
//   4. Return to feed, scroll a bit more
//
// Total wall-clock: ~20-40 seconds. Adds that to the start of every batch.
// In return, LinkedIn sees a session that "looks like" the operator just opened
// LinkedIn for the day. Much harder to flag than: open browser → fire connect
// → close browser.
//
// Implements SOP 04 §"Behavioral signals" (warm-session pattern).
import { checkPageForKillSwitch } from './li_kill_switch.mjs';

const FEED_URL = 'https://www.linkedin.com/feed/';
const NOTIF_URL = 'https://www.linkedin.com/notifications/';

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the warm-up routine on the given page. Logs each step. Throws KillSwitchTriggered
 * if any of the navigated pages trips the safety check.
 *
 * @param {import('playwright').Page} page  pre-created page with the LI storage state loaded
 */
export async function warmSession(page) {
  console.log('🔥 warming session…');

  // 1. Feed visit + initial dwell
  await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await checkPageForKillSwitch(page);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await sleep(rand(3000, 7000));
  console.log('   ✓ feed loaded, dwelt');

  // 2. Scroll the feed a few times (mimics reading posts)
  const scrolls = rand(2, 4);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, rand(300, 800));
    await sleep(rand(1500, 3500));
  }
  console.log(`   ✓ scrolled feed ${scrolls}x`);

  // 3. Visit notifications (most-used LinkedIn page besides feed)
  await page.goto(NOTIF_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await checkPageForKillSwitch(page);
  await sleep(rand(2500, 5500));
  console.log('   ✓ notifications visited');

  // 4. Back to feed, one more scroll
  await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await checkPageForKillSwitch(page);
  await sleep(rand(2000, 4000));
  await page.mouse.wheel(0, rand(200, 500));
  await sleep(rand(1000, 2500));
  console.log('   ✓ back to feed, additional scroll');
}
