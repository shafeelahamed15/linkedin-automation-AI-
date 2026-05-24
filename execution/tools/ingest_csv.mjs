// Tool — pure CSV parsing + validation. No external I/O.
// Implements SOP 01 §"Inputs" and §"Behavior rules" 2, 4, 5.
import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';

export const REQUIRED_HEADERS = ['linkedin_url', 'first_name', 'last_name', 'company', 'title'];
export const OPTIONAL_HEADERS = ['email', 'industry', 'notes'];

/**
 * Normalize a LinkedIn profile URL per SOP 01 rule 4:
 *   strip query params, strip trailing slash, lowercase path.
 */
export function normalizeLinkedInUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url;
  try { url = new URL(raw.trim()); }
  catch { return null; }
  if (!/linkedin\.com$/i.test(url.hostname.replace(/^www\./, ''))) return null;
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  return `https://www.linkedin.com${path}`;
}

/**
 * Parse a CSV file and return { headers_ok, missing_headers, rows, row_errors }.
 * `rows` contains only rows that passed required-field validation.
 * Empty optional fields are returned as null (SOP 01 rule 5).
 */
export async function ingestCsv(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const records = parse(raw, {
    columns: (h) => h.map((c) => c.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  const headers = records.length ? Object.keys(records[0]) : [];
  const missing_headers = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing_headers.length) {
    return { headers_ok: false, missing_headers, rows: [], row_errors: [] };
  }

  const rows = [];
  const row_errors = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const missing = REQUIRED_HEADERS.filter((h) => !r[h] || !String(r[h]).trim());
    if (missing.length) {
      row_errors.push({ row: i + 2, reason: 'missing required: ' + missing.join(',') });
      continue;
    }
    const normalized_url = normalizeLinkedInUrl(r.linkedin_url);
    if (!normalized_url) {
      row_errors.push({ row: i + 2, reason: 'invalid linkedin_url: ' + r.linkedin_url });
      continue;
    }
    rows.push({
      linkedin_url: normalized_url,
      first_name: r.first_name.trim(),
      last_name:  r.last_name.trim(),
      company:    r.company.trim(),
      title:      r.title.trim(),
      email:      r.email?.trim()    || null,
      industry:   r.industry?.trim() || null,
      notes:      r.notes?.trim()    || null,
    });
  }
  return { headers_ok: true, missing_headers: [], rows, row_errors };
}
