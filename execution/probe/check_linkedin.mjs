// Phase L probe — LinkedIn (real account)
// Verifies a previously-captured browser session can load the LI feed without redirect to /login.
// Run AFTER `npm run linkedin:capture` has produced linkedin_storage_state.json.
import 'dotenv/config';
import { chromium } from '../tools/stealth_browser.mjs';
import { existsSync } from 'node:fs';

const STORAGE = 'linkedin_storage_state.json';
if (!existsSync(STORAGE)) {
  console.error(`❌ ${STORAGE} not found.`);
  console.error('   → Run: npm run linkedin:capture  (opens browser; log in manually; session saved)');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  storageState: STORAGE,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 768 },
});
const page = await ctx.newPage();

try {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const url = page.url();
  if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/uas/login')) {
    console.error('❌ LinkedIn session is stale or challenged. Redirected to:', url);
    console.error('   → Recapture session: npm run linkedin:capture');
    await browser.close();
    process.exit(2);
  }
  const title = await page.title();
  console.log(`✅ LinkedIn session valid. Page title: "${title}"`);
  console.log(`   final URL: ${url}`);
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error('❌ LinkedIn probe failed:', err?.message ?? err);
  await browser.close();
  process.exit(3);
}
