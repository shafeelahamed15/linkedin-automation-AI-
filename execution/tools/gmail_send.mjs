// Tool — atomic Gmail send. No business logic.
// Implements SOP 06 §"Send path".
import 'dotenv/config';
import { google } from 'googleapis';
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const FROM_NAME = process.env.OPERATOR_FIRST_NAME ?? 'Operator';
const FROM_EMAIL = process.env.GMAIL_USER ?? 'me';
const cid = process.env.GOOGLE_CLIENT_ID;
const csec = process.env.GOOGLE_CLIENT_SECRET;
const rtok = process.env.GOOGLE_REFRESH_TOKEN;

function gmailClient() {
  const oauth2 = new google.auth.OAuth2(cid, csec, 'urn:ietf:wg:oauth:2.0:oob');
  oauth2.setCredentials({ refresh_token: rtok });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function buildMimeMessage({ to, subject, body }) {
  const from = `${FROM_NAME} <${FROM_EMAIL}>`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function logDryRun(entry) {
  const day = new Date().toISOString().slice(0, 10);
  await mkdir('./.tmp/dry_run_log', { recursive: true });
  await appendFile(join('./.tmp/dry_run_log', `${day}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Send a plain-text email.
 * @param {{to: string, subject: string, body: string, lead_id?: string, dryRun: boolean}} args
 * @returns {Promise<{ok: boolean, kind: 'sent'|'dry-run', message_id?: string, reason?: string}>}
 */
export async function gmailSend({ to, subject, body, lead_id, dryRun }) {
  if (dryRun) {
    await logDryRun({ at: new Date().toISOString(), action: 'email', lead_id, to, subject, body });
    return { ok: true, kind: 'dry-run' };
  }
  try {
    const raw = buildMimeMessage({ to, subject, body });
    const gmail = gmailClient();
    const res = await gmail.users.messages.send({ userId: FROM_EMAIL, requestBody: { raw } });
    return { ok: true, kind: 'sent', message_id: res.data.id };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}
