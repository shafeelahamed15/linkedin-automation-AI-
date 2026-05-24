// Tool — Gmail API poll: lists recent inbound messages from known senders.
// Returns ONLY raw parsed messages (no business logic, no Notion writes).
import 'dotenv/config';
import { google } from 'googleapis';

const cid  = process.env.GOOGLE_CLIENT_ID;
const csec = process.env.GOOGLE_CLIENT_SECRET;
const rtok = process.env.GOOGLE_REFRESH_TOKEN;
const user = process.env.GMAIL_USER ?? 'me';

function gmailClient() {
  const oauth2 = new google.auth.OAuth2(cid, csec, 'urn:ietf:wg:oauth:2.0:oob');
  oauth2.setCredentials({ refresh_token: rtok });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

/** Parses `From: "Name" <email@host>` and returns lowercased email. */
function extractEmail(fromHeader) {
  if (!fromHeader) return null;
  const m = fromHeader.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase().trim();
  if (/@/.test(fromHeader)) return fromHeader.toLowerCase().trim();
  return null;
}

/** Walk MIME parts; prefer text/plain. Decodes base64url. */
function extractPlainBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) {
      const txt = extractPlainBody(p);
      if (txt) return txt;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    return html.replace(/<style[\s\S]*?<\/style>/gi, '')
               .replace(/<script[\s\S]*?<\/script>/gi, '')
               .replace(/<[^>]+>/g, '')
               .replace(/&nbsp;/gi, ' ')
               .replace(/\s+/g, ' ')
               .trim();
  }
  return '';
}

/**
 * Fetch recent inbound messages (last 7 days, not from self).
 * Filtered to senders whose email is in the provided `knownEmails` set.
 *
 * @param {{since?: Date, knownEmails: Set<string>}} opts
 * @returns {Promise<Array<{message_id: string, gmail_id: string, from_email: string,
 *                         subject: string, body: string, at: string}>>}
 */
export async function gmailCheckInbox({ since, knownEmails }) {
  const gmail = gmailClient();
  const sinceSec = since ? Math.floor(since.getTime() / 1000) : Math.floor((Date.now() - 7*24*3600*1000) / 1000);
  // Gmail supports `after:` with epoch seconds.
  const q = `in:inbox -from:me after:${sinceSec}`;

  const list = await gmail.users.messages.list({ userId: user, q, maxResults: 50 });
  if (!list.data.messages) return [];

  const out = [];
  for (const ref of list.data.messages) {
    const msg = await gmail.users.messages.get({
      userId: user, id: ref.id, format: 'full',
    });
    const headers = Object.fromEntries((msg.data.payload?.headers ?? []).map(h => [h.name.toLowerCase(), h.value]));
    const fromEmail = extractEmail(headers['from']);
    if (!fromEmail || !knownEmails.has(fromEmail)) continue;
    out.push({
      message_id: headers['message-id'] || ref.id,
      gmail_id:   ref.id,
      from_email: fromEmail,
      subject:    headers['subject'] ?? '',
      body:       extractPlainBody(msg.data.payload).trim(),
      at:         new Date(parseInt(msg.data.internalDate, 10)).toISOString(),
    });
  }
  return out;
}
