# SOP 10 — Triggers (Phase T firing mechanism)

> **Layer A.** Documents WHEN the pipeline runs and HOW it's invoked.
> If a new schedule or firing mechanism is added, update this SOP **before** the code/config.

## Goal
The pipeline must run automatically during business hours, with no manual `npm run` required, and without spawning multiple long-lived processes. Per the operator's global rule: **one localhost on port 3000** (when needed), reused across runs.

## What runs and when

| Job | Cadence | Command | Why |
|---|---|---|---|
| **Ingest** | every 5 min (24/7) | `npm run ingest` | Catches new CSVs in `./inbox/` as soon as they're dropped. Safe to run after-hours because it only writes to Notion (no LinkedIn / email actions). |
| **Personalize** | every 15 min, **09:00–17:00 Mon–Fri ET** | `npm run personalize` | Refreshes `personalized_first_line` for any newly-queued leads. LLM-only, no outreach, safe to run any time but kept inside business hours to control costs. |
| **Send queue** | every 8–12 min, **09:00–17:00 Mon–Fri ET** | `npm run send` | Outbound actions. The safety gate inside `run_send_queue` is the second line of defense in case the scheduler misfires. |
| **Acceptance check** | every 30 min, **09:00–17:00 Mon–Fri ET** | `npm run check:acceptances` | Polls profiles of `connecting` leads to detect acceptance. Read-only; less aggressive than send-queue but still respects LOCK. Posts Slack alert + flips status to `connected` on success. |
| **Reply listener** | every 15 min, **09:00–17:00 Mon–Fri ET** | `npm run replies` | Polls LinkedIn `/messaging/` + Gmail for inbound replies on leads in `(connecting, messaged)`. Read-only; chains the Slack notifier in the same process so new replies surface to the operator within the run. Honors `REPLIES_SKIP_LI=true` to skip the LI browser if needed; otherwise polls live regardless of `DRY_RUN`. |

> 🛑 The pipeline's own safety gate (SOP 04) re-checks hours/weekends/caps/LOCK regardless of when the scheduler fires. The scheduler restricts the *window* of attempts; the safety gate enforces the *invariants*.

## How it's wired (Windows Task Scheduler)

Three named tasks, each pointing at the same wrapper script `scripts/run_job.ps1 <job-name>`. The wrapper:
1. Sets working directory to `D:\linkedin leads`
2. Writes a heartbeat to `.tmp/triggers/<job>.last.log`
3. Invokes the corresponding `npm run <job>` command
4. Captures stdout/stderr to `.tmp/triggers/<job>.YYYY-MM-DD.log`
5. Exits with the npm exit code (Task Scheduler can show failures)

Tasks are registered ONCE manually by the operator using the documented PowerShell snippet below (this is a system-level action, not auto-applied). The operator can also remove them with `Unregister-ScheduledTask`.

## DRY_RUN handling

The `.env` setting `DRY_RUN=true` is honored by all jobs. When the operator is ready for production, they:
1. Edit `.env` → `DRY_RUN=false`
2. The very next scheduled run will execute live (no scheduler reload needed — `.env` is read fresh each invocation).

## Monitoring

- **Per-run logs:** `.tmp/triggers/<job>.YYYY-MM-DD.log` — appended each run, one file per day
- **Heartbeat:** `.tmp/triggers/<job>.last.log` — overwritten each run, single line showing last successful timestamp
- **Failures:** any non-zero exit code is captured by Task Scheduler's History tab. The wrapper also re-prints the error to `.tmp/triggers/<job>.errors.log`.

## Stop conditions (operator manual actions)

- **Pause all sending immediately:** create an empty `LOCK` file at project root: `New-Item ./LOCK`. The safety gate (SOP 04) blocks all sends; ingest/personalize continue.
- **Pause everything:** disable the three scheduled tasks in Task Scheduler.
- **Unwind a misfire:** see `architecture/00_credentials.md` for how to rotate any credential; see SOP 05 for accidental-send recovery.

## Reference: register the scheduled tasks (PowerShell, run once as operator)

```powershell
# From the project root in an elevated PowerShell prompt.
cd "D:\linkedin leads"

# Tasks invoke wscript.exe + a VBS launcher (`scripts\run_job_hidden.vbs`) which
# in turn calls powershell.exe with WindowStyle=0. wscript is a GUI-subsystem
# binary that never allocates a console window, so unlike `powershell.exe
# -WindowStyle Hidden` (which still flashes briefly while the console host
# initializes), this is truly silent. See "Failure modes" §2026-05-21.
$vbs = '"D:\linkedin leads\scripts\run_job_hidden.vbs"'

# Ingest — every 5 min, 24/7
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ($vbs + ' ingest')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "LinkedinLeads-Ingest" -Action $action -Trigger $trigger -Description "Polls ./inbox/ for new CSVs and upserts into Notion"

# Personalize — every 15 min, business hours weekdays only
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ($vbs + ' personalize')
$trigger = New-ScheduledTaskTrigger -Daily -At 9am
$trigger.RepetitionInterval = (New-TimeSpan -Minutes 15)
$trigger.RepetitionDuration = (New-TimeSpan -Hours 8)
Register-ScheduledTask -TaskName "LinkedinLeads-Personalize" -Action $action -Trigger $trigger -Description "Refreshes Claude-personalized opening lines during business hours"

# Send queue — every 10 min, business hours weekdays only
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ($vbs + ' send')
$trigger = New-ScheduledTaskTrigger -Daily -At 9am
$trigger.RepetitionInterval = (New-TimeSpan -Minutes 10)
$trigger.RepetitionDuration = (New-TimeSpan -Hours 8)
Register-ScheduledTask -TaskName "LinkedinLeads-Send" -Action $action -Trigger $trigger -Description "Runs the outbound send queue; safety gate enforces dry-run, hours, caps, LOCK"

# Acceptance check — every 30 min during business hours (read-only)
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ($vbs + ' check:acceptances')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "LinkedinLeads-AcceptanceCheck" -Action $action -Trigger $trigger -Description "Polls connecting leads; flips status to connected + pings Slack on acceptance"

# Reply listener — every 15 min, business hours weekdays only (read-only LI + Gmail, chains Slack notifier)
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ($vbs + ' replies')
$trigger = New-ScheduledTaskTrigger -Daily -At 9am
$trigger.RepetitionInterval = (New-TimeSpan -Minutes 15)
$trigger.RepetitionDuration = (New-TimeSpan -Hours 8)
Register-ScheduledTask -TaskName "LinkedinLeads-Replies" -Action $action -Trigger $trigger -Description "Polls LI messaging + Gmail for replies; surfaces to Slack with Claude-drafted suggestion"
```

To remove later:
```powershell
Unregister-ScheduledTask -TaskName "LinkedinLeads-Ingest","LinkedinLeads-Personalize","LinkedinLeads-Send","LinkedinLeads-AcceptanceCheck","LinkedinLeads-Replies" -Confirm:$false
```

## Failure modes (populated as encountered)

### 2026-05-21 — Visible PowerShell window pops on every task fire
- **Symptom:** A `powershell.exe` console window kept appearing on the operator's screen throughout the day. Ingest runs every 5 min 24/7 → ~288 popups per day.
- **Root cause v1:** Original `Register-ScheduledTask` snippet did not include `-WindowStyle Hidden` in the powershell.exe arguments. Default Windows behavior is to show the console window.
- **Attempted fix:** Added `-WindowStyle Hidden` flag. **Still flashed briefly** — known Windows behavior: powershell.exe must allocate a console host (conhost.exe) before it can hide the window, leaving a ~100–300ms visible flash on every fire. Subjectively just as annoying as no flag at all.
- **Final fix:** Switched the task action from `powershell.exe` to `wscript.exe` invoking a VBS launcher (`scripts/run_job_hidden.vbs`). wscript.exe is a GUI-subsystem binary — it never allocates a console window in the first place. The VBS launcher uses `WScript.Shell.Run(cmd, 0, true)` where `0` = hidden window, `true` = wait for exit (so the task scheduler still sees the powershell exit code). Net effect: zero visible UI, exit codes flow through, logs continue to write normally.
- **Verification command:**
  ```powershell
  Get-ScheduledTask -TaskName 'LinkedinLeads-*' | ForEach-Object {
    Write-Host "$($_.TaskName): $($_.Actions[0].Execute) $($_.Actions[0].Arguments)"
  }
  ```
  Each line should show `wscript.exe "D:\linkedin leads\scripts\run_job_hidden.vbs" <job>`.
- **End-to-end verification performed:** triggered `LinkedinLeads-Ingest` manually. Result: `LastTaskResult=0`, daily log gained a fresh `----` header, heartbeat file updated with new exit-code line, no window appeared on screen.
