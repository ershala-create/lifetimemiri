// ============================================
// HeritageTraveler – App Logic (real schema)
// ============================================

const SUPABASE_URL = 'https://lepvxvjvaxnytxrgcpxx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_hsXVsENQLILd9QoeVN_hBw_nVdQpNYE';
// NOTE: client must NOT be named `supabase` — that collides with the global
// `window.supabase` from the UMD library and aborts the whole script.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Status: aus der DB (Tabelle status_defs), NICHT hartkodiert ----
// Wird in loadStatusDefs() vor dem ersten Render befuellt.
let STATUS = {};
let STATUS_KEYS = [];

// ---- Status-Legende (Erklaerung je Status, fuer das aufklappbare Panel) ----
const LEGEND = [
  ['offen', 'Recherchiert, aber noch KEIN Entwurf — hier muss noch eine Mail vorbereitet werden.'],
  ['entwurf', 'Entwurf liegt fertig in Gmail, noch nicht gesendet — die Sende-Liste.'],
  ['angefragt', 'Mail gesendet, wartet auf Antwort des Hotels.'],
  ['zusage', 'Hotel hat positiv geantwortet, Kooperation in Verhandlung (noch nicht final).'],
  ['wiedervorlage', 'Temporär abgesagt (ausgebucht/Saison) — später erneut anfragen.'],
  ['warten', 'Zurückgestellt: gleiche Gruppe/Person schon in Kontakt (Doppelkontakt) oder ganze Region zurückgestellt (z.B. China).'],
  ['kooperiert', 'Kooperation abgeschlossen — bereits zu Gast gewesen (Partner).'],
  ['antwort_negativ', 'Endgültig abgelehnt.'],
  ['ausgeschlossen', 'Passt nicht (adults-only, geschlossen) oder Doppeleintrag.'],
];

// ---- State ----
let allHotels = [];
let templates = [];
let sortKey = 'hotelname';
let sortDir = 1; // 1 asc, -1 desc
let modalHotel = null;
let quickFilter = null;       // null | 'nachfassen' | 'ohne_email'
let activeQuick = 'aktiv';    // welcher Quick-Chip ist aktiv (Highlight)
let groupBy = '';             // '' | 'land' | 'region' | 'gruppe' | 'status'
const collapsedGroups = new Set();
let activeTab = 'hotels';     // 'alle' | 'hotels' | 'gruppen'
let gruppenDrilldown = null;  // null | normierter Gruppen-Key (Drilldown-Ansicht)
const NACHFASS_DAYS = 30;     // Schwelle fuer "Nachfassen faellig"
const HIDE_BY_DEFAULT = ['kooperiert', 'ausgeschlossen', 'antwort_negativ']; // Partner/Ausgeschlossen/Absage ausgeblendet bis explizit gefiltert

// ---- Elements ----
const $ = (id) => document.getElementById(id);
const authView = $('auth-view');
const appView = $('app-view');
const tbody = $('hotels-body');

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

// Step 1: Einmal-Code anfordern
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

// Step 2: Code prüfen
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
  // Erfolg: einmal neu laden, damit der Boot-Pfad Session + Daten sauber (lock-frei) lädt
  location.reload();
});

$('back-to-email').addEventListener('click', () => {
  $('code-form').classList.add('hidden');
  $('step-email').classList.remove('hidden');
  $('auth-msg').classList.add('hidden');
});

$('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut();
});

sb.auth.onAuthStateChange((event) => {
  // NUR Logout hier behandeln. Daten werden ausschliesslich im Boot-Pfad
  // (getSession unten) geladen — niemals als direkte Reaktion auf diesen
  // Callback, sonst kollidiert die Query mit dem supabase-js Auth-Lock
  // und bleibt hängen (= leere Liste).
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
  // Daten-Calls AUS dem onAuthStateChange-Callback herauslösen (setTimeout),
  // sonst blockiert der supabase-js Auth-Lock die Query -> leere Liste.
  setTimeout(async () => { await loadStatusDefs(); loadHotels(); loadTemplates(); }, 0);
}

// ===================== DATA =====================
// Status-Vokabular aus der DB laden (einzige Quelle, geteilt mit Kooperationen).
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

async function loadHotels() {
  const { data, error } = await sb
    .from('hotels')
    .select('*')
    .order('hotelname', { ascending: true });
  if (error) { console.error(error); alert('Fehler beim Laden: ' + error.message); return; }
  allHotels = data || [];
  buildContactIndex();
  buildFilters();
  renderLegend();
  render();
}

async function loadTemplates() {
  const { data, error } = await sb
    .from('email_templates')
    .select('*')
    .order('name', { ascending: true });
  if (error) { console.error(error); return; }
  templates = data || [];
}

async function updateStatus(id, status) {
  const { error } = await sb.from('hotels').update({ status }).eq('id', id);
  if (error) { alert('Konnte Status nicht speichern: ' + error.message); return false; }
  const h = allHotels.find((x) => x.id === id);
  if (h) h.status = status;
  renderSummary();
  return true;
}

// ===================== FILTERS =====================
function buildFilters() {
  const fs = $('filter-status');
  fs.innerHTML = '<option value="">Alle Status</option>' +
    STATUS_KEYS.map((k) => `<option value="${k}">${STATUS[k].label}</option>`).join('');
  const lands = [...new Set(allHotels.map((h) => h.land).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('filter-land').innerHTML = '<option value="">Alle Länder</option>' +
    lands.map((l) => `<option value="${escapeAttr(l)}">${escapeHtml(l)}</option>`).join('');
  const gruppen = [...new Set(allHotels.map((h) => h.gruppe).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('filter-gruppe').innerHTML = '<option value="">Alle Gruppen</option>' +
    gruppen.map((g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join('');
  renderChips();
}

function hasEmail(h) { return !!(h.email_1 || h.email_allgemein || h.email_2); }
function olderThanDays(dateStr, days) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  return (Date.now() - d.getTime()) > days * 86400000;
}

// ===================== DOPPELKONTAKT-SCHUTZ =====================
// "Bereits im Kontakt" = wir haben diesen Kanal schon angefasst.
const CONTACTED = new Set(['angefragt', 'zusage', 'warten', 'kooperiert']);
let contactIndex = { byPerson: new Map(), byEmail: new Map() };

function normStr(s) { return (s || '').trim().toLowerCase(); }
function emailsOf(h) { return [h.email_1, h.email_2, h.email_allgemein].filter(Boolean).map((e) => e.trim().toLowerCase()); }

function buildContactIndex() {
  const byPerson = new Map();
  const byEmail = new Map();
  const push = (map, key, h) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(h); };
  for (const h of allHotels) {
    push(byPerson, normStr(h.ansprechperson_1), h);
    for (const e of emailsOf(h)) push(byEmail, e, h);
  }
  contactIndex = { byPerson, byEmail };
}

// Schnell-Check fuer das Tabellen-Icon (nur gleiche Person/E-Mail, via Index)
function hasContactConflict(hotel) {
  const someContacted = (arr) => arr && arr.some((h) => h.id !== hotel.id && CONTACTED.has(h.status));
  if (someContacted(contactIndex.byPerson.get(normStr(hotel.ansprechperson_1)))) return true;
  for (const e of emailsOf(hotel)) if (someContacted(contactIndex.byEmail.get(e))) return true;
  return false;
}

// Volle Konflikt-Liste fuer das E-Mail-Modal
function contactConflicts(hotel) {
  const seen = new Set([hotel.id]);
  const sameContact = [];
  const consider = [];
  const pArr = contactIndex.byPerson.get(normStr(hotel.ansprechperson_1));
  if (pArr) consider.push(...pArr);
  for (const e of emailsOf(hotel)) { const a = contactIndex.byEmail.get(e); if (a) consider.push(...a); }
  for (const h of consider) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    if (CONTACTED.has(h.status)) sameContact.push(h);
  }
  const sameGroup = [];
  if (hotel.gruppe && hotel.gruppe !== '-') {
    for (const h of allHotels) {
      if (seen.has(h.id)) continue;
      if (h.gruppe === hotel.gruppe && CONTACTED.has(h.status)) sameGroup.push(h);
    }
  }
  return { sameContact, sameGroup };
}

function getFiltered() {
  const q = $('search').value.trim().toLowerCase();
  const fStatus = $('filter-status').value;
  const fLand = $('filter-land').value;
  const fGruppe = $('filter-gruppe').value;
  let rows = allHotels.filter((h) => {
    // Partner + Ausgeschlossen standardmaessig ausblenden (nur via Status-Filter sichtbar);
    // im "Alle"-Tab wird NICHTS ausgeblendet (auch Ausgeschlossene/Partner/Absagen sichtbar)
    if (activeTab !== 'alle' && !fStatus && HIDE_BY_DEFAULT.includes(h.status)) return false;
    if (fStatus && h.status !== fStatus) return false;
    if (fLand && h.land !== fLand) return false;
    if (fGruppe && h.gruppe !== fGruppe) return false;
    if (quickFilter === 'ohne_email' && hasEmail(h)) return false;
    if (quickFilter === 'alt_offen' && !h.alt_offen) return false;
    if (quickFilter === 'nachfassen' && !(h.status === 'angefragt' && olderThanDays(h.angefragt_am, NACHFASS_DAYS))) return false;
    if (q) {
      const hay = [h.hotelname, h.ort, h.region, h.gruppe, h.email_1, h.email_2, h.email_allgemein, h.ansprechperson_1]
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
  $('count-badge').textContent = `${rows.length} von ${allHotels.length} Hotels`;
  renderSummary();
  renderChips();

  if (rows.length === 0) {
    tbody.innerHTML = '';
    $('empty-state').classList.remove('hidden');
    return;
  }
  $('empty-state').classList.add('hidden');
  tbody.innerHTML = groupBy ? groupedHtml(rows) : rows.map(rowHtml).join('');
  wireRows();
}

function wireRows() {
  tbody.querySelectorAll('select[data-id]').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const ok = await updateStatus(e.target.dataset.id, e.target.value);
      if (ok) render(); // neu rendern: z.B. "Partner"/"Ausgeschlossen" verschwindet aus der Aktiv-Sicht
    });
  });
  tbody.querySelectorAll('button[data-mail]').forEach((b) => {
    b.addEventListener('click', () => openEmail(b.dataset.mail));
  });
  tbody.querySelectorAll('tr[data-group-key]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button[data-research]')) return;
      const key = tr.dataset.groupKey;
      collapsedGroups.has(key) ? collapsedGroups.delete(key) : collapsedGroups.add(key);
      render();
    });
  });
  tbody.querySelectorAll('button[data-research]').forEach((b) => {
    b.addEventListener('click', () => researchGroup(b.dataset.research));
  });
}

// ---- Gruppierung (group-by Land / Region / Gruppe / Status) ----
function groupKeyOf(h) {
  const v = (groupBy === 'status' ? h.status : h[groupBy]) || '';
  return (v && v !== '-') ? v : '—'; // leere Gruppe / "-" zusammenfassen (kein Recherche-Button)
}
function groupLabelOf(key) {
  if (groupBy === 'status') return (STATUS[key] && STATUS[key].label) || key;
  return key;
}
function groupedHtml(rows) {
  const groups = new Map();
  rows.forEach((h) => {
    const k = groupKeyOf(h);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  });
  const keys = [...groups.keys()].sort((a, b) => String(a).localeCompare(String(b)));
  let html = '';
  keys.forEach((k) => {
    const items = groups.get(k);
    const collapsed = collapsedGroups.has(k);
    const researchBtn = (groupBy === 'gruppe' && k !== '—')
      ? `<button data-research="${escapeAttr(k)}" class="ml-2 px-2 py-0.5 rounded-md border border-zinc-200 bg-white hover:bg-zinc-50 text-xs font-normal">🔍 mehr aus dieser Gruppe</button>`
      : '';
    html += `<tr data-group-key="${escapeAttr(k)}" class="bg-zinc-50 cursor-pointer select-none">
      <td colspan="7" class="px-3 py-2 font-medium text-zinc-700">
        <span class="text-zinc-400 mr-1">${collapsed ? '▸' : '▾'}</span>${escapeHtml(groupLabelOf(k))}
        <span class="text-zinc-400 font-normal">(${items.length})</span>${researchBtn}
      </td></tr>`;
    if (!collapsed) html += items.map(rowHtml).join('');
  });
  return html;
}
function researchGroup(gruppe) {
  const prompt = `Recherchiere weitere ultra-luxuriöse 5★ Hotels der Gruppe "${gruppe}" (nur absolute High-End / superlative Häuser, familien- und hundefreundlich, keine Adults-only) und ergänze sie in der HeritageTraveler-Liste mit Status "offen".`;
  if (navigator.clipboard) navigator.clipboard.writeText(prompt).catch(() => {});
  alert('Recherche-Auftrag in die Zwischenablage kopiert — füge ihn in Claude Code ein:\n\n' + prompt);
}

// ===================== TABS (Alle / Hotels / Gruppen) =====================
function switchTab(tab) {
  activeTab = tab;
  gruppenDrilldown = null;
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.className = `tab-btn px-5 min-h-[44px] text-sm font-medium border-b-2 -mb-px ${on ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-900'}`;
  });
  const showHotels = (tab === 'alle' || tab === 'hotels');
  $('hotels-panel').classList.toggle('hidden', !showHotels);
  $('gruppen-panel').classList.toggle('hidden', tab !== 'gruppen');
  // Quick-Chips sind die Aktiv-Arbeitsliste -> nur im Hotels-Tab sichtbar
  $('quick-chips').classList.toggle('hidden', tab !== 'hotels');
  if (tab === 'alle') { quickFilter = null; activeQuick = null; $('filter-status').value = ''; }
  if (tab === 'hotels' && !activeQuick) { activeQuick = 'aktiv'; $('filter-status').value = ''; }
  if (showHotels) render();
  if (tab === 'gruppen') renderGruppen();
}

// ===================== GRUPPEN-ANSICHT =====================
// gleiche Schreibweisen zusammenfassen (Key normiert; Label = erste Schreibweise)
function normalizeGruppe(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^the\s+/, '');
}
const GRUPPE_CONTACTED = new Set(['angefragt', 'zusage', 'warten', 'wiedervorlage', 'kooperiert', 'antwort_negativ', 'entwurf']);

function buildGruppenMap() {
  const map = new Map(); // normKey -> { label, hotels: [] }
  for (const h of allHotels) {
    const g = (h.gruppe || '').trim();
    if (!g || g === '-') continue;
    const key = normalizeGruppe(g);
    if (!map.has(key)) map.set(key, { label: g, hotels: [] });
    map.get(key).hotels.push(h);
  }
  return map;
}

function renderGruppen() {
  if (gruppenDrilldown !== null) { renderDrilldown(gruppenDrilldown); return; }
  const map = buildGruppenMap();
  const entries = [...map.entries()].sort((a, b) =>
    b[1].hotels.length - a[1].hotels.length || a[1].label.localeCompare(b[1].label));
  $('count-badge').textContent = `${entries.length} Gruppen`;
  const cards = entries.map(([key, g]) => {
    const total = g.hotels.length;
    const kontaktiert = g.hotels.filter((h) => GRUPPE_CONTACTED.has(h.status)).length;
    const offen = total - kontaktiert;
    const pct = total ? Math.round(kontaktiert / total * 100) : 0;
    return `
    <div data-gruppe="${escapeAttr(key)}" class="gruppe-card bg-white border border-zinc-200 rounded-xl card-shadow mb-2 px-4 py-3 cursor-pointer hover:bg-zinc-50 transition-colors">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="font-semibold text-zinc-900 text-sm truncate">${escapeHtml(g.label)}</div>
          <div class="text-xs text-zinc-400 mt-0.5">${total} Hotels · ${kontaktiert} kontaktiert · <span class="${offen ? 'text-zinc-600' : 'text-zinc-300'}">${offen} offen</span></div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <div class="w-16 sm:w-28 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
            <div class="h-full bg-zinc-900 rounded-full" style="width:${pct}%"></div>
          </div>
          <span class="text-xs text-zinc-500 w-9 text-right tabular-nums">${pct}%</span>
          <span class="text-zinc-300">›</span>
        </div>
      </div>
    </div>`;
  }).join('');
  $('gruppen-body').innerHTML =
    `<p class="text-xs text-zinc-500 mb-3">${entries.length} Gruppen · tippe eine Gruppe an, um alle Häuser mit Status zu sehen.</p>` +
    (cards || '<p class="text-zinc-400 text-sm p-4">Keine Gruppen gefunden.</p>');
  $('gruppen-body').querySelectorAll('.gruppe-card').forEach((el) => {
    el.addEventListener('click', () => { gruppenDrilldown = el.dataset.gruppe; renderGruppen(); });
  });
}

function renderDrilldown(key) {
  const entry = buildGruppenMap().get(key);
  if (!entry) { gruppenDrilldown = null; renderGruppen(); return; }
  const hotels = [...entry.hotels].sort((a, b) => a.hotelname.localeCompare(b.hotelname));
  const kontaktiert = hotels.filter((h) => GRUPPE_CONTACTED.has(h.status)).length;
  $('count-badge').textContent = `${entry.label} · ${hotels.length} Hotels`;
  $('gruppen-body').innerHTML = `
    <button id="drilldown-back" class="mb-3 text-xs px-3 py-2 rounded-lg border border-zinc-200 hover:bg-zinc-50">← Alle Gruppen</button>
    <div class="mb-3">
      <h2 class="text-base font-semibold">${escapeHtml(entry.label)}</h2>
      <p class="text-xs text-zinc-500 mt-0.5">${hotels.length} Hotels · ${kontaktiert} kontaktiert · ${hotels.length - kontaktiert} offen</p>
    </div>
    <div class="space-y-2">${hotels.map(gruppeHotelCard).join('')}</div>`;
  $('drilldown-back').addEventListener('click', () => { gruppenDrilldown = null; renderGruppen(); });
  wireGruppenCards($('gruppen-body'));
}

// Hotel-Karte im Gruppen-Drilldown (mobile-first statt Tabelle)
function gruppeHotelCard(h) {
  const mail = h.email_1 || h.email_allgemein || h.email_2 || '';
  const datum = h.angefragt_am ? formatDate(h.angefragt_am) : '';
  const meta = [h.ort, h.land].filter(Boolean).join(', ');
  return `
  <div class="bg-white border border-zinc-200 rounded-xl card-shadow px-4 py-3">
    <div class="font-medium text-zinc-900 text-sm">${escapeHtml(h.hotelname)}</div>
    <div class="text-xs text-zinc-400 mt-0.5">${escapeHtml(meta || '—')}${datum ? ' · angefragt ' + datum : ''}</div>
    ${mail ? `<div class="text-xs text-zinc-400 font-mono break-all mt-0.5">${escapeHtml(mail)}</div>` : ''}
    <div class="mt-2">
      <select data-id="${h.id}" class="${statusSelectCls(h.status)}">
        ${STATUS_KEYS.map((k) => `<option value="${k}" ${k === h.status ? 'selected' : ''}>${STATUS[k].label}</option>`).join('')}
      </select>
    </div>
  </div>`;
}

function wireGruppenCards(container) {
  container.querySelectorAll('select[data-id]').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const ok = await updateStatus(e.target.dataset.id, e.target.value);
      if (ok) renderGruppen();
    });
  });
}

// ---- Quick-Chips (Schnellfilter) ----
const QUICK_CHIPS = [
  { key: 'aktiv', label: 'Aktiv', hint: 'Alle Hotels ausser Partner, Absagen und Ausgeschlossene — die aktive Arbeitsliste.' },
  { key: 'bereit', label: 'Bereit zum Anschreiben', hint: 'Recherchiert, aber noch KEIN Entwurf erstellt — hier muss noch eine Mail vorbereitet werden.' },
  { key: 'entwurf', label: 'Entwurf bereit', hint: 'Entwurf liegt fertig in Gmail, aber noch nicht gesendet — Miris Sende-Liste.' },
  { key: 'zusage', label: 'Zusage', hint: 'Hotel hat positiv geantwortet, Kooperation in Verhandlung (noch nicht final).' },
  { key: 'nachfassen', label: 'Nachfassen fällig', hint: 'Schon angefragt, aber seit über 30 Tagen keine Antwort — freundlich erinnern.' },
  { key: 'wiedervorlage', label: 'Wiedervorlage', hint: 'Temporär abgesagt (ausgebucht/Saison) — später erneut anfragen.' },
  { key: 'ohne_email', label: 'Ohne E-Mail', hint: 'Noch keine E-Mail-Adresse hinterlegt — Adresse muss recherchiert werden.' },
  { key: 'warten', label: 'Warten', hint: 'Zurückgestellt: gleiche Gruppe/Person bereits in Kontakt (Doppelkontakt-Schutz) oder ganze Region zurückgestellt (z.B. China).' },
  { key: 'partner', label: 'Partner', hint: 'Kooperation abgeschlossen — bereits zu Gast gewesen.' },
  { key: 'absagen', label: 'Absagen', hint: 'Hotel hat endgültig abgelehnt — die Absagen-Liste.' },
  { key: 'alt_offen', label: 'Alt-Konto offen', hint: 'Nur vom alten @heritagetraveler.com-Konto angeschrieben (wahrscheinlich im Spam), nie per Gmail — Kandidaten zum Wiederanschreiben. Temporärer Filter.' },
  { key: 'ausgeschlossen', label: 'Ausgeschlossen', hint: 'Passt nicht (z.B. adults-only, geschlossen) oder Doppeleintrag.' },
];
// Anzahl Hotels je Schnellfilter (fuer Chip-Badges)
function quickCount(key) {
  const has = (h) => !!(h.email_1 || h.email_allgemein || h.email_2);
  const old30 = (h) => h.angefragt_am && (Date.now() - new Date(h.angefragt_am).getTime()) > NACHFASS_DAYS * 86400000;
  return allHotels.filter((h) => {
    switch (key) {
      case 'aktiv':          return !HIDE_BY_DEFAULT.includes(h.status);
      case 'bereit':         return h.status === 'offen';
      case 'entwurf':        return h.status === 'entwurf';
      case 'zusage':         return h.status === 'zusage';
      case 'nachfassen':     return h.status === 'angefragt' && old30(h);
      case 'wiedervorlage':  return h.status === 'wiedervorlage';
      case 'ohne_email':     return !has(h) && !HIDE_BY_DEFAULT.includes(h.status);
      case 'warten':         return h.status === 'warten';
      case 'partner':        return h.status === 'kooperiert';
      case 'absagen':        return h.status === 'antwort_negativ';
      case 'alt_offen':      return h.alt_offen === true;
      case 'ausgeschlossen': return h.status === 'ausgeschlossen';
      default:               return 0;
    }
  }).length;
}
function renderChips() {
  const wrap = $('quick-chips');
  if (!wrap) return;
  wrap.innerHTML = QUICK_CHIPS.map((c) => {
    const on = activeQuick === c.key;
    const n = quickCount(c.key);
    const badge = `<span class="ml-1 ${on ? 'opacity-80' : 'text-zinc-400'}">${n}</span>`;
    return `<button data-quick="${c.key}" title="${escapeAttr(c.hint || '')}" class="text-xs px-3 py-1.5 rounded-full border transition-colors ${on ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'}">${c.label}${badge}</button>`;
  }).join('');
  wrap.querySelectorAll('button[data-quick]').forEach((b) => {
    b.addEventListener('click', () => applyQuick(b.dataset.quick));
  });
}
function applyQuick(key) {
  quickFilter = null;
  activeQuick = key;
  const s = $('filter-status');
  const map = { bereit: 'offen', entwurf: 'entwurf', zusage: 'zusage', wiedervorlage: 'wiedervorlage', warten: 'warten', partner: 'kooperiert', absagen: 'antwort_negativ', ausgeschlossen: 'ausgeschlossen' };
  if (key === 'aktiv') s.value = '';
  else if (key === 'nachfassen') { s.value = 'angefragt'; quickFilter = 'nachfassen'; }
  else if (key === 'ohne_email') { s.value = ''; quickFilter = 'ohne_email'; }
  else if (key === 'alt_offen') { s.value = ''; quickFilter = 'alt_offen'; }
  else s.value = map[key] || '';
  render();
}

function rowHtml(h) {
  const contactName = h.ansprechperson_1 || '';
  const contactMail = h.email_1 || h.email_allgemein || h.email_2 || '';
  const conflict = hasContactConflict(h);
  return `
  <tr class="hover:bg-zinc-50/60 transition-colors">
    <td class="px-3 py-2.5 align-top">
      <div class="font-medium text-zinc-900">${escapeHtml(h.hotelname)}</div>
      ${h.ort ? `<div class="text-xs text-zinc-400">${escapeHtml(h.ort)}</div>` : ''}
      ${h.gruppe ? `<div class="text-xs text-zinc-400">${escapeHtml(h.gruppe)}</div>` : ''}
    </td>
    <td class="px-3 py-2.5 align-top text-zinc-600 whitespace-nowrap">${escapeHtml(h.land || '—')}</td>
    <td class="px-3 py-2.5 align-top text-zinc-600 hidden md:table-cell">${escapeHtml(h.region || '—')}</td>
    <td class="px-3 py-2.5 align-top">
      <select data-id="${h.id}" class="${statusSelectCls(h.status)}">
        ${STATUS_KEYS.map((k) => `<option value="${k}" ${k === h.status ? 'selected' : ''}>${STATUS[k].label}</option>`).join('')}
      </select>
    </td>
    <td class="px-3 py-2.5 align-top text-zinc-600 whitespace-nowrap">${dateCell(h)}</td>
    <td class="px-3 py-2.5 align-top text-zinc-600 max-w-[240px] hidden md:table-cell">
      ${h.bemerkung
        ? h.bemerkung.split('·').map(s => s.trim()).filter(Boolean).map(s =>
            `<span class="inline-block text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600 border border-zinc-200 mr-1 mb-1">${escapeHtml(s)}</span>`
          ).join('')
        : '<span class="text-zinc-300">—</span>'}
    </td>
    <td class="px-3 py-2.5 align-top text-zinc-600 max-w-[220px]">
      ${conflict ? '<div class="text-amber-600 text-xs mb-0.5" title="Gleiche Ansprechperson/E-Mail wie ein bereits kontaktiertes Hotel – vor dem Anschreiben prüfen">⚠ Sammelkontakt</div>' : ''}
      ${contactName ? `<div>${escapeHtml(contactName)}</div>` : ''}
      ${contactMail ? `<div class="text-xs text-zinc-400 font-mono break-all">${escapeHtml(contactMail)}</div>` : '<span class="text-zinc-300">—</span>'}
    </td>
  </tr>`;
}

function statusSelectCls(status) {
  const s = STATUS[status] || STATUS.offen;
  return `text-xs rounded-full px-2.5 py-1 border-0 font-medium cursor-pointer focus:ring-2 focus:ring-zinc-900/10 ${s.cls}`;
}

function renderSummary() {
  const counts = {};
  STATUS_KEYS.forEach((k) => (counts[k] = 0));
  allHotels.forEach((h) => { if (counts[h.status] != null) counts[h.status]++; });
  $('status-summary').innerHTML = STATUS_KEYS
    .filter((k) => counts[k] > 0)
    .map((k) => `<span class="text-xs rounded-full px-2.5 py-1 ${STATUS[k].cls}">${STATUS[k].label}: ${counts[k]}</span>`)
    .join('');
}

// ---- Legende rendern (einmal, statisch) ----
function renderLegend() {
  const el = $('status-legend');
  if (!el) return;
  el.innerHTML = LEGEND.map(([k, txt]) =>
    `<div class="flex items-start gap-2 py-1">
       <span class="text-xs rounded-full px-2.5 py-1 whitespace-nowrap ${STATUS[k].cls}">${STATUS[k].label}</span>
       <span class="text-xs text-zinc-600">${txt}</span>
     </div>`).join('') +
    `<div class="flex items-start gap-2 py-1 border-t border-zinc-100 mt-1 pt-2">
       <span class="text-xs rounded-full px-2.5 py-1 whitespace-nowrap bg-zinc-100 text-zinc-600">Nachfassen fällig</span>
       <span class="text-xs text-zinc-600">Kein eigener Status, sondern ein Filter: „angefragt" + seit über 30 Tagen keine Antwort.</span>
     </div>`;
}

// ===================== EMAIL MODAL =====================
function openEmail(hotelId) {
  modalHotel = allHotels.find((h) => h.id === hotelId);
  if (!modalHotel) return;
  const h = modalHotel;
  $('modal-hotel-name').textContent = h.hotelname;
  $('modal-hotel-meta').textContent = [h.ort, h.land, h.gruppe].filter(Boolean).join(' · ');
  $('modal-recipient').value = h.email_1 || h.email_allgemein || h.email_2 || '';
  renderModalWarning(h);

  // template dropdown
  const sel = $('modal-template');
  sel.innerHTML = templates.map((t, i) => `<option value="${i}">${escapeHtml(t.name)} (${t.sprache.toUpperCase()})</option>`).join('');
  sel.onchange = applyTemplate;
  applyTemplate();

  $('email-modal').classList.remove('hidden');
}

function applyTemplate() {
  const i = parseInt($('modal-template').value, 10);
  const t = templates[i];
  if (!t) { $('modal-subject').value = ''; $('modal-body').value = ''; return; }
  $('modal-subject').value = t.betreff || '';
  $('modal-body').value = t.body || '';
}

function renderModalWarning(h) {
  const el = $('modal-warning');
  if (!el) return;
  const { sameContact, sameGroup } = contactConflicts(h);
  let html = '';
  if (sameContact.length) {
    html += `<div class="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs">
      ⚠️ <b>Gleiche Ansprechperson/E-Mail bereits kontaktiert:</b>
      <ul class="mt-1 ml-4 list-disc">${sameContact.slice(0, 6).map((x) => `<li>${escapeHtml(x.hotelname)} — ${STATUS[x.status].label}${x.angefragt_am ? ', ' + formatDate(x.angefragt_am) : ''}</li>`).join('')}</ul>
      <div class="mt-1">Nicht zweimal an dieselbe Person schreiben — wirklich auch dieses senden?</div></div>`;
  }
  if (sameGroup.length) {
    html += `<div class="bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-3 py-2 text-xs">
      ℹ️ Aus derselben Gruppe (${escapeHtml(h.gruppe)}) bereits in Kontakt: ${sameGroup.length} — ${sameGroup.slice(0, 5).map((x) => escapeHtml(x.hotelname)).join(', ')}${sameGroup.length > 5 ? ' …' : ''}</div>`;
  }
  el.innerHTML = html;
  el.classList.toggle('hidden', !html);
}

$('modal-close').addEventListener('click', () => $('email-modal').classList.add('hidden'));
$('email-modal').addEventListener('click', (e) => {
  if (e.target.id === 'email-modal') $('email-modal').classList.add('hidden');
});

document.querySelectorAll('.copy-btn').forEach((b) => {
  b.addEventListener('click', async () => {
    const el = $(b.dataset.copy);
    try {
      await navigator.clipboard.writeText(el.value);
    } catch {
      el.select(); document.execCommand('copy');
    }
    const c = $('modal-copied');
    c.classList.remove('hidden');
    setTimeout(() => c.classList.add('hidden'), 1500);
  });
});

// ===================== TOOLBAR WIRING =====================
$('search').addEventListener('input', debounce(render, 150));
$('filter-status').addEventListener('change', () => { quickFilter = null; activeQuick = null; render(); });
$('filter-land').addEventListener('change', render);
$('filter-gruppe').addEventListener('change', render);
$('group-by').addEventListener('change', (e) => { groupBy = e.target.value; collapsedGroups.clear(); render(); });

document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir *= -1;
    else { sortKey = k; sortDir = 1; }
    render();
  });
});

$('export-btn').addEventListener('click', exportCsv);

// ---- Tab-Umschaltung (Alle / Hotels / Gruppen) ----
document.querySelectorAll('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

function exportCsv() {
  const rows = getFiltered();
  const cols = ['hotelname', 'land', 'region', 'ort', 'gruppe', 'status', 'angefragt_am',
    'ansprechperson_1', 'email_1', 'ansprechperson_2', 'email_2', 'email_allgemein', 'homepage', 'notizen'];
  const head = cols.join(';');
  const body = rows.map((h) => cols.map((c) => csvCell(h[c])).join(';')).join('\r\n');
  const csv = '﻿' + head + '\r\n' + body; // BOM for Excel umlauts
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `heritagetraveler-hotels-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===================== HELPERS =====================
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// Datumsspalte: bei Partnern das Besuchs-/Kooperationsdatum (Spalte H), sonst Anfrage-Datum
function dateCell(h) {
  if (h.status === 'kooperiert' && h.besucht) {
    const v = String(h.besucht).replace(' 00:00:00', '');
    return `<span class="text-violet-700" title="Besuch / Kooperation (Excel Spalte H)">🏨 ${escapeHtml(v)}</span>`;
  }
  return h.angefragt_am ? formatDate(h.angefragt_am) : '<span class="text-zinc-300">—</span>';
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
  const btn = document.getElementById('feedback-btn');
  const modal = document.getElementById('feedback-modal');
  const overlay = document.getElementById('feedback-overlay');
  const textarea = document.getElementById('feedback-text');
  const submitBtn = document.getElementById('feedback-submit');
  const thanks = document.getElementById('feedback-thanks');
  const form = document.getElementById('feedback-form');
  const errEl = document.getElementById('feedback-error');

  function openFeedback() {
    textarea.value = '';
    thanks.classList.add('hidden');
    form.classList.remove('hidden');
    errEl.classList.add('hidden');
    errEl.textContent = '';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Absenden';
    modal.classList.remove('hidden');
    // kurze Verzögerung damit Modal im DOM sichtbar ist, dann fokussieren + scrollen
    setTimeout(() => {
      textarea.focus();
      textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }
  function closeFeedback() {
    modal.classList.add('hidden');
  }

  btn.addEventListener('click', openFeedback);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFeedback(); });
  document.getElementById('feedback-close').addEventListener('click', closeFeedback);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Speichern…';
    // Spalte heisst "message" (nicht "text") — DB-Schema-korrekter Insert
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
