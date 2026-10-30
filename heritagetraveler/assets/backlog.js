// ============================================
// Backlog: Aufgaben und Feedback des Projekts
// ============================================
// Reines Rendering ohne Supabase-Zugriff (Laden macht app.js). Alle Einträge, Gruppennamen und Zahlen
// kommen aus der Tabelle ht_backlog; im Code stehen nur Labels und Layout. Jeder Text aus der DB wird
// mit esc() maskiert, Feedback stammt von Nutzern.
const BacklogView = (() => {
  const FEEDBACK = 'feedback';
  const NO_GROUP = 'Ohne Gruppe';
  // Vorbewertung: Label und Farbe; Farbe nur als Semantik (grün = los, gelb = Achtung), sonst neutral
  const VORB = {
    go: { label: 'Umsetzbar', cls: 'bg-green-50 text-green-700' },
    warn: { label: 'Achtung', cls: 'bg-amber-50 text-amber-700' },
    team: { label: 'Mit Team klären', cls: 'bg-zinc-100 text-zinc-600' },
    clarify: { label: 'Rückfrage', cls: 'bg-zinc-100 text-zinc-600' },
    later: { label: 'Später', cls: 'bg-zinc-100 text-zinc-500' },
  };
  const PROJECT = { heritagetraveler: 'Heritage', kooperation: 'Kooperation' };

  // state survives re-renders from the 60 second reload
  const openRows = new Set();   // ids of expanded rows
  const openDone = new Set();   // group keys with the done rows unfolded
  let rootRef = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const isDone = (r) => r.status === 'done';
  const text = (v) => (v == null ? '' : String(v)).trim();

  function dateText(v) {
    const t = Date.parse(v);
    if (!v || isNaN(t)) return '';
    return new Date(t).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function ts(v) { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
  const byId = (a, b) => num(a.id, 0) - num(b.id, 0);

  // ---------- Modell ----------
  function build(rows) {
    const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    const fb = list.filter((r) => r.type === FEEDBACK)
      .sort((a, b) => (ts(b.created_at) - ts(a.created_at)) || (num(b.id, 0) - num(a.id, 0)));
    const groups = new Map();
    for (const r of list) {
      if (r.type === FEEDBACK) continue;
      const name = text(r.category) || NO_GROUP;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(r);
    }
    const prio = (r) => num(r.priority, 1e9);
    const tasks = [...groups].map(([name, items]) => {
      const open = items.filter((r) => !isDone(r)).sort((a, b) => (prio(a) - prio(b)) || byId(a, b));
      const done = items.filter(isDone).sort((a, b) => (ts(b.done_at) - ts(a.done_at)) || byId(b, a));
      const best = open.length ? prio(open[0]) : 2e9; // groups with open tasks come first, smallest priority first
      return { name, open, done, best };
    }).sort((a, b) => (a.best - b.best) || a.name.localeCompare(b.name, 'de'));
    const done = list.filter(isDone).length;
    return { feedback: fb, tasks, counts: { total: list.length, open: list.length - done, done, feedback: fb.length } };
  }

  // ---------- HTML ----------
  function chip(r) {
    const s = text(r.vorbewertung_status);
    if (!s) return '';
    const v = VORB[s] || { label: s, cls: 'bg-zinc-100 text-zinc-600' };
    return `<span class="shrink-0 px-2 py-0.5 rounded-full text-xs ${v.cls}">${esc(v.label)}</span>`;
  }
  function projectMark(r) {
    const p = text(r.project);
    if (!p) return '';
    return `<span class="shrink-0 px-2 py-0.5 rounded-full text-xs bg-zinc-100 text-zinc-600">${esc(PROJECT[p] || p)}</span>`;
  }
  function detailBlock(label, v) {
    const t = text(v);
    return t ? `<div><div class="text-xs text-zinc-400">${label}</div><p class="text-sm text-zinc-700 whitespace-pre-wrap break-words">${esc(t)}</p></div>` : '';
  }
  function rowHtml(r, showCategory) {
    const key = esc(r.id);
    const done = isDone(r);
    const open = openRows.has(String(r.id));
    const when = done ? (dateText(r.done_at) ? 'erledigt ' + dateText(r.done_at) : 'erledigt') : (showCategory ? dateText(r.created_at) : '');
    const cat = showCategory && text(r.category) ? `<span class="shrink-0 px-2 py-0.5 rounded-full text-xs border border-zinc-200 text-zinc-500">${esc(r.category)}</span>` : '';
    const details = detailBlock('Beschreibung', r.description) + detailBlock('Notizen', r.notes) + detailBlock('Vorbewertung', r.vorbewertung)
      + (text(r.gruppe) ? detailBlock('Gruppe', r.gruppe) : '');
    return `<div class="border-t border-zinc-100 first:border-t-0">
      <button type="button" data-bl="${key}" aria-expanded="${open ? 'true' : 'false'}" class="w-full text-left flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 hover:bg-zinc-50 transition-colors${done ? ' opacity-60' : ''}" style="min-height:44px">
        <span class="shrink-0 font-mono text-xs text-zinc-400">#${key}</span>
        <span class="min-w-0 flex-1 basis-48 text-sm ${done ? 'text-zinc-500 line-through' : 'text-zinc-900'} break-words">${esc(r.title || '(ohne Titel)')}</span>
        ${projectMark(r)}${cat}${chip(r)}
        ${when ? `<span class="shrink-0 text-xs text-zinc-400">${esc(when)}</span>` : ''}
      </button>
      <div class="${open ? '' : 'hidden '}px-4 pb-3 space-y-2" data-bl-detail="${key}">${details || '<p class="text-sm text-zinc-400">Keine weiteren Angaben.</p>'}</div>
    </div>`;
  }
  function cardHtml(title, count, inner) {
    return `<section class="mb-4 bg-white border border-zinc-200 rounded-xl card-shadow overflow-hidden">
      <h3 class="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-200 text-sm font-medium text-zinc-900"><span class="min-w-0 break-words">${esc(title)}</span><span class="shrink-0 text-xs text-zinc-400">${esc(count)}</span></h3>
      ${inner}
    </section>`;
  }
  function groupHtml(g) {
    const doneKey = esc(g.name);
    const unfolded = openDone.has(g.name);
    const openRowsHtml = g.open.map((r) => rowHtml(r, false)).join('') || '<p class="px-4 py-3 text-sm text-zinc-400">Nichts offen.</p>';
    const doneHtml = g.done.length
      ? `<button type="button" data-bl-done="${doneKey}" aria-expanded="${unfolded ? 'true' : 'false'}" class="w-full text-left px-4 py-2 border-t border-zinc-100 text-xs text-zinc-500 hover:bg-zinc-50" style="min-height:44px">${unfolded ? 'Erledigte ausblenden' : 'Erledigte anzeigen'} (${g.done.length})</button>`
        + (unfolded ? g.done.map((r) => rowHtml(r, false)).join('') : '')
      : '';
    const count = `${g.open.length} offen${g.done.length ? ' · ' + g.done.length + ' erledigt' : ''}`;
    return cardHtml(g.name, count, openRowsHtml + doneHtml);
  }

  // ---------- Einstieg ----------
  // data: { rows, hinweis? }; rows null = lädt noch
  function render(root, data) {
    rootRef = root;
    const rows = data && data.rows;
    const hinweis = data && data.hinweis ? `<p class="mb-3 px-4 py-2 rounded-lg bg-amber-50 text-amber-700 text-sm">${esc(data.hinweis)}</p>` : '';
    if (rows == null) {
      root.innerHTML = hinweis + '<p class="text-sm text-zinc-400 p-4">Backlog wird geladen …</p>';
      return null;
    }
    const m = build(rows);
    const c = m.counts;
    const head = `<div class="mb-4"><h2 class="text-xl font-semibold">Backlog</h2><p class="text-sm text-zinc-600 mt-1">${c.total} Einträge · ${c.open} offen · ${c.done} erledigt</p></div>`;
    let body = '';
    if (!c.total) body = '<p class="text-sm text-zinc-400 p-4">Noch keine Einträge im Backlog.</p>';
    else {
      if (m.feedback.length) body += cardHtml('Feedback', `${m.feedback.filter((r) => !isDone(r)).length} offen · ${m.feedback.length} gesamt`, m.feedback.map((r) => rowHtml(r, true)).join(''));
      body += m.tasks.map(groupHtml).join('');
    }
    root.innerHTML = head + hinweis + body;
    root.onclick = (e) => {
      const t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      const row = t.closest('[data-bl]');
      if (row && root.contains(row)) {
        const id = row.getAttribute('data-bl');
        if (openRows.has(id)) openRows.delete(id); else openRows.add(id);
        render(root, data);
        return;
      }
      const dn = t.closest('[data-bl-done]');
      if (dn && root.contains(dn)) {
        const k = dn.getAttribute('data-bl-done');
        if (openDone.has(k)) openDone.delete(k); else openDone.add(k);
        render(root, data);
      }
    };
    return m;
  }

  return { render, build };
})();
