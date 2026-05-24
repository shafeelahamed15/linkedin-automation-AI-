// Phase L probe — Slack
// Verifies SLACK_BOT_TOKEN can authenticate and post a "hello" message to the target channel.
import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_CHANNEL_ID;
if (!token)   { console.error('❌ SLACK_BOT_TOKEN missing in .env'); process.exit(1); }
if (!channel) { console.error('❌ SLACK_CHANNEL_ID missing in .env'); process.exit(1); }

const slack = new WebClient(token);

try {
  const auth = await slack.auth.test();
  console.log(`✅ Slack auth OK. Bot user: ${auth.user} in workspace ${auth.team}`);

  const post = await slack.chat.postMessage({
    channel,
    text: '✅ LinkedIn-Leads probe: Slack channel reachable.',
  });
  console.log(`✅ Posted test message to channel ${channel}. ts=${post.ts}`);
  process.exit(0);
} catch (err) {
  console.error('❌ Slack probe failed:', err?.data?.error ?? err?.message ?? err);
  if (err?.data?.error === 'not_in_channel') {
    console.error('   → Invite the bot to the channel: /invite @your-bot-name');
  }
  if (err?.data?.error === 'missing_scope') {
    console.error('   → Add scopes (chat:write, channels:read) and reinstall the app.');
  }
  process.exit(2);
}
