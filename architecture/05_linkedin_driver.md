# SOP 05 — LinkedIn Playwright Driver

> **Layer A.** Defines exactly how the headless Chromium driver acts on
> linkedin.com. Every selector, every wait, every kill-switch trigger is
> documented here. Code in `execution/tools/li_send_*.mjs` MUST follow this
> SOP; any selector change requires updating this doc first.

## Goal
Two outbound actions on real LinkedIn pages without triggering bot detection:
1. **Send connection request** (with personalized note ≤ 300 chars)
2. **Send direct message** (after the connection is accepted)

Plus one defensive read:
3. **Kill-switch check** — detect 429/CAPTCHA/security-challenge pages

## Common behaviors (every action)

1. Always reuse the saved session via `storageState: 'linkedin_storage_state.json'`.
2. User-agent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/131.0.0.0` (matches the capture session).
3. Viewport: `1366 × 768`.
4. Headless: **true** (we're not testing visually; only the driver needs to run).
5. Before navigation, sleep `1500–4000ms` (human-like page-switch delay).
6. After clicking any interactive element, sleep `800–2200ms` before the next click.
7. Type text with `page.type(selector, text, { delay: 30–80ms per char })` — never `page.fill` for text inputs (`fill` is instant, looks robotic).
8. After every navigation, the **kill-switch check** runs. If any of the trigger conditions hit, the action **aborts** and writes the `LOCK` file (see "Kill-switch" below).

## Action 1 — Send Connection Request

### Selectors (current as of 2026-05)
Modern LinkedIn profile pages have multiple paths to "Connect"; the driver uses fall-throughs.
**Critical scoping rule (added 2026-05-19):** every Connect-related locator MUST be scoped to the **profile card** (the `main section` containing the lead's `h1`) OR explicitly verified by matching the lead's display name in the button's `aria-label`. The Connect text alone appears in the "People you may know" sidebar — clicking those sends a request to the wrong person.

| Step | Primary selector | Fallback |
|---|---|---|
| Read displayed name (for verification) | `main section h1` first text | — |
| Wait for profile heading | `main section h1` containing any of `{first_name}` or `{last_name}` | `[data-anonymize="person-name"]` |
| Primary "Connect" button | `<profile-card-locator> >> button[aria-label*="Invite"][aria-label*="connect" i]` AND aria-label must contain `displayedName` | `<profile-card-locator> >> button:has-text("Connect")` with aria-label verification |
| Overflow menu (if Connect not primary) | `<profile-card-locator> >> button[aria-label*="More actions"]` then `[role="menu"] >> text=/^Connect$/i` in popover | — |
| Modal — "Add a note" button | `[role="dialog"] >> button:has-text("Add a note")` | `text=/^Add a note$/i` |
| Modal — note textarea | `#custom-message` | `textarea[name="message"]` |
| Modal — "Send" / "Send invitation" | `[role="dialog"] >> button:has-text("Send")` | `button:has-text("Send invitation")` |
| Success indicator | `<profile-card-locator> >> text=/^Pending$/i` within 12s | toast `text=/invitation sent/i` OR primary Connect button changes/disappears |

**Verification step before any click:** read the matched button's `aria-label`. Confirm it contains the displayedName. If it does not, abort with reason `wrong-button-match-prevented` and write a screenshot — **do not click**.

### Steps
1. `goto(lead.linkedin_url)` (the normalized profile URL from ingest)
2. Kill-switch check
3. Click "Connect" (try primary; if not visible, open More menu and click "Connect" there)
4. Wait for the modal (`role=dialog`)
5. Click "Add a note"
6. Type the note assembled by `buildConnectionNote()` (see below) — typed at human cadence
7. Click "Send" / "Send invitation"
8. Confirm success indicator within 10s

### Note format (chosen 2026-05-20)

The connection-request note is the **personalized opener + tight CTA + signature**, all assembled at send time. LinkedIn's hard limit is 300 chars; we cap at 280 for headroom. Format:

```
{personalized_first_line}

Worth a quick chat? — <OPERATOR_FIRST_NAME>
```

- CTA + signature reserves ~31 chars; the opener gets up to ~249 chars.
- If the opener exceeds its budget, `buildConnectionNote()` truncates at a word boundary and appends `…`.
- The longer DM body (with "Happy to share a 30-second example..." sentence + "Best,\n<OPERATOR_FIRST_NAME>" multi-line signature) is reserved for after the connection is accepted — see Action 2 below.

**Rationale:** putting the full CTA in the connection note is a "one-shot pitch" strategy — even if the lead doesn't proceed to a DM thread, they've already seen our value-prop. Trade-off vs. opener-only: ~10 percentage points lower accept rate, but higher direct-reply rate from accepts.

### Edge cases & their actions
| Condition | Action |
|---|---|
| LinkedIn says "Connect" button missing → profile is private/anonymized | Skip lead, status → `error`, error msg = `connect-button-missing` |
| LinkedIn shows a "withdraw" / "Pending" — request already exists | Skip lead, status → `connecting` (treat as already done) |
| LinkedIn says "We've added context to your invitation to help [lead] decide" | Proceed — this is just the new modal copy |
| LinkedIn asks for the lead's email to verify the connection | Skip lead, status → `manual_review`, error = `email-verification-required` |
| Anything else / unknown DOM state | Screenshot to `.tmp/li_screenshots/<lead_id>__<timestamp>.png`. Skip lead. Status → `error`. |

## Action 2 — Send Direct Message

> **Only invoked when `status = connected`.**

### Selectors
| Step | Primary | Fallback |
|---|---|---|
| Profile page Message button | `button[aria-label^="Message"]` | `a:has(span:has-text("Message"))` |
| Compose box textarea | `div[role="textbox"][contenteditable="true"]` inside the message overlay | `.msg-form__contenteditable` |
| Send button | `button.msg-form__send-button` | `button[aria-label="Send now"]` |

### Steps
1. `goto(lead.linkedin_url)`
2. Kill-switch check
3. Click "Message" — opens the bottom-right messaging overlay
4. Wait for the textarea (`role=textbox`)
5. Type the DM body using the template (see below)
6. Click Send (or `Ctrl+Enter` if button selector fails)
7. Confirm: the just-sent message appears in the conversation thread within 5s

### DM body template (assembled at send-time)

```
{personalized_first_line}

Happy to share a 30-second example of what this looks like for a club leader.
Worth a quick chat?

Best,
<OPERATOR_FIRST_NAME>
```

The first paragraph is the per-lead `personalized_first_line` from SOP 03.
The rest is identical across leads.

## Action 3 — Kill-Switch Check (runs after every navigation)

The driver inspects the current page for any of these telltales:

| Trigger | Detection |
|---|---|
| **429 rate-limit page** | Page title contains `Too Many Requests` OR URL contains `/uas/login` OR `/error` |
| **CAPTCHA** | DOM contains `iframe[src*="recaptcha"]` OR an element with text matching `/please verify|prove you('re| are) human/i` |
| **Security challenge** | URL contains `/checkpoint/` OR `/security/` OR page contains text matching `/restricted some account features|we've detected unusual activity/i` |
| **Logged out** | URL redirected to `/login` OR `/uas/login` OR `linkedin.com/feed` reachable test fails |

On any trigger:
1. Take a screenshot to `.tmp/li_safety_alerts/<timestamp>.png`
2. Write `./LOCK` containing `{ at: now, reason: <trigger>, screenshot: <path> }` (JSON)
3. Throw `KillSwitchTriggered` — the navigator catches this, posts a 🚨 to Slack, and exits.
4. **All future runs refuse to start** while `./LOCK` exists. The operator must
   delete `./LOCK` manually after investigating.

## Browser lifecycle

- **One browser per navigator invocation.** The navigator opens one browser, processes the entire batch, closes it. We do NOT open a fresh browser per lead.
- **One context** per browser, with the storage state loaded once.
- **One page** per action (we close and re-open per lead to avoid the same-tab state lingering).

## Failure modes (populated as encountered)

### 2026-05-19 — Broad Connect selector clicked sidebar suggestions
- **Symptom:** Driver appeared to "click Connect" but the modal never appeared. Failure screenshot showed the lead's profile unchanged, but a sidebar "People you may know" entry had silently flipped to "Pending".
- **Root cause:** The selector `button:has-text("Connect"), button[aria-label*="Invite"][aria-label*="connect"]` matched ALL Connect buttons on the page in DOM order. The first match was usually a sidebar suggestion. Clicking it sent a real connection request to the wrong person.
- **Impact:** During the first live test, two unintended connection requests were sent (to "Andy Low" and "Riccardo Leone"). Both were withdrawn manually by the operator. **No lasting damage** because the recipients had not yet accepted.
- **Fix (in `execution/tools/li_send_connection.mjs`):**
  1. Read the displayed name from `main section h1`.
  2. Scope all Connect search to the `main section` containing that h1.
  3. Re-verify before clicking: matched button's `aria-label` MUST contain the displayed name. If not, abort with reason `wrong-button-match-prevented`.
  4. Same scoping for the More-menu fallback path.

### 2026-05-19 — Some profiles have no primary Connect (only "More")
- **Symptom:** No Connect button in the primary toolbar; only "More". Bruce Allen Hartrich's profile was the example.
- **Cause:** LinkedIn hides the primary Connect button when (a) the operator hasn't viewed the profile recently, (b) the lead has restrictive connection-request settings, or (c) the lead is 2nd/3rd-degree and LI wants a "More" gate first.
- **Fix:** The driver must always check the More menu when the primary Connect is missing. When the More-menu Connect is clicked, LinkedIn often shows a modal asking for the lead's email to verify the connection — handled by the existing `email-verification-required` edge case (status → `manual_review`).

### 2026-05-19 — LinkedIn served a stripped DOM to headless Chromium
- **Symptom:** Running `chromium.launch({ headless: true })` against a profile returned a page with ZERO `h1` elements and only ~13 buttons (mostly profile-edit affordances, not action buttons).
- **Root cause (partially revised — see 2026-05-20 update):** LinkedIn detected headless Chromium and degraded the DOM.
- **Fix (Phase S, completed 2026-05-20):** Added `playwright-extra` + `puppeteer-extra-plugin-stealth`. Single source of truth is `execution/tools/stealth_browser.mjs`. All LI-touching files now import `chromium` from there. Verified via bot.sannysoft.com audit:
  - `navigator.webdriver` is now `false` (was `true`)
  - `navigator.plugins.length` is now `3` (was `0`)
  - `navigator.languages` populated (was empty)
- **Status:** stealth is verified at the browser-detection layer. Headless feed loads cleanly.

### 2026-05-20 — Burner-account-restricted profile rendering (NOT anti-bot)
- **Symptom:** Even with stealth-equipped headless, Bruce Allen Hartrich's profile still renders without `<h1>` and without a primary Connect button. Only sidebar "People you may know" Connect buttons appear.
- **Root cause:** This is NOT bot detection. Bruce is a 3rd+ degree connection AND the burner account has thin profile completeness (no posts, few connections, sparse bio). LinkedIn restricts what low-trust accounts can see on out-of-network profiles, replacing actions with a "complete your profile" upsell.
- **Implications:**
  - **Bruce specifically is not a good first-send test.** Pick a 1st or 2nd degree connection for the initial supervised send.
  - **Burner warmup matters:** post 2-3 times, add some connections manually, complete the profile before relying on the burner for cold outreach.
- **Phase-S TODO:** consider building a `burner_warmup.md` SOP that codifies the warm-up routine.

## Cross-references
- Session capture: `execution/setup/linkedin_capture_session.mjs`
- Session probe: `execution/probe/check_linkedin.mjs`
- Send-queue rules: `architecture/04_send_queue.md`
- Tools: `execution/tools/li_send_connection.mjs`, `execution/tools/li_send_dm.mjs`, `execution/tools/li_kill_switch.mjs`
