# SOP 01 — CSV Ingest

> **Layer A.** Governs how leads enter the pipeline.
> If logic changes, update this SOP **before** the code.

## Goal
Watch `./inbox/` for new `.csv` files. For each file:
1. Parse rows.
2. Validate required columns.
3. Upsert each row into the Notion `Leads` database, keyed by `linkedin_url`.
4. Hand each new row to the **ICP gate** (SOP 02) for status assignment.
5. Move the file to `./inbox/.processed/<timestamp>__<originalname>.csv`.

## Inputs
A CSV file in `./inbox/` with at minimum these columns (exact lowercase header names):

| Column | Required | Empty allowed? |
|---|---|---|
| `linkedin_url` | ✅ | no |
| `first_name` | ✅ | no |
| `last_name` | ✅ | no |
| `company` | ✅ | no |
| `title` | ✅ | no |
| `email` | optional | yes |
| `industry` | optional | yes |
| `notes` | optional | yes |

> Extra columns are ignored (logged once, then dropped).

## Outputs
- Notion record for each new `linkedin_url` (status set by SOP 02).
- Skipped row count, error count, processed file moved.

## Behavior rules
1. **Dedup by `linkedin_url`.** Already-existing rows → skip silently. Do **not** overwrite status/history.
2. **Required-column validation per row.** Any of the 5 required fields missing → row is rejected. Rejection is logged to `.tmp/ingest_errors/<timestamp>.json` but does **not** halt the file.
3. **Header validation per file.** Any required header missing → reject the entire file, move to `./inbox/.rejected/`, write reason to `.tmp/ingest_errors/`. Do **not** ingest any rows from a malformed file.
4. **`linkedin_url` normalization.** Strip query params and trailing slashes. Lowercase the path portion. Examples:
   - `https://www.linkedin.com/in/Jane-Doe-1234/?source=foo` → `https://www.linkedin.com/in/jane-doe-1234`
5. **Empty optional fields** → store as `null` in Notion (skip the property), not empty string.
6. **Atomic per-file processing.** Either all valid rows from a file land, or none. If Notion errors mid-file, the partial run is logged and the file is **not** archived (so it can be retried after fixing the Notion issue).
7. **`Name` column in Notion** is constructed as `"{last_name}, {first_name}"` (Notion title required exactly one title-typed property).

## Failure modes (populated as encountered)
*(none yet)*

## Cross-references
- Schema source of truth: `CLAUDE.md §6.1` (Input) and `§6.2` (Notion record)
- ICP gate that runs after ingest: `architecture/02_icp_gate.md`
- Tool: `execution/tools/ingest_csv.mjs`
- Navigator: `execution/nav/run_ingest.mjs`
