// Phase L setup — capture a real LinkedIn session for the Playwright driver.
// Opens a headed Chromium → user logs in manually (including any 2FA / CAPTCHA)
// → script waits until /feed/ is reached → saves cookies + storage state to
// linkedin_storage_state.json (gitignored). All future Playwright contexts load this state.
import { chromium } from '../tools/stealth_browser.mjs';

console.log('\n🌐 Launching browser. Please log in to LinkedIn manually.');
console.log('   - Solve any CAPTCHA / 2FA prompts in the window.');
console.log('   - Once your LinkedIn home feed loads, this script will save the session and exit.\n');

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 768 },
});
const page = await ctx.newPage();
await page.goto('https://www.linkedin.com/login');

// Wait (up to 5 min) for the user to land on the feed.
try {
  await page.waitForURL(/linkedin\.com\/(feed|in)/, { timeout: 5 * 60 * 1000 });
} catch {
  console.error('❌ Did not reach the LinkedIn feed within 5 minutes. Closing.');
  await browser.close();
  process.exit(2);
}

await ctx.storageState({ path: 'linkedin_storage_state.json' });
console.log('\n✅ Session saved to linkedin_storage_state.json');
console.log('👉 Verify with: npm run probe:linkedin');
await browser.close();
process.exit(0);
