// Navigator — orchestrates SOP 07 (connection acceptance detection).
// For every Notion lead with status='connecting':
//   1. Open their profile (stealth headed Chromium).
//   2. Inspect action-button state.
//   3. If accepted → update Notion, post Slack alert.
//   4. If withdrawn/declined → mark error.
//   5. If still pending → no-op.
import 'dotenv/config';
import { chromium } from '../tools/stealth_browser.mjs';
import { existsSync } from 'node:fs';

import { listLeadsByStatus } from '../tools/notion_list_leads_by_status.mjs';
import { updateLead, appendNote } from '../tools/notion_update_lead.mjs';
import { appendMessageSent } from '../tools/append_message_sent.mjs';
import { evaluateSafety, jitterMs } from '../tools/safety_guard.mjs';
import { checkInvitationState } from '../tools/li_check_invitations.mjs';
import { postBlocks, buildAcceptanceBlocks, notionPageUrl } from '../tools/slack_post.mjs';

const TIME_ZONE = process.env.OPERATOR_TIMEZONE || 'America/New_York';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Try to extract the "sent at" timestamp for a lead by parsing its messages_sent_json.
 * The most recent { kind: 'connection' } record's `at` is the answer.
 * Returns Date or null.
 */
function findConnectionSentAt(leadProps) {
  const raw = leadProps.messages_sent_json ?? leadProps.notes ?? '';
  // messages_sent_json isn't in the listLeadsByStatus default projection — fall back to last_action_at.
  if (leadProps.last_action_at) {
    const d = new Date(leadProps.last_action_at);
    if (!isNaN(d.getTime())) return d;
  }
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      const conns = arr.filter((m) => m?.kind === 'connection');
      const last = conns[conns.length - 1];
      if (last?.at) return new Date(last.at);
    } catch { /* fall through */ }
  }
  return null;
}

async function main() {
  const now = new Date();
  console.log(`🔍 ${now.toISOString()}  acceptance-check  tz=${TIME_ZONE}`);

  // Safety gate (we honor the same window as send-queue for behavioral consistency).
  const safety = evaluateSafety({ now, timeZone: TIME_ZONE, todayCounts: { connection: 0, dm: 0, email: 0 } });
  if (!safety.ok) {
    // LOCK is always-respected. Weekend/quiet-hours we soften — these are READS,
    // not sends. But we still pause on LOCK.
    if (existsSync('./LOCK')) {
      console.log('🛑 LOCK file present — acceptance-check skipped.');
      return;
    }
    // For weekend/quiet-hours, we read anyway. Just log it.
    console.log(`ℹ️  Safety gate flagged: ${safety.reasons.join('; ')} — proceeding anyway (read-only).`);
  }

  const leads = await listLeadsByStatus({ status: 'connecting', pageSize: 50 });
  if (!leads.length) {
    console.log('✅ No leads in `connecting` state — nothing to check.');
    return;
  }
  console.log(`📋 Checking ${leads.length} lead${leads.length > 1 ? 's' : ''}…\n`);

  const HEADLESS = (process.env.LI_HEADLESS ?? 'false').toLowerCase() === 'true';
  const sharedBrowser = await chromium.launch({ headless: HEADLESS });

  const summary = { accepted: 0, pending: 0, withdrawn: 0, errors: 0, unknown: 0 };

  try {
    for (const lead of leads) {
      const label = `${lead.props.first_name} ${lead.props.last_name} @ ${lead.props.company}`;
      console.log(`→ ${label}`);

      try {
        const res = await checkInvitationState({
          linkedin_url: lead.props.linkedin_url,
          lead_id: lead.id,
          first_name: lead.props.first_name,
          last_name: lead.props.last_name,
          sharedBrowser,
        });

        if (res.state === 'accepted') {
          summary.accepted++;
          const acceptedAt = new Date();
          const sentAt = findConnectionSentAt(lead.props) ?? acceptedAt;

          await appendMessageSent(lead.id, {
            channel: 'linkedin',
            kind: 'acceptance',
            at: acceptedAt.toISOString(),
            body: '',
          });
          await updateLead(lead.id, {
            status: 'connected',
            last_action_at: acceptedAt.toISOString(),
            last_channel: 'linkedin',
          });
          await appendNote(lead.id, `[acceptance: detected ${acceptedAt.toISOString()}]`);

          // Slack alert.
          const payload = buildAcceptanceBlocks({
            fullName: `${lead.props.first_name} ${lead.props.last_name}`,
            company: lead.props.company,
            title: lead.props.title,
            linkedinUrl: lead.props.linkedin_url,
            notionUrl: notionPageUrl(lead.id),
            sentAt,
            acceptedAt,
          });
          const slackRes = await postBlocks(payload).catch((e) => {
            console.log(`   ⚠️  Slack post failed: ${e?.message ?? e}`);
            return null;
          });
          console.log(`   🤝 ACCEPTED  (sent → accepted in ${Math.round((acceptedAt - sentAt) / 60000)}m)`);
          if (slackRes) console.log(`   📣 Slack ts=${slackRes.ts}`);
        } else if (res.state === 'pending') {
          summary.pending++;
          console.log(`   ⏳ still pending`);
        } else if (res.state === 'connect-back') {
          summary.withdrawn++;
          await updateLead(lead.id, { status: 'error', error: 'invitation-no-longer-pending' });
          await appendNote(lead.id, `[acceptance-check: withdrawn or declined (${new Date().toISOString()})]`);
          console.log(`   ❌ withdrawn/declined`);
        } else if (res.state === 'profile-not-found') {
          summary.errors++;
          await updateLead(lead.id, { status: 'error', error: 'profile-not-found' });
          await appendNote(lead.id, `[acceptance-check: profile not found]`);
          console.log(`   🟥 profile not found`);
        } else {
          summary.unknown++;
          console.log(`   ❓ unknown state: ${res.error ?? ''} ${res.screenshot ? '(' + res.screenshot + ')' : ''}`);
        }
      } catch (err) {
        if (err?.name === 'KillSwitchTriggered') {
          console.error(`\n🚨 KILL-SWITCH: ${err.reason}`);
          console.error(`   Screenshot: ${err.screenshot}`);
          console.error(`   LOCK written. Exiting batch.`);
          break;
        }
        summary.errors++;
        console.log(`   🟥 exception: ${err.message}`);
      }

      // Read-only pacing: 30-60s between profile loads (faster than send-queue's 60-180s).
      const jms = 30_000 + Math.floor(Math.random() * 30_000);
      console.log(`   ⏱  jitter ${(jms / 1000).toFixed(0)}s`);
      await sleep(jms);
    }
  } finally {
    await sharedBrowser.close().catch(() => {});
  }

  console.log('\n══════ ACCEPTANCE-CHECK SUMMARY ══════');
  console.log(`🤝 accepted:   ${summary.accepted}`);
  console.log(`⏳ pending:    ${summary.pending}`);
  console.log(`❌ withdrawn:  ${summary.withdrawn}`);
  console.log(`🟥 errors:     ${summary.errors}`);
  console.log(`❓ unknown:    ${summary.unknown}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FATAL:', err); process.exit(1); });
