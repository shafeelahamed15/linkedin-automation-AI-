// Tool — atomic Slack post helpers. No business logic, no LLM.
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const CHANNEL = process.env.SLACK_CHANNEL_ID;

/**
 * Post a Block Kit message. Returns `{ ts, channel }` on success.
 * @param {{text: string, blocks: any[]}} payload
 */
export async function postBlocks({ text, blocks }) {
  const res = await slack.chat.postMessage({
    channel: CHANNEL,
    text,           // fallback for notification previews — required
    blocks,
    unfurl_links: false,
    unfurl_media:  false,
  });
  return { ts: res.ts, channel: res.channel };
}

/** Trim a body to `max` chars, adding ellipsis. */
export function trimBody(s, max = 800) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

/** Build a Notion page URL from a Notion page id. */
export function notionPageUrl(pageId) {
  const flat = pageId.replace(/-/g, '');
  return `https://www.notion.so/${flat}`;
}

/** Format a Date as "YYYY-MM-DD HH:mm" in America/New_York. */
function fmtET(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(',', '');
}

/**
 * Build a Block Kit payload for an "invitation accepted" event (SOP 07).
 * Returns { text, blocks } ready to pass to postBlocks().
 *
 * @param {Object} args
 * @param {string} args.fullName       e.g. "Karen Lang"
 * @param {string} args.company
 * @param {string} args.title
 * @param {string} args.linkedinUrl    canonical profile URL
 * @param {string} args.notionUrl      Notion page URL (built via notionPageUrl())
 * @param {Date}   args.sentAt         when we sent the connection request
 * @param {Date}   args.acceptedAt     when we detected acceptance
 */
export function buildAcceptanceBlocks({ fullName, company, title, linkedinUrl, notionUrl, sentAt, acceptedAt }) {
  const text = `🤝 ${fullName} accepted your connection request`;

  // Human-readable elapsed time, e.g. "5h 27m"
  const elapsedMs = Math.max(0, acceptedAt - sentAt);
  const hours = Math.floor(elapsedMs / 3_600_000);
  const minutes = Math.floor((elapsedMs % 3_600_000) / 60_000);
  const elapsedStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return {
    text,
    blocks: [
      { type: 'header',  text: { type: 'plain_text', text } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Company*\n${company || '—'}` },
          { type: 'mrkdwn', text: `*Title*\n${title || '—'}` },
        ],
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sent*\n${fmtET(sentAt)} ET` },
          { type: 'mrkdwn', text: `*Accepted*\n${fmtET(acceptedAt)} ET (${elapsedStr} later)` },
        ],
      },
      {
        type: 'actions',
        elements: [
          ...(notionUrl ? [{
            type: 'button',
            text: { type: 'plain_text', text: 'View in Notion' },
            url: notionUrl,
          }] : []),
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open LinkedIn profile' },
            url: linkedinUrl,
          },
        ],
      },
    ],
  };
}
