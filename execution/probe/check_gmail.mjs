// Phase L probe — Gmail OAuth
// Verifies GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN can call gmail.users.getProfile.
import 'dotenv/config';
import { google } from 'googleapis';

const cid = process.env.GOOGLE_CLIENT_ID;
const csec = process.env.GOOGLE_CLIENT_SECRET;
const rtok = process.env.GOOGLE_REFRESH_TOKEN;
const user = process.env.GMAIL_USER ?? 'me';

if (!cid)  { console.error('❌ GOOGLE_CLIENT_ID missing in .env');     process.exit(1); }
if (!csec) { console.error('❌ GOOGLE_CLIENT_SECRET missing in .env'); process.exit(1); }
if (!rtok) {
  console.error('❌ GOOGLE_REFRESH_TOKEN missing.');
  console.error('   → Run: npm run gmail:authorize  (opens browser, completes OAuth, writes token)');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(cid, csec, 'urn:ietf:wg:oauth:2.0:oob');
oauth2.setCredentials({ refresh_token: rtok });

try {
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const prof = await gmail.users.getProfile({ userId: user });
  console.log(`✅ Gmail reachable.`);
  console.log(`   email: ${prof.data.emailAddress}`);
  console.log(`   messagesTotal: ${prof.data.messagesTotal}`);
  process.exit(0);
} catch (err) {
  console.error('❌ Gmail probe failed:', err?.message ?? err);
  process.exit(2);
}
