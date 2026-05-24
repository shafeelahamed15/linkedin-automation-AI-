// Navigator — orchestrates SOP 04 (send queue) + SOP 05 (LI driver).
// Pulls eligible leads, runs safety gate, dry-runs (default) or executes the
// next outbound action per lead, writes results to Notion.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../tools/stealth_browser.mjs';

import { listLeadsByStatus } from '../tools/notion_list_leads_by_status.mjs';
import { updateLead, appendNote } from '../tools/notion_update_lead.mjs';
import { appendMessageSent } from '../tools/append_message_sent.mjs';
import { countSentToday } from '../tools/lead_counts_today.mjs';
import { countSentInWindow } from '../tools/lead_counts_window.mjs';
import { evaluateSafety, jitterMs, DAILY_CAPS, WEEKLY_CAPS, checkLock } from '../tools/safety_guard.mjs';
import { evaluateAcceptanceHealth } from '../tools/acceptance_health.mjs';
import { postBlocks } from '../tools/slack_post.mjs';
import { sendConnection, buildConnectionNote } from '../tools/li_send_connection.mjs';
import { sendDm, buildDmBody } from '../tools/li_send_dm.mjs';
import { warmSession } from '../tools/li_warm_session.mjs';

const TIME_ZONE = process.env.OPERATOR_TIMEZONE || 'America/New_York';
const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const now = new Date();
  console.log(`🕒 ${now.toISOString()}  (DRY_RUN=${DRY_RUN}, tz=${TIME_ZONE})`);

  // 1. Pull today's + last-7-days counters from Notion.
  const todayCounts = await countSentToday(now, TIME_ZONE);
  const weekCounts  = await countSentInWindow(now, TIME_ZONE, 7);
  console.log(`📊 today: connections=${todayCounts.connection}/${DAILY_CAPS.connection}, dms=${todayCounts.dm}/${DAILY_CAPS.dm}`);
  console.log(`📊 last 7d: connections=${weekCounts.connection}/${WEEKLY_CAPS.connection}, dms=${weekCounts.dm}/${WEEKLY_CAPS.dm}, acceptances=${weekCounts.acceptance ?? 0}`);

  // 2. Acceptance-health auto-halt — if our 7-day accept rate is below threshold,
  //    write LOCK + ping Slack + abort. This catches LinkedIn shadow-throttles
  //    before they escalate into a full account flag.
  const health = await evaluateAcceptanceHealth(now, TIME_ZONE);
  if (!health.ok) {
    const lockBody = JSON.stringify({
      at: now.toISOString(),
      reason: 'acceptance-rate-auto-halt',
      detail: health.reason,
      sent7d: health.sent7d,
      accepted7d: health.accepted7d,
      rate: health.rate,
    }, null, 2);
    await writeFile('./LOCK', lockBody, 'utf8');
    console.error(`\n🚨 ACCEPTANCE-RATE AUTO-HALT: ${health.reason}`);
    console.error(`   sent7d=${health.sent7d}, accepted7d=${health.accepted7d}, rate=${(health.rate*100).toFixed(1)}%`);
    console.error(`   LOCK file written. Operator must investigate, delete LOCK, before any further sends.`);
    // Best-effort Slack ping (don't fail the halt if Slack is down)
    await postBlocks({
      text: `🚨 LinkedIn-Leads halted: ${health.reason}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🚨 Pipeline auto-halted' } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Reason*\n${health.reason}` } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Sent (7d)*\n${health.sent7d}` },
          { type: 'mrkdwn', text: `*Accepted (7d)*\n${health.accepted7d}` },
          { type: 'mrkdwn', text: `*Rate*\n${(health.rate*100).toFixed(1)}%` },
          { type: 'mrkdwn', text: `*Threshold*\n10%` },
        ] },
        { type: 'section', text: { type: 'mrkdwn', text: 'Pipeline halted via `./LOCK` file. Delete it manually after investigating.' } },
      ],
    }).catch((e) => console.error('   (Slack ping failed:', e.message, ')'));
    return;
  }
  if (health.sent7d > 0) {
    console.log(`💚 acceptance health OK: ${health.accepted7d}/${health.sent7d} = ${(health.rate*100).toFixed(1)}% (last 7d)`);
  }

  // 3. Run safety gate (LOCK / weekend / hours / daily caps / weekly caps).
  const safety = evaluateSafety({ now, timeZone: TIME_ZONE, todayCounts, weekCounts });
  if (!safety.ok) {
    console.log(`🛑 send blocked:`);
    for (const r of safety.reasons) console.log(`   - ${r}`);
    console.log(`💤 exiting without action.`);
    return;
  }
  console.log(`🟢 safety gate passed. remaining: conn=${safety.remaining.connection}, dm=${safety.remaining.dm}`);

  // 3. List eligible leads.
  const queuedLeads = safety.remaining.connection > 0
    ? await listLeadsByStatus({ status: 'queued',    pageSize: safety.remaining.connection })
    : [];
  const connectedLeads = safety.remaining.dm > 0
    ? await listLeadsByStatus({ status: 'connected', pageSize: safety.remaining.dm })
    : [];

  // Only leads with a non-empty personalized_first_line are sendable.
  const eligibleQueued    = queuedLeads.filter(l => l.props.personalized_first_line);
  const eligibleConnected = connectedLeads.filter(l => l.props.personalized_first_line);

  console.log(`📨 eligible: ${eligibleQueued.length} queued (→ connection), ${eligibleConnected.length} connected (→ dm)`);
  if (!eligibleQueued.length && !eligibleConnected.length) {
    console.log('💤 nothing to do.');
    return;
  }

  // 4. Process. In live mode we share one browser across the whole batch.
  let sharedBrowser = null;
  if (!DRY_RUN) {
    const HEADLESS = (process.env.LI_HEADLESS ?? 'false').toLowerCase() === 'true';
    sharedBrowser = await chromium.launch({ headless: HEADLESS });

    // Pre-send warm-up: feed + scroll + notifications + back-to-feed.
    // Makes the batch look like a normal LinkedIn visit, not a bot run.
    const warmupCtx = await sharedBrowser.newContext({
      storageState: 'linkedin_storage_state.json',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
    });
    const warmupPage = await warmupCtx.newPage();
    try {
      await warmSession(warmupPage);
    } catch (err) {
      if (err?.name === 'KillSwitchTriggered') {
        console.error(`\n🚨 KILL-SWITCH TRIGGERED during warm-up: ${err.reason}`);
        console.error(`   Aborting batch before any sends.`);
        await warmupCtx.close().catch(() => {});
        await sharedBrowser.close().catch(() => {});
        return;
      }
      console.log(`⚠️  warm-up exception (continuing anyway): ${err.message}`);
    }
    await warmupCtx.close().catch(() => {});
  }

  const summary = { connection_sent: 0, dm_sent: 0, dry: 0, errors: 0, skipped: 0 };

  try {
    // Connection requests first (more time-sensitive — must precede DMs)
    for (const lead of eligibleQueued) {
      const label = `${lead.props.first_name} ${lead.props.last_name} @ ${lead.props.company}`;
      console.log(`\n→ CONNECTION  ${label}`);

      // Mid-batch LOCK poll — fixes bug-log Gap 1. The operator can drop a LOCK
      // file at any time to halt the running batch; previously LOCK was only
      // honored at start of a new run.
      if (checkLock()) {
        console.error(`\n🛑 LOCK file detected mid-batch — aborting before next send.`);
        break;
      }

      // Re-check counts each loop (defensive — caps could have been hit by parallel runs).
      const recount = await countSentToday(new Date(), TIME_ZONE);
      if (recount.connection >= DAILY_CAPS.connection) {
        console.log(`   ⚠️ connection cap reached mid-batch; skipping rest.`);
        break;
      }

      try {
        const note = buildConnectionNote(lead.props.personalized_first_line);
        const res = await sendConnection({
          linkedin_url: lead.props.linkedin_url,
          note,
          lead_id: lead.id,
          first_name: lead.props.first_name,
          last_name:  lead.props.last_name,
          dryRun: DRY_RUN,
          sharedBrowser,
        });
        if (!res.ok) {
          summary.errors++;
          await updateLead(lead.id, { status: 'error', error: res.reason ?? 'unknown' });
          await appendNote(lead.id, `[send-connection: error ${res.reason}]`);
          console.log(`   🟥 error: ${res.reason}`);
          // NOTE: do NOT `continue` here — fall through so the jitter sleep runs.
          // Rapid back-to-back failures look exactly like bot behavior to LinkedIn
          // (this caused the 2026-05-20 incident where 8 failures fired in 3 minutes).
        } else if (DRY_RUN || res.kind === 'dry-run') {
          summary.dry++;
          console.log(`   🟡 dry-run logged. note="${note.slice(0, 80)}${note.length > 80 ? '…' : ''}"`);
        } else {
          summary.connection_sent++;
          const at = new Date().toISOString();
          await appendMessageSent(lead.id, { channel: 'linkedin', kind: 'connection', at, body: note });
          await updateLead(lead.id, { status: 'connecting', last_action_at: at, last_channel: 'linkedin' });
          await appendNote(lead.id, `[send-connection: ${res.kind}]`);
          console.log(`   🟢 ${res.kind}`);
        }
      } catch (err) {
        if (err?.name === 'KillSwitchTriggered') {
          console.error(`\n🚨 KILL-SWITCH TRIGGERED: ${err.reason}`);
          console.error(`   Screenshot: ${err.screenshot}`);
          console.error(`   LOCK file written. All future runs will refuse until LOCK is deleted.`);
          break;
        }
        summary.errors++;
        console.log(`   🟥 exception: ${err.message}`);
        // Same reasoning as the !res.ok branch: fall through to jitter sleep, do not skip.
      }

      // Jitter between sends — runs for successes, failures, AND exceptions.
      // Only skipped on KillSwitchTriggered (via the `break` above).
      const jms = jitterMs();
      console.log(`   ⏱  jitter ${(jms / 1000).toFixed(1)}s`);
      if (!DRY_RUN) await sleep(jms);  // skip the wait in dry-run to keep test runs fast
    }

    // DMs (connected → messaged)
    for (const lead of eligibleConnected) {
      const label = `${lead.props.first_name} ${lead.props.last_name} @ ${lead.props.company}`;
      console.log(`\n→ DM          ${label}`);

      if (checkLock()) {
        console.error(`\n🛑 LOCK file detected mid-batch — aborting before next DM.`);
        break;
      }

      const recount = await countSentToday(new Date(), TIME_ZONE);
      if (recount.dm >= DAILY_CAPS.dm) {
        console.log(`   ⚠️ DM cap reached mid-batch; skipping rest.`);
        break;
      }

      try {
        const body = buildDmBody(lead.props.personalized_first_line);
        const res = await sendDm({
          linkedin_url: lead.props.linkedin_url,
          body,
          lead_id: lead.id,
          dryRun: DRY_RUN,
          sharedBrowser,
        });
        if (!res.ok) {
          summary.errors++;
          await updateLead(lead.id, { status: 'error', error: res.reason ?? 'unknown' });
          await appendNote(lead.id, `[send-dm: error ${res.reason}]`);
          console.log(`   🟥 error: ${res.reason}`);
          // Same fall-through pattern as the connection loop — jitter must
          // run on failures too, so LinkedIn doesn't see rapid-fire requests.
        } else if (DRY_RUN || res.kind === 'dry-run') {
          summary.dry++;
          console.log(`   🟡 dry-run logged.`);
        } else {
          summary.dm_sent++;
          const at = new Date().toISOString();
          await appendMessageSent(lead.id, { channel: 'linkedin', kind: 'dm', at, body });
          await updateLead(lead.id, { status: 'messaged', last_action_at: at, last_channel: 'linkedin' });
          await appendNote(lead.id, `[send-dm: sent]`);
          console.log(`   🟢 sent`);
        }
      } catch (err) {
        if (err?.name === 'KillSwitchTriggered') {
          console.error(`\n🚨 KILL-SWITCH TRIGGERED: ${err.reason}`);
          break;
        }
        summary.errors++;
        console.log(`   🟥 exception: ${err.message}`);
      }

      const jms = jitterMs();
      console.log(`   ⏱  jitter ${(jms / 1000).toFixed(1)}s`);
      if (!DRY_RUN) await sleep(jms);
    }
  } finally {
    if (sharedBrowser) await sharedBrowser.close().catch(() => {});
  }

  console.log(`\n══════ SEND-QUEUE SUMMARY (DRY_RUN=${DRY_RUN}) ══════`);
  console.log(`connection sent: ${summary.connection_sent}`);
  console.log(`DM sent:         ${summary.dm_sent}`);
  console.log(`dry-run logged:  ${summary.dry}`);
  console.log(`errors:          ${summary.errors}`);
  console.log(`skipped:         ${summary.skipped}`);
  if (DRY_RUN) console.log(`\n📝 dry-run details written to .tmp/dry_run_log/${new Date().toISOString().slice(0,10)}.jsonl`);
}

// Explicit exit on both paths — a dangling Playwright browser handle (rare but
// possible) can otherwise keep the process alive and freeze the scheduler.
main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FATAL:', err); process.exit(1); });
