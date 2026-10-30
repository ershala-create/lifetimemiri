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
  ['angefragt', 'Mail gesendet, wartet auf Antwort des Hauses. Nach 28 Tagen ohne Antwort geht es auf Wiedervorlage.'],
  ['zusage', 'Hotel hat positiv geantwortet, Kooperation in Verhandlung (noch nicht final).'],
  ['wiedervorlage', 'Später erneut ansprechen: vorübergehend abgesagt (Saison, ausgebucht) oder 28 Tage ohne Antwort. Kam die erste Mail vom Altkonto oder mit umgeleiteten Links, wird frisch angeschrieben, sonst mit Bezug nachgefasst.'],
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
let groupBy = '';             // '' | 'land' | 'region' | 'gruppe' | 'status'
const collapsedGroups = new Set();
let activeTab = 'hotels';     // 'alle' | 'hotels' | 'gruppen' | 'antworten' | 'termine' | 'backlog'
let gruppenDrilldown = null;  // null | normierter Gruppen-Key (Drilldown-Ansicht)
let antwortenFilter = null;   // null | key aus ANTWORT_SECTIONS (angeklickte Kachel)
let syncState = null;         // null (ladend) | { gmail_eingang, gmail_ausgang } aus sync_state
let backlogRows = null;       // null (ladend) | Zeilen aus ht_backlog
let backlogHinweis = '';      // Fehlerhinweis im Reiter Backlog, leer = alles gut
let backlogStamp = '';
let termineData = null;       // null (ladend) | { ferien, plan, todos } aus schulferien + plan_termine + miri_todos
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
  if (typeof TerminePlan !== 'undefined') TerminePlan.closeModal(); // kein Dialog mit Kontaktdaten ueber der Anmeldung
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
  setTimeout(async () => { await loadStatusDefs(); await loadHotels(); loadTemplates(); openTabFromHash(); }, 0);
}

// Direktlink auf einen Reiter, z.B. .../heritagetraveler/#termine
function openTabFromHash() {
  const t = location.hash.replace('#', '');
  if (['alle', 'hotels', 'gruppen', 'antworten', 'termine', 'backlog'].includes(t)) switchTab(t);
}

// ===================== DATA =====================
// Status-Vokabular aus der DB laden (einzige Quelle, geteilt mit Kooperationen).
async function loadStatusDefs() {
  const { data, error } = await sb
    .from('status_defs')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) { console.error(error); alert('Fehler beim Laden der Status: ' + error.message); return; }
  // status_defs values are written into HTML (text, attributes, class lists) in many places:
  // keep only harmless characters once, here at the source
  const defs = (data || []).map((s) => ({
    key: String(s.key).replace(/[^A-Za-z0-9_-]/g, ''),
    label: String(s.label).replace(/[<>"'&`]/g, ''),
    cls: String(s.cls).replace(/[^A-Za-z0-9 _:/.[\]#%-]/g, ''),
  }));
  STATUS = {};
  defs.forEach((s) => { STATUS[s.key] = { label: s.label, cls: s.cls }; });
  STATUS_KEYS = defs.map((s) => s.key);
}

async function loadHotels() {
  // PostgREST answers at most 1000 rows per request (the table has more), so read it page by page.
  // The id breaks ties between equal names, otherwise the pages can overlap or skip rows.
  // The total from the first answer is checked at the end: a short list must never pass silently
  // (it once hid every hotel behind "M", among them three finished cooperations).
  // MAX_PAGES ends the loop if a server keeps answering without an end.
  const PAGE = 1000, MAX_PAGES = 20;
  const rows = [];
  let total = null, pages = 0, ended = false;
  while ((total === null || rows.length < total) && pages < MAX_PAGES) {
    pages++;
    const { data, error, count } = await sb
      .from('hotels')
      .select('*', total === null ? { count: 'exact' } : {})
      .order('hotelname', { ascending: true })
      .order('id', { ascending: true })
      .range(rows.length, rows.length + PAGE - 1);
    if (error) { console.error(error); alert('Fehler beim Laden: ' + error.message); return; }
    if (total === null && Number.isFinite(count) && count >= 0) total = count;
    if (!data || !data.length) { ended = true; break; }
    rows.push(...data);
  }
  // without a usable total the list is complete only if the server ended it before the page limit
  if (total === null ? !ended : rows.length !== total) {
    console.error('hotels: ' + rows.length + ' rows loaded, total ' + total);
    alert(total === null
      ? 'Die Hotelliste ist unvollständig. Bitte die Seite neu laden.'
      : 'Es wurden nur ' + rows.length + ' von ' + total + ' Hotels geladen. Bitte die Seite neu laden.');
  }
  allHotels = rows;
  hotelsStamp = stampOf(rows);
  buildContactIndex();
  buildFilters();
  renderLegend();
  render();
  showSyncTime();
  if (activeTab === 'antworten') renderAntworten();
  if (activeTab === 'termine') renderTermine();
}

// ===================== LIVE-SYNC MIT DER DB =====================
// Die DB ist die einzige Quelle für Chips und Liste. Alle 60 Sekunden fragen wir winzig nach (neueste updated_at plus
// Anzahl) und laden die Hotels nur dann neu, wenn sich etwas geändert hat. Filter und Sortierung bleiben dabei erhalten.
const SYNC_MS = 60000;
let hotelsStamp = null;       // 'neueste updated_at|Anzahl' des zuletzt geladenen Stands
function stampOf(rows) {
  let max = '';
  for (const r of rows) if (r.updated_at && r.updated_at > max) max = r.updated_at;
  return max + '|' + rows.length;
}
function showSyncTime() {
  const el = $('sync-info');
  if (el) el.textContent = 'live aus der DB, Stand ' + new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
}
async function syncHotelsIfChanged() {
  if (!appLoaded || !hotelsStamp || document.hidden === true) return;
  const { data, error, count } = await sb.from('hotels').select('updated_at', { count: 'exact' })
    .order('updated_at', { ascending: false }).range(0, 0);
  if (error || !data || !data.length) return;
  if ((data[0].updated_at || '') + '|' + count !== hotelsStamp) await loadHotels();
  else showSyncTime();
}
setInterval(syncHotelsIfChanged, SYNC_MS);
document.addEventListener('visibilitychange', () => { if (document.hidden !== true) syncHotelsIfChanged(); });

// Stand des letzten Gmail-Abgleichs (Tabelle sync_state), nur fuer die Zeile im Reiter Antworten.
async function loadSyncState() {
  const { data, error } = await sb.from('sync_state').select('key, zeitpunkt');
  if (error) console.error(error);
  syncState = {};
  (data || []).forEach((r) => { syncState[r.key] = r.zeitpunkt; });
  if (activeTab === 'antworten') renderAntworten();
}

// Schulferien (NÖ), zusaetzliche Zeitfenster/Ereignisse und Miris To-dos fuer den Reiter Termine.
async function loadTermineData() {
  const [f, p, t] = await Promise.all([
    sb.from('schulferien').select('*').order('von', { ascending: true }),
    sb.from('plan_termine').select('*').order('von', { ascending: true }),
    sb.from('miri_todos').select('*').eq('erledigt', false),
  ]);
  if (f.error) console.error(f.error);
  if (p.error) console.error(p.error);
  if (t.error) console.error(t.error);
  termineData = { ferien: f.data || [], plan: p.data || [], todos: t.data || [], fehler: !!(f.error || p.error || t.error) };
  if (activeTab === 'termine') renderTermine();
}

function renderTermine() {
  const body = $('termine-body');
  if (!body || typeof TerminePlan === 'undefined') return;
  if (!termineData) { body.innerHTML = '<p class="text-sm text-zinc-400 p-4">Termine werden geladen …</p>'; return; }
  const hinweis = termineData.fehler ? 'Schulferien, Zusatztermine oder To-dos konnten nicht geladen werden, die Ansicht ist unvollständig.' : '';
  const model = TerminePlan.render(body, { hotels: allHotels, plan: termineData.plan, ferien: termineData.ferien, todos: termineData.todos, status: STATUS, today: isoToday(), hinweis });
  const c = model.counts;
  $('count-badge').textContent = `${c.fix} fix · ${c.verhandlung} in Verhandlung${c.rot ? ` · ${c.rot} Achtung` : ''}`;
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
  renderChips();
  return true;
}

// ===================== FILTERS =====================
function buildFilters() {
  // aktuelle Auswahl merken: ein Neuladen aus der DB darf den gewählten Filter nicht zurücksetzen
  const keep = ['filter-status', 'filter-land', 'filter-gruppe'].map((id) => [id, $(id).value]);
  const fs = $('filter-status');
  fs.innerHTML = '<option value="">Alle Status</option>' +
    STATUS_KEYS.map((k) => `<option value="${k}">${STATUS[k].label}</option>`).join('');
  const lands = [...new Set(allHotels.map((h) => h.land).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('filter-land').innerHTML = '<option value="">Alle Länder</option>' +
    lands.map((l) => `<option value="${escapeAttr(l)}">${escapeHtml(l)}</option>`).join('');
  const gruppen = [...new Set(allHotels.map((h) => h.gruppe).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('filter-gruppe').innerHTML = '<option value="">Alle Gruppen</option>' +
    gruppen.map((g) => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join('');
  keep.forEach(([id, v]) => {
    const el = $(id);
    if (v && (!el.options || [...el.options].some((o) => o.value === v))) el.value = v;
  });
  renderChips();
}

// ===================== DOPPELKONTAKT-SCHUTZ =====================
// "Bereits im Kontakt" = wir haben diesen Kanal schon angefasst.
const CONTACTED = new Set(['angefragt', 'zusage', 'warten', 'wiedervorlage', 'kooperiert']);
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

// ===================== BACKLOG (Tabelle ht_backlog) =====================
// Seitenweise laden (PostgREST liefert höchstens 1000 Zeilen), Gesamtzahl prüfen, bei Fehler den alten Stand behalten.
async function loadBacklog() {
  const PAGE = 1000, MAX_PAGES = 20;
  const rows = [];
  let total = null, pages = 0, ended = false;
  while ((total === null || rows.length < total) && pages < MAX_PAGES) {
    pages++;
    const { data, error, count } = await sb
      .from('ht_backlog')
      .select('*', total === null ? { count: 'exact' } : {})
      .order('id', { ascending: true })
      .range(rows.length, rows.length + PAGE - 1);
    if (error) {
      console.error(error);
      backlogHinweis = 'Der Backlog konnte nicht geladen werden' + (backlogRows ? ', gezeigt wird der letzte Stand.' : '.');
      renderBacklog();
      return;
    }
    if (total === null && Number.isFinite(count) && count >= 0) total = count;
    if (!data || !data.length) { ended = true; break; }
    rows.push(...data);
  }
  const incomplete = total === null ? !ended : rows.length !== total;
  const prevHinweis = backlogHinweis;
  backlogHinweis = incomplete ? 'Der Backlog ist unvollständig (' + rows.length + (total !== null ? ' von ' + total : '') + ' Einträge). Bitte die Seite neu laden.' : '';
  const stamp = JSON.stringify(rows);
  if (backlogRows && stamp === backlogStamp && !backlogHinweis && !prevHinweis) return; // nothing changed, no redraw
  backlogRows = rows;
  backlogStamp = stamp;
  renderBacklog();
}
function renderBacklog() {
  const body = $('backlog-body');
  if (!body || typeof BacklogView === 'undefined') return;
  BacklogView.render(body, { rows: backlogRows, hinweis: backlogHinweis });
  const c = backlogRows ? BacklogView.build(backlogRows).counts : null;
  $('count-badge').textContent = c ? `${c.open} offen · ${c.done} erledigt` : '';
}
// alle 60 Sekunden nachladen, nur wenn der Reiter sichtbar ist
setInterval(() => { if (appLoaded && activeTab === 'backlog' && document.hidden !== true) loadBacklog(); }, SYNC_MS);

// ===================== TABS (Alle / Hotels / Gruppen) =====================
function switchTab(tab) {
  activeTab = tab;
  gruppenDrilldown = null;
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.className = `tab-btn px-2 sm:px-5 min-h-[44px] text-sm font-medium border-b-2 -mb-px ${on ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-900'}`;
  });
  const showHotels = (tab === 'alle' || tab === 'hotels');
  $('hotels-panel').classList.toggle('hidden', !showHotels);
  $('gruppen-panel').classList.toggle('hidden', tab !== 'gruppen');
  const antwortenPanel = $('antworten-panel'); // missing while a cached older index.html is still served
  if (antwortenPanel) antwortenPanel.classList.toggle('hidden', tab !== 'antworten');
  const terminePanel = $('termine-panel');
  if (terminePanel) terminePanel.classList.toggle('hidden', tab !== 'termine');
  const backlogPanel = $('backlog-panel');
  if (backlogPanel) backlogPanel.classList.toggle('hidden', tab !== 'backlog');
  try { history.replaceState(null, '', tab === 'hotels' ? location.pathname + location.search : '#' + tab); } catch (e) { /* file:// or sandbox */ }
  // Status-Chips sind die Aktiv-Arbeitsliste -> nur im Hotels-Tab sichtbar
  $('quick-chips').classList.toggle('hidden', tab !== 'hotels');
  if (tab === 'alle') $('filter-status').value = '';
  if (showHotels) render();
  if (tab === 'gruppen') renderGruppen();
  if (tab === 'antworten') {
    renderAntworten();
    if (!syncState) loadSyncState();
  }
  if (tab === 'termine') {
    renderTermine();
    if (!termineData) loadTermineData();
  }
  if (tab === 'backlog') {
    renderBacklog();
    loadBacklog();
  }
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

// ===================== ANTWORTEN-ANSICHT =====================
// Everything below is derived live from the hotels table (status, ball_bei,
// antwort_stand, antwort_datum, termin_von/bis) plus sync_state for the "Stand"
// line. Only labels and layout live in the code, no business content.
const ANTWORT_ICONS = {
  miri: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  hotel: '<path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  termine: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  absagen: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  spaeter: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  partner: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
};
const ANTWORT_TONES = {
  green: 'bg-green-50 text-green-700',
  red: 'bg-red-50 text-red-700',
  amber: 'bg-amber-50 text-amber-700',
  zinc: 'bg-zinc-100 text-zinc-600',
};
// Date compare on ISO strings, empty dates always last
function cmpIso(a, b, dir) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -dir : a > b ? dir : 0;
}
const ANTWORT_SECTIONS = [
  { key: 'miri', label: 'Wartet auf uns', note: 'Hier schuldet Miri eine Antwort oder Lieferung. Das am längsten Wartende steht oben.',
    empty: 'Nichts offen, alle Antworten sind erledigt.',
    pick: (h) => h.ball_bei === 'miri', sort: (a, b) => cmpIso(a.antwort_datum, b.antwort_datum, 1) },
  { key: 'termine', label: 'Termine', note: 'Vereinbarte und angebotene Aufenthalte, der nächste zuerst.',
    empty: 'Keine anstehenden Termine eingetragen.',
    pick: (h) => !!h.termin_von && (h.termin_bis || h.termin_von) >= isoToday(), sort: (a, b) => cmpIso(a.termin_von, b.termin_von, 1) },
  { key: 'hotel', label: 'Ball beim Hotel', note: 'Miri hat geantwortet oder angeboten, jetzt ist das Hotel am Zug. Das am längsten Wartende steht oben.',
    empty: 'Kein Hotel schuldet gerade eine Antwort.',
    pick: (h) => h.ball_bei === 'hotel', sort: (a, b) => cmpIso(a.antwort_datum, b.antwort_datum, 1) },
  { key: 'spaeter', label: 'Später wieder', note: 'Weiche Absagen („aktuell“, „derzeit“). Kein endgültiges Nein, später neu anfragen.',
    empty: 'Keine Häuser auf Wiedervorlage.',
    pick: (h) => h.status === 'wiedervorlage' && !!h.antwort_stand, sort: (a, b) => cmpIso(a.antwort_datum, b.antwort_datum, -1) },
  { key: 'absagen', label: 'Absagen', note: 'Grundsätzliches Nein. Keine Aktion nötig.',
    empty: 'Keine Absagen eingetragen.',
    pick: (h) => h.status === 'antwort_negativ' && !!h.antwort_stand, sort: (a, b) => cmpIso(a.antwort_datum, b.antwort_datum, -1) },
  { key: 'partner', label: 'Partner', note: 'Kooperationen mit aktuellem Stand.',
    empty: 'Noch keine Partner mit Stand eingetragen.',
    pick: (h) => h.status === 'kooperiert' && !!h.antwort_stand, sort: (a, b) => cmpIso(a.antwort_datum, b.antwort_datum, -1) },
];

function isoToday() { // YYYY-MM-DD in local time, independent of browser locale support
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayDiff(iso) { // days from today to iso (negative = in the past)
  return Math.round((new Date(iso + 'T00:00:00') - new Date(isoToday() + 'T00:00:00')) / 86400000);
}
function daysSince(iso) { return Math.max(0, -dayDiff(iso)); }
function agoText(d) {
  if (d === 0) return 'heute';
  if (d === 1) return '1 Tag';
  return d < 60 ? `${d} Tagen` : `${Math.round(d / 30)} Monaten`;
}

function antwortPill(key, h) {
  const d = h.antwort_datum ? daysSince(h.antwort_datum) : null;
  const since = d == null ? null : (d === 0 ? 'heute' : 'seit ' + agoText(d));
  if (key === 'miri') return since ? [since, d >= 30 ? 'red' : d >= 14 ? 'amber' : 'zinc'] : ['wartet auf uns', 'amber'];
  if (key === 'hotel') return since ? [since, d >= 30 ? 'amber' : 'zinc'] : ['wartet', 'zinc'];
  if (key === 'termine') {
    if (h.status === 'kooperiert') return ['fix', 'green'];
    if (h.ball_bei === 'miri') return ['wartet auf uns', 'amber'];
    if (h.ball_bei === 'hotel') return ['wartet auf Hotel', 'amber'];
    return ['bestätigt', 'green'];
  }
  if (key === 'absagen') return ['Absage', 'red'];
  if (key === 'spaeter') return ['später', 'amber'];
  return ['Partner', 'green'];
}

function antwortDateBadge(h) {
  const d = new Date(h.termin_von + 'T00:00:00');
  const mon = d.toLocaleDateString('de-AT', { month: 'short' }).replace('.', '');
  return `<div class="shrink-0 w-12 text-center rounded-lg bg-zinc-50 border border-zinc-200 py-2 self-start">
    <div class="text-xs text-zinc-400 uppercase">${escapeHtml(mon)}</div>
    <div class="text-sm font-medium text-zinc-900 tabular-nums">${d.getDate()}</div>
  </div>`;
}
function antwortTerminText(h) {
  const n = dayDiff(h.termin_von);
  const rel = n > 1 ? `in ${n} Tagen` : n === 1 ? 'morgen' : n === 0 ? 'heute' : 'läuft gerade';
  const range = (!h.termin_bis || h.termin_bis === h.termin_von)
    ? formatDate(h.termin_von)
    : `${formatDate(h.termin_von).slice(0, 6)} bis ${formatDate(h.termin_bis)}`;
  return `${range} · ${rel}`;
}

function antwortCardHtml(key, h, i) {
  const [pillText, tone] = antwortPill(key, h);
  const place = [h.ort, h.land].filter(Boolean).join(', ');
  const mail = h.email_1 || h.email_allgemein || h.email_2 || '';
  const waiting = (key === 'miri' || key === 'hotel') && h.antwort_datum ? daysSince(h.antwort_datum) : null;
  const bar = waiting == null ? '' :
    `<div class="h-1 rounded-full bg-zinc-100 mt-3 overflow-hidden"><div class="h-full rounded-full ${waiting >= 30 ? 'bg-red-400' : waiting >= 14 ? 'bg-amber-400' : 'bg-zinc-300'}" style="width:${Math.min(100, Math.round(waiting / 60 * 100))}%"></div></div>`;
  const lead = key === 'termine' ? antwortDateBadge(h) : '';
  const meta = key === 'termine' ? antwortTerminText(h) : (h.antwort_datum ? formatDate(h.antwort_datum) : '');
  return `<div class="rv" style="transition-delay:${Math.min(i, 6) * 40}ms">
    <article class="lift bg-white border border-zinc-200 rounded-xl card-shadow p-4 flex gap-3">
      ${lead}
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-zinc-900">${escapeHtml(h.hotelname)}</div>
            ${place ? `<div class="text-xs text-zinc-400">${escapeHtml(place)}</div>` : ''}
          </div>
          <span class="shrink-0 text-xs rounded-full px-2 py-1 ${ANTWORT_TONES[tone]}">${escapeHtml(pillText)}</span>
        </div>
        <p class="text-sm text-zinc-600 mt-2">${escapeHtml(h.antwort_stand || '')}</p>
        ${bar}
        <div class="mt-3 flex items-center justify-between gap-3 text-xs text-zinc-400">
          <span class="font-mono truncate">${escapeHtml(mail)}</span>
          <span class="shrink-0">${escapeHtml(meta)}</span>
        </div>
      </div>
    </article>
  </div>`;
}

function antwortSectionHtml(sec, rows) {
  const shown = antwortenFilter ? rows : rows.slice(0, 5);
  const more = rows.length - shown.length;
  const cards = shown.length
    ? shown.map((h, i) => antwortCardHtml(sec.key, h, i)).join('')
    : `<div class="text-sm text-zinc-400 bg-white border border-dashed border-zinc-200 rounded-xl p-6 text-center">${escapeHtml(sec.empty)}</div>`;
  return `<section class="mb-6">
    <div class="flex items-baseline gap-2 mb-1">
      <h3 class="text-sm font-medium text-zinc-900">${escapeHtml(sec.label)}</h3>
      <span class="text-xs text-zinc-400 tabular-nums">${rows.length}</span>
    </div>
    <p class="text-xs text-zinc-500 mb-3">${escapeHtml(sec.note)}</p>
    <div class="space-y-3">${cards}</div>
    ${more > 0 ? `<button type="button" data-antwort-tile="${sec.key}" class="mt-3 text-sm text-zinc-500 hover:text-zinc-900 underline underline-offset-4" style="min-height:44px">Alle ${rows.length} anzeigen</button>` : ''}
  </section>`;
}

function antwortTilesHtml(counts) {
  const tone = { miri: 'text-red-600', hotel: 'text-amber-600', spaeter: 'text-amber-600', partner: 'text-green-600' };
  return ANTWORT_SECTIONS.map((s) => {
    const on = antwortenFilter === s.key;
    const iconCls = counts[s.key] > 0 && tone[s.key] ? tone[s.key] : 'text-zinc-400';
    return `<button type="button" data-antwort-tile="${s.key}" aria-pressed="${on}"
      class="lift flex flex-col items-start gap-1 p-4 rounded-xl border bg-white card-shadow text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 ${on ? 'border-zinc-900' : 'border-zinc-200'}" style="min-height:44px">
      <svg class="w-5 h-5 ${iconCls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ANTWORT_ICONS[s.key]}</svg>
      <span class="text-xl font-semibold tabular-nums mt-2">${counts[s.key]}</span>
      <span class="text-xs text-zinc-500">${escapeHtml(s.label)}</span>
    </button>`;
  }).join('');
}

// Returns plain text (contains a hotel name): the caller must escapeHtml it.
function antwortSummary(counts, termine) {
  const parts = [
    counts.miri ? `${counts.miri} ${counts.miri === 1 ? 'Hotel wartet' : 'Hotels warten'} auf Miri` : 'Nichts wartet auf Miri',
    `${counts.hotel} ${counts.hotel === 1 ? 'Hotel ist' : 'Hotels sind'} am Zug`,
  ];
  const next = termine[0];
  if (next) {
    const n = dayDiff(next.termin_von);
    parts.push(`nächster Termin: ${next.hotelname} ${n > 1 ? 'in ' + n + ' Tagen' : n === 1 ? 'morgen' : n === 0 ? 'heute' : 'läuft gerade'}`);
  }
  return parts.join(' · ');
}

function antwortStandLine() {
  if (!syncState) return 'Gmail-Stand wird geladen …';
  const stamps = ['gmail_eingang', 'gmail_ausgang'].map((k) => syncState[k]).filter(Boolean).map((s) => new Date(s));
  if (!stamps.length) return 'Gmail-Stand unbekannt';
  const oldest = new Date(Math.min(...stamps));
  return 'Gmail geprüft bis ' + oldest.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna' }) + ' Uhr';
}

// Horizontal bars, neutral colours: how all houses spread over the statuses
function antwortPipelineHtml() {
  const counts = {};
  STATUS_KEYS.forEach((k) => (counts[k] = 0));
  allHotels.forEach((h) => { if (counts[h.status] != null) counts[h.status]++; });
  const max = Math.max(1, ...Object.values(counts));
  const rows = STATUS_KEYS.filter((k) => counts[k] > 0).map((k) => `
    <div class="flex items-center gap-3 py-1">
      <span class="w-28 shrink-0 text-xs text-zinc-600">${escapeHtml(STATUS[k].label)}</span>
      <div class="flex-1 h-1 rounded-full bg-zinc-100 overflow-hidden"><div class="h-full rounded-full bg-zinc-900" style="width:${Math.round(counts[k] / max * 100)}%"></div></div>
      <span class="w-12 text-right text-xs text-zinc-500 tabular-nums">${counts[k]}</span>
    </div>`).join('');
  return `<section class="mb-6">
    <div class="flex items-baseline gap-2 mb-1">
      <h3 class="text-sm font-medium text-zinc-900">Alle Häuser im Überblick</h3>
      <span class="text-xs text-zinc-400 tabular-nums">${allHotels.length}</span>
    </div>
    <p class="text-xs text-zinc-500 mb-3">So verteilen sich alle Häuser auf die Status.</p>
    <div class="bg-white border border-zinc-200 rounded-xl card-shadow p-4">
      ${rows}
    </div>
  </section>`;
}

function renderAntworten() {
  const body = $('antworten-body');
  if (!body) return;
  const data = {};
  ANTWORT_SECTIONS.forEach((s) => { data[s.key] = allHotels.filter(s.pick).sort(s.sort); });
  const counts = Object.fromEntries(ANTWORT_SECTIONS.map((s) => [s.key, data[s.key].length]));
  $('count-badge').textContent = `${counts.miri} warten auf Miri`;
  const visible = ANTWORT_SECTIONS.filter((s) => !antwortenFilter || s.key === antwortenFilter);
  body.innerHTML = `
    <div class="mb-6">
      <h2 class="text-xl font-semibold">Antworten</h2>
      <p class="text-sm text-zinc-600 mt-1">${escapeHtml(antwortSummary(counts, data.termine))}</p>
      <p class="text-sm text-zinc-400 mt-1">${escapeHtml(antwortStandLine())}</p>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">${antwortTilesHtml(counts)}</div>
    ${antwortenFilter ? '<button type="button" data-antwort-reset class="mb-3 text-sm text-zinc-500 hover:text-zinc-900 underline underline-offset-4" style="min-height:44px">Alle Bereiche anzeigen</button>' : ''}
    ${visible.map((s) => antwortSectionHtml(s, data[s.key])).join('')}
    ${antwortenFilter ? '' : antwortPipelineHtml()}`;
  wireAntworten(body);
}

function wireAntworten(root) {
  root.querySelectorAll('[data-antwort-tile]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.antwortTile;
      antwortenFilter = antwortenFilter === k ? null : k;
      renderAntworten();
    });
  });
  const reset = root.querySelector('[data-antwort-reset]');
  if (reset) reset.addEventListener('click', () => { antwortenFilter = null; renderAntworten(); });
  // fade-in on scroll (CSS turns it off for reduced motion)
  const els = root.querySelectorAll('.rv');
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('rv-in')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('rv-in'); io.unobserve(en.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  els.forEach((e) => io.observe(e));
}

// ---- Status-Chips (Schnellfilter) ----
// Ein Chip je Status aus status_defs (Name, Farbe, Reihenfolge), mit der Zahl der Häuser. Der Chip ist Filter und
// Farblegende zugleich: Klick zeigt nur diesen Status, nochmal Klick hebt den Filter auf. Welcher Chip aktiv ist,
// steht allein im Status-Auswahlfeld, die Chips sind nur seine Anzeige.
function quickCount(status) {
  return allHotels.filter((h) => h.status === status).length;
}
function renderChips() {
  const wrap = $('quick-chips');
  if (!wrap) return;
  const current = $('filter-status').value;
  const hints = Object.fromEntries(LEGEND);
  wrap.innerHTML = STATUS_KEYS.map((k) => {
    const on = current === k;
    const cls = `text-xs px-3 py-1.5 rounded-full border transition-colors ${STATUS[k].cls} ${on ? 'border-zinc-900' : 'border-transparent hover:brightness-95'}`;
    const hint = (hints[k] || '') + (on ? ' (Nochmal klicken hebt den Filter auf.)' : '');
    return `<button data-status="${k}" aria-pressed="${on}" title="${escapeAttr(hint)}" class="${cls}">${STATUS[k].label}<span class="ml-1 opacity-70">${quickCount(k)}</span></button>`;
  }).join('');
  wrap.querySelectorAll('button[data-status]').forEach((b) => {
    b.addEventListener('click', () => applyQuick(b.dataset.status));
  });
}
function applyQuick(status) {
  const s = $('filter-status');
  s.value = s.value === status ? '' : status;
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
    <td class="px-3 py-2.5 align-top text-zinc-600 max-w-[240px] hidden md:table-cell">${bemerkungCell(h.bemerkung)}</td>
    <td class="px-3 py-2.5 align-top text-zinc-600 max-w-[220px] hidden lg:table-cell">
      ${h.auswahl_grund ? `<div class="text-xs text-zinc-600">${escapeHtml(h.auswahl_grund)}</div>` : '<span class="text-zinc-300">—</span>'}
      ${h.preis_ab ? `<div class="text-xs text-zinc-400 mt-0.5">ab ${escapeHtml(String(h.preis_ab))} ${escapeHtml(h.waehrung || 'EUR')}${h.preis_basis ? ' / ' + escapeHtml(h.preis_basis) : ''}</div>` : ''}
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
     </div>
     <div class="flex items-start gap-2 py-1">
       <span class="text-xs rounded-full px-2.5 py-1 whitespace-nowrap bg-zinc-100 text-zinc-600">Nachfassen bereit</span>
       <span class="text-xs text-zinc-600">Ebenfalls nur eine Markierung: zum Nachfassen freigegeben, seit über 60 Tagen keine Antwort. Noch keine Welle geplant.</span>
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
$('filter-status').addEventListener('change', render);
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
// Datumsspalte: Partner zeigen den Aufenthalt (von bis, aus termin_von/termin_bis) mit Hotel-Icon, nie das Anfragedatum.
// Fehlt das Datum, steht das sichtbar da, statt still das Anfragedatum zu zeigen.
function stayRange(h) {
  if (!h.termin_von) return '';
  const von = formatDate(h.termin_von);
  if (!h.termin_bis || h.termin_bis === h.termin_von) return von;
  return `${von.slice(0, 6)} bis ${formatDate(h.termin_bis)}`;
}
function dateCell(h) {
  if (h.status === 'kooperiert') {
    const r = stayRange(h);
    return r
      ? `<span class="text-violet-700 whitespace-nowrap" title="Aufenthalt / Kooperation">🏨 ${r}</span>`
      : '<span class="text-amber-600 whitespace-nowrap" title="Für diesen Partner ist kein Aufenthaltsdatum eingetragen">🏨 Datum offen</span>';
  }
  return h.angefragt_am ? formatDate(h.angefragt_am) : '<span class="text-zinc-300">—</span>';
}
// Bemerkung kompakt: eine einzige Zeile mit dem Anfang, ein Klick klappt alle Teile auf (Teile sind mit "·" oder " | " getrennt)
function bemerkungCell(text) {
  const parts = String(text || '').split(/\s+\|\s+|\s*·\s*/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '<span class="text-zinc-300">—</span>';
  if (parts.length === 1 && parts[0].length <= 36) return `<span class="text-xs text-zinc-600">${escapeHtml(parts[0])}</span>`; // passt in die Zeile
  const more = parts.length > 1 ? `<span class="group-open:hidden shrink-0 text-zinc-400">+${parts.length - 1}</span>` : '';
  return `<details class="group text-xs text-zinc-600 w-56">
      <summary class="flex items-baseline gap-1 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span class="group-open:hidden truncate" title="Klicken für die ganze Bemerkung">${escapeHtml(parts[0])}</span>${more}
        <span class="hidden group-open:inline text-zinc-400">weniger</span>
      </summary>
      <div class="mt-1 space-y-1">${parts.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</div>
    </details>`;
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
    // project: drei Apps teilen sich diese Tabelle (Fitness, HeritageTraveler,
    // Kooperation). Ohne Herkunft ist ein Eintrag hinterher nicht zuzuordnen.
    const { error } = await sb.from('feedback').insert({ message: text, project: 'heritagetraveler' });
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
