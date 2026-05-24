// Navigator — orchestrates SOP 07 (reply listener).
// Polls LI messaging + Gmail; matches new replies to leads in (connecting|messaged);
// appends to replies_json; transitions status (connected/replied/muted) per SOP 07.
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { listLeadsByStatus } from '../tools/notion_list_leads_by_status.mjs';
import { updateLead, appendNote } from '../tools/notion_update_lead.mjs';
import { appendReply } from '../tools/append_reply.mjs';
import { detectOptOut } from '../tools/detect_opt_out.mjs';
import { gmailCheckInbox } from '../tools/gmail_check_inbox.mjs';
import { liCheckInbox } from '../tools/li_check_inbox.mjs';
import { notifyPendingReplies } from './run_slack_notify.mjs';

const POLL_FILE = './.tmp/last_reply_poll.json';
// LI inbox polling is READ-ONLY (no outbound action), so we deliberately do NOT
// gate it on DRY_RUN. Set REPLIES_SKIP_LI=true to skip the LI browser launch
// (useful for Gmail-only smoke tests or while debugging Playwright issues).
const SKIP_LI = (process.env.REPLIES_SKIP_LI ?? 'false').toLowerCase() === 'true';

async function readLastPoll() {
  if (!existsSync(POLL_FILE)) return {};
  try { return JSON.parse(await readFile(POLL_FILE, 'utf8')); } catch { return {}; }
}
async function writeLastPoll(obj) {
  await mkdir('./.tmp', { recursive: true });
  await writeFile(POLL_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

/** Map status transition for a single lead based on a new reply. */
async function ingestReplyForLead(lead, reply) {
  const optOut = detectOptOut(reply.body);
  const { appended } = await appendReply(lead.id, {
    channel: reply.channel,
    at: reply.at,
    body: reply.body,
    message_id: reply.message_id,
    surfaced_to_slack_ts: null,
  });
  if (!appended) return { lead_id: lead.id, deduped: true };

  const nowIso = new Date().toISOString();
  if (optOut.matched) {
    await updateLead(lead.id, { status: 'muted', last_action_at: nowIso });
    await appendNote(lead.id, `[opt-out: ${optOut.keyword}]`);
    return { lead_id: lead.id, transition: 'muted', keyword: optOut.keyword };
  }
  await updateLead(lead.id, { status: 'replied', last_action_at: nowIso, last_channel: reply.channel });
  await appendNote(lead.id, `[reply: ${reply.channel}]`);
  return { lead_id: lead.id, transition: 'replied', channel: reply.channel };
}

async function main() {
  const lastPoll = await readLastPoll();
  const liSince    = lastPoll.linkedin ? new Date(lastPoll.linkedin) : new Date(Date.now() - 24*3600*1000);
  const gmailSince = lastPoll.gmail    ? new Date(lastPoll.gmail)    : new Date(Date.now() - 7*24*3600*1000);
  console.log(`📥 Reply-listener  (LI since ${liSince.toISOString()}, Gmail since ${gmailSince.toISOString()})`);

  // Combine leads in active outreach states. NOTE: `connected` must be included —
  // once LinkedinLeads-AcceptanceCheck flips a lead from connecting → connected,
  // the reply listener still needs to see their subsequent DMs.
  const connecting = await listLeadsByStatus({ status: 'connecting', pageSize: 100 });
  const connected  = await listLeadsByStatus({ status: 'connected',  pageSize: 100 });
  const messaged   = await listLeadsByStatus({ status: 'messaged',   pageSize: 100 });
  const active = [...connecting, ...connected, ...messaged];
  if (!active.length) {
    console.log('💤 No leads in (connecting|connected|messaged) — nothing to poll for.');
    await writeLastPoll({ linkedin: new Date().toISOString(), gmail: new Date().toISOString() });
    return;
  }
  console.log(`👥 ${active.length} leads in outreach (${connecting.length} connecting, ${connected.length} connected, ${messaged.length} messaged)`);

  // Build lookup structures
  const knownEmails = new Set(active.map((l) => l.props.email?.toLowerCase()).filter(Boolean));
  const knownNames  = active.map((l) => ({
    lead_id: l.id,
    full_name: `${l.props.first_name} ${l.props.last_name}`,
    linkedin_url: l.props.linkedin_url,
  }));
  const byId = new Map(active.map((l) => [l.id, l]));

  // 1. Gmail poll
  let gmailResults = [];
  if (knownEmails.size) {
    try {
      const msgs = await gmailCheckInbox({ since: gmailSince, knownEmails });
      console.log(`✉️  Gmail found ${msgs.length} message${msgs.length === 1 ? '' : 's'} from known senders.`);
      for (const m of msgs) {
        // Find lead whose email matches
        const lead = active.find((l) => l.props.email?.toLowerCase() === m.from_email);
        if (!lead) continue;
        const out = await ingestReplyForLead(lead, {
          channel: 'email', at: m.at, body: m.body, message_id: m.message_id,
        });
        gmailResults.push({ ...out, label: `${lead.props.first_name} ${lead.props.last_name}` });
      }
    } catch (err) {
      console.error('Gmail poll failed:', err.message);
    }
  } else {
    console.log('✉️  No leads have email addresses; skipping Gmail poll.');
  }

  // 2. LinkedIn poll
  let liResults = [];
  if (SKIP_LI) {
    console.log('⏭️  REPLIES_SKIP_LI=true → skipping LinkedIn inbox poll (no browser launched).');
  } else {
    try {
      const threads = await liCheckInbox({ knownLeads: knownNames, since: liSince, dryRun: false });
      console.log(`🤝 LinkedIn returned ${threads.length} thread${threads.length === 1 ? '' : 's'} from known leads.`);
      for (const t of threads) {
        const lead = byId.get(t.lead_id);
        if (!lead) continue;

        // NOTE: bare connection-acceptance detection used to live here, but that
        // transition is now owned by run_acceptance_check.mjs (which scans the
        // invitation-manager page directly). The reply listener only handles
        // inbound messages — if a thread exists with no new inbound, that's just
        // an old conversation we've already processed.
        for (const m of t.new_inbound_messages) {
          const out = await ingestReplyForLead(lead, {
            channel: 'linkedin', at: m.at, body: m.body, message_id: m.message_id,
          });
          liResults.push({ ...out, label: `${lead.props.first_name} ${lead.props.last_name}` });
        }
      }
    } catch (err) {
      if (err?.name === 'KillSwitchTriggered') {
        console.error(`\n🚨 KILL-SWITCH TRIGGERED: ${err.reason}`);
        console.error(`   Screenshot: ${err.screenshot}`);
      } else {
        console.error('LinkedIn poll failed:', err.message);
      }
    }
  }

  // 3. Persist high-water marks
  await writeLastPoll({
    linkedin: new Date().toISOString(),
    gmail:    new Date().toISOString(),
  });

  console.log('\n══════ REPLY-LISTENER SUMMARY ══════');
  console.log(`Gmail   → ${gmailResults.length} ingested`);
  for (const r of gmailResults) console.log(`   ${r.transition ?? 'deduped'}: ${r.label}${r.keyword ? ` (kw=${r.keyword})` : ''}`);
  console.log(`LinkedIn → ${liResults.length} ingested`);
  for (const r of liResults)    console.log(`   ${r.transition ?? 'deduped'}: ${r.label}${r.keyword ? ` (kw=${r.keyword})` : ''}`);

  // 4. Surface anything new to Slack in the same process. Catches replies that
  //    landed this run AND any prior runs that didn't get notified (Slack-down,
  //    Claude-down, etc.). Failures here don't fail the listener.
  console.log('\n──── Slack notifier (chained) ────');
  try {
    await notifyPendingReplies();
  } catch (err) {
    console.error('Slack notifier failed (continuing):', err?.message ?? err);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
