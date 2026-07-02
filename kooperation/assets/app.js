// ============================================
// lifetimemiri – Kooperationen (Marken/Produkte)
// Alle Inhalte kommen aus der DB (Tabelle: kooperationen).
// Nichts Fachliches ist hier hartkodiert – nur Status/Modell-Vokabular,
// das mit der DB (CHECK-Constraints) und der Hotels-Seite geteilt wird.
// ============================================

const SUPABASE_URL = 'https://lepvxvjvaxnytxrgcpxx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_hsXVsENQLILd9QoeVN_hBw_nVdQpNYE';
// NOTE: client must NOT be named `supabase` — collides with window.supabase (UMD).
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Status: aus der DB (Tabelle status_defs), geteilt mit der Hotels-Seite ----
// Wird in loadStatusDefs() vor dem ersten Render befuellt.
let STATUS = {};
let STATUS_KEYS = [];

const LEGEND = [
  ['offen', 'Recherchiert, aber noch KEIN Entwurf — hier muss noch eine Anfrage vorbereitet werden.'],
  ['entwurf', 'Entwurf liegt fertig in Gmail, noch nicht gesendet — die Sende-Liste.'],
  ['angefragt', 'Anfrage gesendet, wartet auf Antwort der Marke.'],
  ['zusage', 'Marke hat positiv geantwortet, Kooperation in Verhandlung (noch nicht final).'],
  ['wiedervorlage', 'Temporär vertagt (kein Budget/Timing) — später erneut anfragen.'],
  ['warten', 'Zurückgestellt: gleiche Marke/Konzern schon in Kontakt (Doppelkontakt-Schutz).'],
  ['kooperiert', 'Kooperation abgeschlossen / läuft — aktiver Partner.'],
  ['antwort_negativ', 'Endgültig abgelehnt.'],
  ['ausgeschlossen', 'Passt nicht (falsches Segment) oder Doppeleintrag.'],
];

// ---- Modell-Vokabular: passt zu den DB-CHECK-Werten ----
const MODELL = {
  bezahlt: 'Bezahlt',
  seeding: 'Seeding (Gratisprodukt)',
  barter:  'Barter (Tausch)',
  mix:     'Mix (Geld + Produkt)',
};
const MODELL_KEYS = Object.keys(MODELL);

// ---- State ----
let allKoops = [];
let sortKey = 'marke';
let sortDir = 1;
let editId = null; // null = neu, sonst id der bearbeiteten Zeile
const HIDE_BY_DEFAULT = ['kooperiert', 'ausgeschlossen', 'antwort_negativ'];

// ---- Elements ----
const $ = (id) => document.getElementById(id);
const authView = $('auth-view');
const appView = $('app-view');
const tbody = $('koop-body');

// ===================== AUTH (E-Mail Einmal-Code + Turnstile) =====================
function authMsg(text, kind) {
  const m = $('auth-msg');
  m.textContent = text;
  m.className = 'text-xs mt-3 ' + (kind === 'error' ? 'text-red-600' : kind === 'ok' ? 'text-green-600' : 'text-zinc-500');
  m.classList.remove('hidden');
}
function getCaptchaToken() {
  return (typeof turnstile !== 'undefined' && turnstile.getResponse()) || null;
}
function resetCaptcha() {
  if (typeof turnstile !== 'undefined') turnstile.reset();
}

$('request-code-btn').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!email) { authMsg('Bitte E-Mail eingeben.', 'error'); return; }
  const captchaToken = getCaptchaToken();
  if (!captchaToken) { authMsg('Sicherheitsprüfung lädt noch, kurz warten.', 'error'); return; }
  const btn = $('request-code-btn');
  btn.disabled = true; btn.textContent = 'Sende Code…';
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, captchaToken } });
  resetCaptcha();
  btn.disabled = false; btn.textContent = 'Code per E-Mail anfordern';
  if (error) { authMsg('Fehler: ' + error.message, 'error'); return; }
  $('step-email').classList.add('hidden');
  $('code-form').classList.remove('hidden');
  $('code').focus();
  authMsg('Code gesendet. Gib den 6-stelligen Code aus der E-Mail ein.', 'ok');
});

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  const token = $('code').value.trim();
  if (!email || !token) return;
  const btn = $('verify-code-btn');
  btn.disabled = true; btn.textContent = 'Prüfe…';
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) {
    btn.disabled = false; btn.textContent = 'Anmelden';
    authMsg('Code ungültig oder abgelaufen: ' + error.message, 'error');
    return;
  }
  location.reload();
});

$('back-to-email').addEventListener('click', () => {
  $('code-form').classList.add('hidden');
  $('step-email').classList.remove('hidden');
  $('auth-msg').classList.add('hidden');
});

$('logout-btn').addEventListener('click', async () => { await sb.auth.signOut(); });

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') showAuth();
});

function showAuth() {
  authView.classList.remove('hidden');
  appView.classList.add('hidden');
  $('step-email').classList.remove('hidden');
  $('code-form').classList.add('hidden');
}

let appLoaded = false;
function showApp(user) {
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  $('user-email').textContent = user.email;
  if (appLoaded) return;
  appLoaded = true;
  setTimeout(async () => { await loadStatusDefs(); fillStatusSelect(); loadKoops(); }, 0);
}

// ===================== DATA =====================
// Status-Vokabular aus der DB laden (einzige Quelle, geteilt mit Hotels).
async function loadStatusDefs() {
  const { data, error } = await sb
    .from('status_defs')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) { console.error(error); alert('Fehler beim Laden der Status: ' + error.message); return; }
  STATUS = {};
  (data || []).forEach((s) => { STATUS[s.key] = { label: s.label, cls: s.cls }; });
  STATUS_KEYS = (data || []).map((s) => s.key);
}

async function loadKoops() {
  const { data, error } = await sb
    .from('kooperationen')
    .select('*')
    .order('marke', { ascending: true });
  if (error) { console.error(error); alert('Fehler beim Laden: ' + error.message); return; }
  allKoops = data || [];
  buildFilters();
  buildDatalists();
  renderLegend();
  render();
}

async function updateStatus(id, status) {
  const { error } = await sb.from('kooperationen').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) { alert('Konnte Status nicht speichern: ' + error.message); return false; }
  const k = allKoops.find((x) => x.id === id);
  if (k) k.status = status;
  renderSummary();
  return true;
}

// ===================== FILTERS (alle Optionen aus der DB abgeleitet) =====================
function buildFilters() {
  $('filter-status').innerHTML = '<option value="">Alle Status</option>' +
    STATUS_KEYS.map((k) => `<option value="${k}">${STATUS[k].label}</option>`).join('');

  const uebergruppen = [...new Set(allKoops.map((k) => k.uebergruppe).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('filter-uebergruppe').innerHTML = '<option value="">Alle Gruppen</option>' +
    uebergruppen.map((g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join('');

  $('filter-modell').innerHTML = '<option value="">Alle Modelle</option>' +
    MODELL_KEYS.map((k) => `<option value="${k}">${MODELL[k]}</option>`).join('');
}

// Vorschlagslisten (datalists) fuer das Formular — komplett aus vorhandenen Daten
function buildDatalists() {
  const fill = (elId, values) => {
    $(elId).innerHTML = [...new Set(values.filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .map((v) => `<option value="${escapeAttr(v)}"></option>`).join('');
  };
  fill('dl-uebergruppe', allKoops.map((k) => k.uebergruppe));
  fill('dl-land', allKoops.map((k) => k.land));
  refreshUntergruppeList(''); // initial: alle Untergruppen
}

// Untergruppen-Vorschlaege haengen von der gewaehlten Uebergruppe ab (aus DB)
function refreshUntergruppeList(uebergruppe) {
  const u = (uebergruppe || '').trim().toLowerCase();
  const rel = allKoops.filter((k) => !u || (k.uebergruppe || '').trim().toLowerCase() === u);
  const values = [...new Set(rel.map((k) => k.untergruppe).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('dl-untergruppe').innerHTML = values.map((v) => `<option value="${escapeAttr(v)}"></option>`).join('');
}

function getFiltered() {
  const q = $('search').value.trim().toLowerCase();
  const fStatus = $('filter-status').value;
  const fRichtung = $('filter-richtung').value;
  const fUeber = $('filter-uebergruppe').value;
  const fModell = $('filter-modell').value;
  let rows = allKoops.filter((k) => {
    if (!fStatus && HIDE_BY_DEFAULT.includes(k.status)) return false;
    if (fStatus && k.status !== fStatus) return false;
    if (fRichtung && k.richtung !== fRichtung) return false;
    if (fUeber && k.uebergruppe !== fUeber) return false;
    if (fModell && k.modell !== fModell) return false;
    if (q) {
      const hay = [k.marke, k.uebergruppe, k.untergruppe, k.land, k.kontakt, k.email, k.instagram, k.bemerkung]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  rows.sort((a, b) => {
    let av = String(a[sortKey] ?? '').toLowerCase();
    let bv = String(b[sortKey] ?? '').toLowerCase();
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });
  return rows;
}

// ===================== RENDER =====================
function render() {
  const rows = getFiltered();
  $('count-badge').textContent = `${rows.length} von ${allKoops.length} Kooperationen`;
  renderSummary();
  if (rows.length === 0) {
    tbody.innerHTML = '';
    $('empty-state').classList.remove('hidden');
    return;
  }
  $('empty-state').classList.add('hidden');
  tbody.innerHTML = rows.map(rowHtml).join('');
  wireRows();
}

function richtungBadge(r) {
  return r === 'inbound'
    ? '<span class="text-xs rounded-full px-2 py-0.5 bg-indigo-50 text-indigo-700">← inbound</span>'
    : '<span class="text-xs rounded-full px-2 py-0.5 bg-zinc-100 text-zinc-600">outbound →</span>';
}

function rowHtml(k) {
  const gruppe = [k.uebergruppe, k.untergruppe].filter(Boolean).join(' · ');
  const insta = k.instagram
    ? `<div class="text-xs text-zinc-400 font-mono break-all">${escapeHtml(k.instagram)}</div>` : '';
  const mail = k.email
    ? `<div class="text-xs text-zinc-400 font-mono break-all">${escapeHtml(k.email)}</div>` : '';
  return `
  <tr class="hover:bg-zinc-50/60 transition-colors">
    <td class="px-3 py-2.5 align-top">
      <div class="font-medium text-zinc-900">${escapeHtml(k.marke)}</div>
      ${k.land ? `<div class="text-xs text-zinc-400">${escapeHtml(k.land)}</div>` : ''}
    </td>
    <td class="px-3 py-2.5 align-top whitespace-nowrap">${richtungBadge(k.richtung)}</td>
    <td class="px-3 py-2.5 align-top text-zinc-600 hidden md:table-cell">${gruppe ? escapeHtml(gruppe) : '<span class="text-zinc-300">—</span>'}</td>
    <td class="px-3 py-2.5 align-top">
      <select data-id="${k.id}" class="${statusSelectCls(k.status)}">
        ${STATUS_KEYS.map((s) => `<option value="${s}" ${s === k.status ? 'selected' : ''}>${STATUS[s].label}</option>`).join('')}
      </select>
    </td>
    <td class="px-3 py-2.5 align-top text-zinc-600 hidden md:table-cell whitespace-nowrap">
      ${k.modell ? `${escapeHtml(MODELL[k.modell] || k.modell)}${k.honorar ? `<div class="text-xs text-zinc-400">${escapeHtml(k.honorar)}</div>` : ''}` : '<span class="text-zinc-300">—</span>'}
    </td>
    <td class="px-3 py-2.5 align-top text-zinc-600 whitespace-nowrap">${k.angefragt_am ? formatDate(k.angefragt_am) : '<span class="text-zinc-300">—</span>'}</td>
    <td class="px-3 py-2.5 align-top text-zinc-600 max-w-[220px] hidden lg:table-cell">
      ${k.bemerkung
        ? k.bemerkung.split('·').map((s) => s.trim()).filter(Boolean).map((s) =>
            `<span class="inline-block text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600 border border-zinc-200 mr-1 mb-1">${escapeHtml(s)}</span>`
          ).join('')
        : '<span class="text-zinc-300">—</span>'}
    </td>
    <td class="px-3 py-2.5 align-top text-zinc-600 max-w-[200px]">
      ${k.kontakt ? `<div>${escapeHtml(k.kontakt)}</div>` : ''}
      ${insta}${mail}
      ${!k.kontakt && !insta && !mail ? '<span class="text-zinc-300">—</span>' : ''}
    </td>
    <td class="px-3 py-2.5 align-top">
      <button data-edit="${k.id}" class="text-xs px-2 py-1 rounded-md border border-zinc-200 hover:bg-zinc-50 whitespace-nowrap">Bearbeiten</button>
    </td>
  </tr>`;
}

function wireRows() {
  tbody.querySelectorAll('select[data-id]').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const ok = await updateStatus(e.target.dataset.id, e.target.value);
      if (ok) render();
    });
  });
  tbody.querySelectorAll('button[data-edit]').forEach((b) => {
    b.addEventListener('click', () => openEdit(b.dataset.edit));
  });
}

function statusSelectCls(status) {
  const s = STATUS[status] || STATUS.offen;
  return `text-xs rounded-full px-2.5 py-1 border-0 font-medium cursor-pointer focus:ring-2 focus:ring-zinc-900/10 ${s.cls}`;
}

function renderSummary() {
  const counts = {};
  STATUS_KEYS.forEach((k) => (counts[k] = 0));
  allKoops.forEach((k) => { if (counts[k.status] != null) counts[k.status]++; });
  $('status-summary').innerHTML = STATUS_KEYS
    .filter((k) => counts[k] > 0)
    .map((k) => `<span class="text-xs rounded-full px-2.5 py-1 ${STATUS[k].cls}">${STATUS[k].label}: ${counts[k]}</span>`)
    .join('');
}

function renderLegend() {
  const el = $('status-legend');
  if (!el) return;
  el.innerHTML = LEGEND.map(([k, txt]) =>
    `<div class="flex items-start gap-2 py-1">
       <span class="text-xs rounded-full px-2.5 py-1 whitespace-nowrap ${STATUS[k].cls}">${STATUS[k].label}</span>
       <span class="text-xs text-zinc-600">${txt}</span>
     </div>`).join('');
}

// ===================== ADD / EDIT MODAL =====================
function fillStatusSelect() {
  $('f-status').innerHTML = STATUS_KEYS.map((k) => `<option value="${k}">${STATUS[k].label}</option>`).join('');
}
function fillModellSelect() {
  $('f-modell').innerHTML = '<option value="">— kein Modell —</option>' +
    MODELL_KEYS.map((k) => `<option value="${k}">${MODELL[k]}</option>`).join('');
}

function openEdit(id) {
  editId = id || null;
  const k = id ? allKoops.find((x) => x.id === id) : null;
  $('edit-title').textContent = k ? 'Kooperation bearbeiten' : 'Neue Kooperation';
  $('f-marke').value = k?.marke || '';
  $('f-richtung').value = k?.richtung || 'outbound';
  $('f-status').value = k?.status || 'offen';
  $('f-uebergruppe').value = k?.uebergruppe || '';
  $('f-untergruppe').value = k?.untergruppe || '';
  $('f-land').value = k?.land || '';
  $('f-modell').value = k?.modell || '';
  $('f-honorar').value = k?.honorar || '';
  $('f-angefragt').value = k?.angefragt_am || '';
  $('f-instagram').value = k?.instagram || '';
  $('f-kontakt').value = k?.kontakt || '';
  $('f-email').value = k?.email || '';
  $('f-bemerkung').value = k?.bemerkung || '';
  refreshUntergruppeList($('f-uebergruppe').value);
  $('edit-error').classList.add('hidden');
  $('delete-btn').classList.toggle('hidden', !k);
  $('edit-modal').classList.remove('hidden');
  setTimeout(() => $('f-marke').focus(), 30);
}

function closeEdit() { $('edit-modal').classList.add('hidden'); editId = null; }

function emptyToNull(v) { const s = (v || '').trim(); return s === '' ? null : s; }

async function saveEdit(e) {
  e.preventDefault();
  const marke = $('f-marke').value.trim();
  if (!marke) { showEditError('Marke ist Pflicht.'); return; }
  const payload = {
    marke,
    richtung: $('f-richtung').value,
    status: $('f-status').value,
    uebergruppe: emptyToNull($('f-uebergruppe').value),
    untergruppe: emptyToNull($('f-untergruppe').value),
    land: emptyToNull($('f-land').value),
    modell: emptyToNull($('f-modell').value),
    honorar: emptyToNull($('f-honorar').value),
    angefragt_am: emptyToNull($('f-angefragt').value),
    instagram: emptyToNull($('f-instagram').value),
    kontakt: emptyToNull($('f-kontakt').value),
    email: emptyToNull($('f-email').value),
    bemerkung: emptyToNull($('f-bemerkung').value),
    updated_at: new Date().toISOString(),
  };
  const btn = $('save-btn');
  btn.disabled = true; btn.textContent = 'Speichern…';
  let error;
  if (editId) {
    ({ error } = await sb.from('kooperationen').update(payload).eq('id', editId));
  } else {
    ({ error } = await sb.from('kooperationen').insert(payload));
  }
  btn.disabled = false; btn.textContent = 'Speichern';
  if (error) { showEditError('Fehler beim Speichern: ' + error.message); return; }
  closeEdit();
  await loadKoops();
}

async function deleteKoop() {
  if (!editId) return;
  const k = allKoops.find((x) => x.id === editId);
  if (!confirm(`Kooperation „${k?.marke || ''}“ wirklich löschen?`)) return;
  const { error } = await sb.from('kooperationen').delete().eq('id', editId);
  if (error) { showEditError('Fehler beim Löschen: ' + error.message); return; }
  closeEdit();
  await loadKoops();
}

function showEditError(msg) {
  const el = $('edit-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ===================== TOOLBAR WIRING =====================
$('search').addEventListener('input', debounce(render, 150));
$('filter-richtung').addEventListener('change', render);
$('filter-status').addEventListener('change', render);
$('filter-uebergruppe').addEventListener('change', render);
$('filter-modell').addEventListener('change', render);
$('add-btn').addEventListener('click', () => openEdit(null));
$('export-btn').addEventListener('click', exportCsv);

$('edit-close').addEventListener('click', closeEdit);
$('edit-cancel').addEventListener('click', closeEdit);
$('edit-modal').addEventListener('click', (e) => { if (e.target.id === 'edit-modal') closeEdit(); });
$('edit-form').addEventListener('submit', saveEdit);
$('delete-btn').addEventListener('click', deleteKoop);
$('f-uebergruppe').addEventListener('input', (e) => refreshUntergruppeList(e.target.value));

document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir *= -1;
    else { sortKey = k; sortDir = 1; }
    render();
  });
});

// fillStatusSelect() laeuft erst nach loadStatusDefs() im Boot-Pfad.
fillModellSelect();

function exportCsv() {
  const rows = getFiltered();
  const cols = ['marke', 'richtung', 'land', 'uebergruppe', 'untergruppe', 'status', 'modell', 'honorar',
    'angefragt_am', 'kontakt', 'instagram', 'email', 'bemerkung'];
  const head = cols.join(';');
  const body = rows.map((k) => cols.map((c) => csvCell(k[c])).join(';')).join('\r\n');
  const csv = '﻿' + head + '\r\n' + body;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lifetimemiri-kooperationen-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===================== HELPERS =====================
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function formatDate(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return escapeHtml(d);
  return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ===================== FEEDBACK =====================
(function initFeedback() {
  const btn = $('feedback-btn');
  const modal = $('feedback-modal');
  const overlay = $('feedback-overlay');
  const textarea = $('feedback-text');
  const submitBtn = $('feedback-submit');
  const thanks = $('feedback-thanks');
  const form = $('feedback-form');
  const errEl = $('feedback-error');

  function openFeedback() {
    textarea.value = '';
    thanks.classList.add('hidden');
    form.classList.remove('hidden');
    errEl.classList.add('hidden');
    errEl.textContent = '';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Absenden';
    modal.classList.remove('hidden');
    setTimeout(() => { textarea.focus(); }, 80);
  }
  function closeFeedback() { modal.classList.add('hidden'); }

  btn.addEventListener('click', openFeedback);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFeedback(); });
  $('feedback-close').addEventListener('click', closeFeedback);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Speichern…';
    const { error } = await sb.from('feedback').insert({ message: text });
    if (error) {
      console.error('Feedback-Fehler:', error);
      errEl.textContent = 'Fehler beim Speichern: ' + error.message;
      errEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Absenden';
      return;
    }
    textarea.value = '';
    form.classList.add('hidden');
    thanks.classList.remove('hidden');
    setTimeout(closeFeedback, 1500);
  });
})();

// ===================== BOOT =====================
(async () => {
  const { data } = await sb.auth.getSession();
  if (data?.session?.user) showApp(data.session.user);
  else showAuth();
})();
