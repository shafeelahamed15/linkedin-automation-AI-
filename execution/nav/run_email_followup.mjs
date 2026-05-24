// Navigator — orchestrates SOP 06 (Gmail follow-up).
// Picks leads eligible for an email follow-up, runs the safety gate, sends
// (or dry-runs), records the touch in messages_sent_json.
import 'dotenv/config';
import { Client } from '@notionhq/client';

import { listLeadsByStatus } from '../tools/notion_list_leads_by_status.mjs';
import { updateLead, appendNote } from '../tools/notion_update_lead.mjs';
import { appendMessageSent } from '../tools/append_message_sent.mjs';
import { countSentToday } from '../tools/lead_counts_today.mjs';
import { evaluateSafety, jitterMs, DAILY_CAPS } from '../tools/safety_guard.mjs';
import { gmailSend } from '../tools/gmail_send.mjs';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const TIME_ZONE = process.env.OPERATOR_TIMEZONE || 'America/New_York';
const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const FOLLOWUP_DELAY_DAYS = parseInt(process.env.EMAIL_FOLLOWUP_DELAY_DAYS ?? '5', 10);
const OPERATOR_NAME = process.env.OPERATOR_FIRST_NAME ?? 'Operator';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildEmailBody({ first_name, personalized_first_line }) {
  return [
    `Hi ${first_name},`,
    '',
    personalized_first_line.trim(),
    '',
    'I reached out on LinkedIn a few days back and wanted to land in your inbox in case it\'s easier. Happy to share a 30-second example of what this looks like for a club leader. Worth a brief chat?',
    '',
    'Best,',
    OPERATOR_NAME,
  ].join('\n');
}

/** Read messages_sent_json for a lead. */
async function getSentHistory(pageId) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const raw = page.properties.messages_sent_json?.rich_text?.[0]?.plain_text ?? '';
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function lastLinkedInTouchAt(history) {
  const linkedIn = history.filter((m) => m?.channel === 'linkedin' && m.at);
  if (!linkedIn.length) return null;
  return linkedIn.map((m) => new Date(m.at).getTime()).reduce((a, b) => Math.max(a, b), 0);
}

function alreadyEmailed(history) {
  return history.some((m) => m?.kind === 'email');
}

async function main() {
  const now = new Date();
  console.log(`📧 Email follow-up  (DRY_RUN=${DRY_RUN}, delay=${FOLLOWUP_DELAY_DAYS}d, tz=${TIME_ZONE})`);

  const todayCounts = await countSentToday(now, TIME_ZONE);
  console.log(`📊 today: emails=${todayCounts.email ?? 0}/${DAILY_CAPS.email}`);

  const safety = evaluateSafety({ now, timeZone: TIME_ZONE, todayCounts });
  if (!safety.ok) {
    console.log(`🛑 send blocked:`);
    for (const r of safety.reasons) console.log(`   - ${r}`);
    return;
  }
  if (safety.remaining.email <= 0) {
    console.log(`🛑 email cap reached for today (${todayCounts.email}/${DAILY_CAPS.email})`);
    return;
  }
  console.log(`🟢 safety gate passed. emails remaining today: ${safety.remaining.email}`);

  // Pull candidate leads (status in connecting | messaged)
  const candidates = [
    ...await listLeadsByStatus({ status: 'connecting', pageSize: 100 }),
    ...await listLeadsByStatus({ status: 'messaged',   pageSize: 100 }),
  ];

  const cutoffMs = Date.now() - FOLLOWUP_DELAY_DAYS * 24 * 3600 * 1000;
  const eligible = [];
  for (const lead of candidates) {
    if (!lead.props.email) continue;
    if (!lead.props.personalized_first_line) continue;
    const history = await getSentHistory(lead.id);
    if (alreadyEmailed(history)) continue;
    const lastLi = lastLinkedInTouchAt(history);
    if (lastLi == null) continue;
    if (lastLi > cutoffMs) continue;  // last LI touch is more recent than cutoff
    eligible.push({ lead, history });
  }

  if (!eligible.length) {
    console.log('💤 No leads eligible for email follow-up right now.');
    return;
  }
  console.log(`📨 ${eligible.length} eligible — sending up to ${safety.remaining.email}.`);

  let sent = 0, errors = 0, dry = 0;
  for (const { lead } of eligible.slice(0, safety.remaining.email)) {
    const label = `${lead.props.first_name} ${lead.props.last_name} → ${lead.props.email}`;
    console.log(`\n→ EMAIL  ${label}`);

    // Re-check caps each loop
    const recount = await countSentToday(new Date(), TIME_ZONE);
    if ((recount.email ?? 0) >= DAILY_CAPS.email) {
      console.log('   ⚠️ email cap reached mid-batch; stopping.');
      break;
    }

    const subject = `Quick follow-up — ${lead.props.company}`;
    const body = buildEmailBody({
      first_name: lead.props.first_name,
      personalized_first_line: lead.props.personalized_first_line,
    });

    try {
      const res = await gmailSend({ to: lead.props.email, subject, body, lead_id: lead.id, dryRun: DRY_RUN });
      if (!res.ok) {
        errors++;
        await appendNote(lead.id, `[email-followup: error ${res.reason}]`);
        console.log(`   🟥 error: ${res.reason}`);
        continue;
      }
      if (DRY_RUN || res.kind === 'dry-run') {
        dry++;
        console.log(`   🟡 dry-run logged.`);
      } else {
        sent++;
        const at = new Date().toISOString();
        await appendMessageSent(lead.id, {
          channel: 'email', kind: 'email', at,
          body: `subject="${subject}" message_id=${res.message_id}`,
        });
        await updateLead(lead.id, { last_action_at: at, last_channel: 'email' });
        await appendNote(lead.id, `[email-followup: sent ${res.message_id}]`);
        console.log(`   🟢 sent (message_id=${res.message_id})`);
      }
    } catch (err) {
      errors++;
      console.log(`   🟥 exception: ${err.message}`);
    }

    const jms = jitterMs();
    console.log(`   ⏱  jitter ${(jms / 1000).toFixed(1)}s`);
    if (!DRY_RUN) await sleep(jms);
  }

  console.log(`\n══════ EMAIL FOLLOWUP SUMMARY (DRY_RUN=${DRY_RUN}) ══════`);
  console.log(`emails sent:    ${sent}`);
  console.log(`dry-run logged: ${dry}`);
  console.log(`errors:         ${errors}`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
