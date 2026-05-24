// LinkedIn Leads dashboard — client renderer.
// Single fetch to /api/snapshot; auto-refresh every 30s; no framework.

const REFRESH_MS = 30_000;
const STATUS_ORDER = [
  'queued', 'connecting', 'connected', 'messaged',
  'replied', 'won', 'manual_review', 'muted', 'irrelevant', 'error',
];

let lastData = null;
let activeStatusFilter = 'all';
let expandedLead = null;

// ── Utilities ──────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}
function pct(n, d) { if (!d) return 0; return Math.min(100, Math.round((n / d) * 100)); }
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtRelative(iso) {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return Math.floor(diff) + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
function shortFutureRel(iso) {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  if (diff < 60) return 'in <1m';
  if (diff < 3600) return 'in ' + Math.floor(diff / 60) + 'm';
  if (diff < 86400) return 'in ' + Math.floor(diff / 3600) + 'h ' + Math.floor((diff % 3600) / 60) + 'm';
  return 'in ' + Math.floor(diff / 86400) + 'd';
}

// ── Render: top status pills ───────────────────────────────────
function renderPills(d) {
  const { safety } = d;
  const pipelinePill = $('pipeline-pill');
  if (safety.lock) {
    pipelinePill.textContent = 'HALTED — LOCK active';
    pipelinePill.className = 'pill pill-err';
  } else if (!safety.inWindow || safety.isWeekend) {
    pipelinePill.textContent = 'IDLE — out of window';
    pipelinePill.className = 'pill pill-muted';
  } else {
    pipelinePill.textContent = 'OPERATIONAL';
    pipelinePill.className = 'pill pill-ok';
  }

  const dryPill = $('dryrun-pill');
  if (safety.dryRun) {
    dryPill.textContent = 'DRY-RUN MODE';
    dryPill.className = 'pill pill-warn';
  } else {
    dryPill.textContent = 'LIVE';
    dryPill.className = 'pill pill-info';
  }

  const winPill = $('window-pill');
  if (safety.inWindow && !safety.isWeekend) {
    winPill.textContent = `Send window open (${safety.quietStart}:00–${safety.quietEnd}:00 ${safety.operatorTimezone})`;
    winPill.className = 'pill pill-info';
  } else {
    const next = safety.nextWindowOpenIso ? shortFutureRel(safety.nextWindowOpenIso) : '—';
    winPill.textContent = `Next window ${next}`;
    winPill.className = 'pill pill-muted';
  }
}

// ── Render: stat cards ─────────────────────────────────────────
function renderStats(d) {
  const { caps, acceptance } = d;
  function fill(used, capV, prefix) {
    $(prefix + '-used').textContent = used;
    $(prefix + '-cap').textContent  = capV;
    const remaining = Math.max(0, capV - used);
    $(prefix + '-remaining').textContent = remaining;
    const bar = $(prefix + '-bar');
    const p = pct(used, capV);
    bar.style.width = p + '%';
    bar.classList.remove('warn', 'danger');
    if (p >= 90) bar.classList.add('danger');
    else if (p >= 70) bar.classList.add('warn');
  }
  fill(caps.today.connection, caps.daily.connection, 'today-conn');
  fill(caps.today.dm,         caps.daily.dm,         'today-dm');
  fill(caps.week.connection,  caps.weekly.connection,'week-conn');

  // Acceptance card
  const sent7 = acceptance.sent7d ?? 0;
  const accepted7 = acceptance.accepted7d ?? 0;
  const rate = acceptance.rate ?? 0;
  $('accept-rate').textContent = sent7 >= 20 ? Math.round(rate * 100) + '%' : '—';
  $('accept-sub').textContent  = `${accepted7} accepted / ${sent7} sent (7d)` + (sent7 < 20 ? ' — sample <20, not yet rated' : '');
}

// ── Render: funnel ─────────────────────────────────────────────
function renderFunnel(d) {
  const counts = d.leads.byStatus;
  const max = Math.max(1, ...Object.values(counts));
  const funnelEl = $('funnel');
  funnelEl.innerHTML = '';
  for (const status of STATUS_ORDER) {
    const n = counts[status] ?? 0;
    if (n === 0 && status !== 'queued' && status !== 'connecting') continue;
    const row = el('div', { class: 'funnel-row' },
      el('span', { class: 'funnel-label' }, status),
      el('div', { class: 'funnel-bar' },
        el('div', { class: 'funnel-bar-fill c-' + status, style: `width: ${(n / max) * 100}%` }),
      ),
      el('span', { class: 'funnel-count' }, String(n)),
    );
    funnelEl.appendChild(row);
  }
}

// ── Render: safety state ───────────────────────────────────────
function renderSafety(d) {
  const { safety } = d;
  const items = [
    ['Send window',     safety.inWindow ? 'open' : 'closed',  safety.inWindow ? 'ok' : 'warn'],
    ['Weekend',         safety.isWeekend ? 'yes' : 'no',       safety.isWeekend ? 'warn' : 'ok'],
    ['LOCK file',       safety.lock ? 'present (halt)' : 'clear', safety.lock ? 'bad' : 'ok'],
    ['Operator time',   `${String(safety.operatorHour).padStart(2,'0')}:${String(safety.operatorMinute).padStart(2,'0')} ${safety.operatorTimezone}`, ''],
    ['DRY_RUN',         safety.dryRun ? 'true (safe)' : 'false (live)', safety.dryRun ? 'warn' : 'ok'],
    ['LinkedIn session', d.sessionFile ? `${d.sessionFile.bytes} bytes` : 'MISSING', d.sessionFile ? 'ok' : 'bad'],
    ['Acceptance health', d.acceptance.ok ? 'ok' : 'BAD', d.acceptance.ok ? 'ok' : 'bad'],
  ];
  if (!safety.inWindow && safety.nextWindowOpenIso) {
    items.push(['Next window opens', `${shortFutureRel(safety.nextWindowOpenIso)} (${fmtTime(safety.nextWindowOpenIso)})`, '']);
  }
  const list = $('safety-list');
  list.innerHTML = '';
  for (const [k, v, cls] of items) {
    list.appendChild(el('li', {},
      el('span', { class: 'kv-key' }, k),
      el('span', { class: 'kv-val ' + (cls || '') }, v),
    ));
  }
}

// ── Render: scheduled tasks ────────────────────────────────────
function renderTasks(d) {
  const tbody = document.querySelector('#tasks-table tbody');
  tbody.innerHTML = '';
  if (!d.tasks || d.tasks.length === 0) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: 4, class: 'empty' }, 'No LinkedinLeads-* tasks found')));
  } else {
    for (const t of d.tasks) {
      const stateLabel = String(t.state);
      const stateClass = stateLabel.toLowerCase() === 'ready' ? 'ok'
        : stateLabel.toLowerCase() === 'disabled' ? 'warn'
        : stateLabel.toLowerCase() === 'running' ? 'ok'
        : '';
      const lastResult = t.lastTaskResult;
      const resultLabel = lastResult === 0 ? '✓ 0'
        : lastResult === 267009 ? 'running'
        : lastResult == null ? '—'
        : '✗ ' + lastResult;
      const resultClass = lastResult === 0 ? 'ok' : (lastResult == null ? '' : 'bad');
      tbody.appendChild(el('tr', {},
        el('td', {}, t.name.replace(/^LinkedinLeads-/, '')),
        el('td', {}, el('span', { class: 'kv-val ' + stateClass }, stateLabel)),
        el('td', {}, el('span', { class: 'kv-val ' + resultClass }, resultLabel)),
        el('td', { class: 'num', style: 'color:var(--text-dim);font-size:11.5px' }, t.lastRunTime ? fmtRelative(t.lastRunTime) : '—'),
      ));
    }
  }
  // foot — heartbeats from .tmp/triggers
  const hb = d.heartbeats || {};
  const lines = Object.entries(hb).map(([job, h]) => `${job}: ${h.text} (${fmtRelative(h.mtime)})`);
  $('tasks-foot').textContent = lines.length ? lines.join(' · ') : 'no heartbeats yet';
}

// ── Render: activity feed ──────────────────────────────────────
function renderActivity(d) {
  const list = $('activity-list');
  list.innerHTML = '';
  if (!d.activity || d.activity.length === 0) {
    list.appendChild(el('li', { class: 'empty', style: 'border:none;background:none' }, 'No outbound or inbound activity yet'));
    return;
  }
  for (const e of d.activity) {
    const kindBadge = el('span', { class: 'activity-kind k-' + e.kind }, e.kind === 'sent' ? (e.type || 'sent') : 'reply');
    const body = el('div', { class: 'activity-body' });
    body.appendChild(kindBadge);
    body.appendChild(el('strong', {}, e.lead || '(unknown)'));
    body.appendChild(document.createTextNode(' · '));
    const muted = el('span', { class: 'muted' }, e.company || '');
    body.appendChild(muted);
    if (e.body) {
      body.appendChild(el('div', { style: 'color:var(--text-mute);font-size:11.5px;margin-top:3px' }, e.body));
    }
    list.appendChild(el('li', {},
      el('span', { class: 'activity-time' }, fmtRelative(e.at)),
      body,
    ));
  }
}

// ── Render: lead filter chips ──────────────────────────────────
function renderFilterChips(d) {
  const chipBar = $('status-filters');
  chipBar.innerHTML = '';
  const total = d.leads.total;
  const allChip = el('button', {
    class: 'filter-chip' + (activeStatusFilter === 'all' ? ' active' : ''),
    onclick: () => { activeStatusFilter = 'all'; renderLeads(lastData); renderFilterChips(lastData); },
  }, `all (${total})`);
  chipBar.appendChild(allChip);
  for (const s of STATUS_ORDER) {
    const n = d.leads.byStatus[s];
    if (!n) continue;
    chipBar.appendChild(el('button', {
      class: 'filter-chip' + (activeStatusFilter === s ? ' active' : ''),
      onclick: () => { activeStatusFilter = s; renderLeads(lastData); renderFilterChips(lastData); },
    }, `${s} (${n})`));
  }
}

// ── Render: leads table ────────────────────────────────────────
function renderLeads(d) {
  const trunc = d.leads.listTruncated ? ` — top ${d.leads.listCap} shown` : '';
  $('leads-count').textContent = d.leads.total + trunc;
  const tbody = $('leads-tbody');
  tbody.innerHTML = '';
  const leads = d.leads.list.filter(L =>
    activeStatusFilter === 'all' ? true : L.status === activeStatusFilter
  );
  // sort: queued first, then by last_action_at desc
  leads.sort((a, b) => {
    const sa = STATUS_ORDER.indexOf(a.status), sb = STATUS_ORDER.indexOf(b.status);
    if (sa !== sb) return sa - sb;
    return (b.last_action_at ?? '').localeCompare(a.last_action_at ?? '');
  });
  if (leads.length === 0) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, 'No leads match this filter')));
    return;
  }
  for (const L of leads) {
    const isExpanded = expandedLead === L.id;
    const row = el('tr', {
      onclick: () => { expandedLead = isExpanded ? null : L.id; renderLeads(lastData); },
      style: 'cursor:pointer',
      class: isExpanded ? 'expanded' : '',
    },
      el('td', {},
        el('span', { class: 'expand-toggle' }, isExpanded ? '▼' : '▶'),
        `${L.first_name} ${L.last_name}`,
      ),
      el('td', { style: 'color:var(--text-mute)' }, L.title || '—'),
      el('td', {}, L.company || '—'),
      el('td', {}, el('span', { class: 'badge s-' + L.status }, L.status)),
      el('td', { class: 'num' }, String(L.messages_count)),
      el('td', { class: 'num' }, String(L.replies_count)),
      el('td', { style: 'color:var(--text-dim);font-size:11.5px' }, L.last_action_at ? fmtRelative(L.last_action_at) : '—'),
    );
    tbody.appendChild(row);
    if (isExpanded) {
      const detail = el('tr', { class: 'lead-detail' },
        el('td', { colspan: 7 },
          el('div', { class: 'lead-detail-inner' },
            el('div', { class: 'lead-detail-row' },
              el('span', { class: 'label' }, 'LinkedIn'),
              el('a', { href: L.url, target: '_blank', rel: 'noopener' }, L.url || '—'),
            ),
            L.email ? el('div', { class: 'lead-detail-row' },
              el('span', { class: 'label' }, 'Email'),
              el('span', {}, L.email),
            ) : null,
            L.opener ? el('div', { class: 'lead-detail-row' },
              el('span', { class: 'label' }, 'Personalized opener'),
              el('div', { class: 'opener-note' }, L.opener),
            ) : el('div', { class: 'lead-detail-row' },
              el('span', { class: 'label' }, 'Personalized opener' ),
              el('span', { style: 'color:var(--text-dim)' }, '(none yet)'),
            ),
            L.error ? el('div', { class: 'lead-detail-row' },
              el('span', { class: 'label' }, 'Error'),
              el('span', { style: 'color:var(--red)' }, L.error),
            ) : null,
          ),
        ),
      );
      tbody.appendChild(detail);
    }
  }
}

// ── Render: footer ─────────────────────────────────────────────
function renderFooter(d) {
  $('operator-name').textContent = d.env.operatorFirstName || '—';
  $('notion-db-id').textContent = (d.env.notionDbId || '').slice(0, 8) + '…';
}

// ── Master render ──────────────────────────────────────────────
function renderAll(d) {
  lastData = d;
  renderPills(d);
  renderStats(d);
  renderFunnel(d);
  renderSafety(d);
  renderTasks(d);
  renderActivity(d);
  renderFilterChips(d);
  renderLeads(d);
  renderFooter(d);
  $('last-refresh').textContent = 'updated ' + fmtRelative(d.generatedAt);
}

// ── Fetch + loop ───────────────────────────────────────────────
async function fetchSnapshot() {
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderAll(data);
  } catch (e) {
    console.error('Snapshot fetch failed:', e);
    const pill = $('pipeline-pill');
    pill.textContent = 'CONNECTION LOST';
    pill.className = 'pill pill-err';
  }
}

function updateClock() {
  const now = new Date();
  const ist = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const et  = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  $('clock').textContent = `${ist} IST · ${et} ET`;
  if (lastData) $('last-refresh').textContent = 'updated ' + fmtRelative(lastData.generatedAt);
}

// ── Init ──────────────────────────────────────────────────────
$('refresh-btn').addEventListener('click', () => {
  $('refresh-btn').classList.add('spin');
  fetchSnapshot().finally(() => setTimeout(() => $('refresh-btn').classList.remove('spin'), 600));
});

fetchSnapshot();
setInterval(fetchSnapshot, REFRESH_MS);
updateClock();
setInterval(updateClock, 1000);
