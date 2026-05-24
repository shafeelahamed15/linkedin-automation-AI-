// Phase L setup — Gmail OAuth refresh-token issuance.
// Opens a browser → user grants Gmail send/read scopes → we exchange the
// auth code for a refresh token and PRINT it. User pastes into .env as GOOGLE_REFRESH_TOKEN.
import 'dotenv/config';
import { google } from 'googleapis';
import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';

const cid  = process.env.GOOGLE_CLIENT_ID;
const csec = process.env.GOOGLE_CLIENT_SECRET;
if (!cid || !csec) {
  console.error('❌ GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first.');
  console.error('   → Create OAuth client at https://console.cloud.google.com/apis/credentials');
  console.error('   → App type: "Desktop app" (simplest) OR "Web application" with redirect http://localhost:3000/oauth2callback');
  process.exit(1);
}

const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const oauth2 = new google.auth.OAuth2(cid, csec, REDIRECT);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',        // forces refresh_token to be returned
  scope: SCOPES,
});

console.log('\n👉 Opening browser for Google sign-in.');
console.log('   If it does not open, paste this URL manually:\n');
console.log('   ' + authUrl + '\n');

// Cross-platform "open" — falls back to printing the URL if it fails.
const opener = process.platform === 'win32' ? `start "" "${authUrl}"`
             : process.platform === 'darwin' ? `open "${authUrl}"`
             : `xdg-open "${authUrl}"`;
exec(opener, () => {});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== '/oauth2callback') { res.writeHead(404); return res.end('not found'); }
  const code = u.searchParams.get('code');
  if (!code) { res.writeHead(400); return res.end('no code'); }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>✅ Auth complete. You can close this tab.</h2>');
    console.log('\n✅ Got tokens. Refresh token:\n');
    console.log('   GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
    console.log('👉 Paste the line above into your .env, then run: npm run probe:gmail');
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500); res.end('token exchange failed: ' + err.message);
    console.error('❌ Token exchange failed:', err.message);
    server.close();
    process.exit(2);
  }
});

server.listen(PORT, () => {
  console.log(`Listening for Google callback on http://localhost:${PORT}/oauth2callback`);
});
