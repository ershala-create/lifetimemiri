// ============================================
// Termine: Terminübersicht für Miri
// ============================================
// Reines Rendering ohne Supabase-Zugriff. Genutzt vom Reiter "Termine" (app.js)
// und vom Standalone-Export. Alle Inhalte kommen aus der DB (hotels, plan_termine,
// schulferien, miri_todos, status_defs); im Code stehen nur Labels und Layout.
//
// Ampel für Hotelkooperationen:
//   grün = fix (Termin steht), gelb = in Verhandlung (Datum noch nicht bestätigt),
//   rot = Achtung (Miri muss bald handeln oder Konflikt mit einem fixen Termin),
//   grau gestrichelt = angebotenes Fenster (Option). Andere Termine (Events) sind dunkel und getrennt.
const TerminePlan = (() => {
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const WEEKDAYS = ['M', 'D', 'M', 'D', 'F', 'S', 'S'];
  const MONTH_COUNT = 12;
  const MAX_SPAN = 400;      // Schutz gegen absurde Zeiträume in den Daten
  const URGENT_DAYS = 21;    // ab so vielen Tagen vor dem Termin wird "Miri am Zug" rot
  const AMPEL = {
    gruen: { label: 'Fix', dot: 'bg-green-500', pill: 'bg-green-50 text-green-700', cell: 'bg-green-500 text-white', bar: 'bg-green-500' },
    gelb: { label: 'In Verhandlung', dot: 'bg-amber-400', pill: 'bg-amber-50 text-amber-700', cell: 'bg-amber-400 text-zinc-900', bar: 'bg-amber-400' },
    rot: { label: 'Achtung', dot: 'bg-red-500', pill: 'bg-red-50 text-red-700', cell: 'bg-red-500 text-white', bar: 'bg-red-500' },
    grau: { label: 'Angebotenes Fenster', dot: 'bg-white border border-dashed border-zinc-400', pill: 'bg-zinc-100 text-zinc-600', cell: 'bg-white border border-dashed border-zinc-400 text-zinc-700', bar: 'bg-zinc-300' },
    event: { label: 'Anderer Termin', dot: 'bg-zinc-900', pill: 'bg-zinc-900 text-white', cell: 'bg-zinc-900 text-white', bar: 'bg-zinc-900' },
  };
  const PRIO = { rot: 4, gruen: 3, gelb: 2, grau: 1 };
  const BALL = { miri: 'Miri ist am Zug', hotel: 'Hotel ist am Zug' };
  const TODO_DOT = { rot: 'bg-red-500', gelb: 'bg-amber-400', gruen: 'bg-green-500' };
  const TODO_ORDER = { rot: 0, gelb: 1, gruen: 2 };
  // Streifen unter dem Tag im Kalender: bleibt sichtbar, auch wenn der Tag durch einen Termin eingefärbt ist
  const FERIEN_STRIP = { ferien: 'bg-zinc-500', schulfrei: 'bg-zinc-300' };
  // Listen hinter den Chips der Legende
  const LIST_HEAD = {
    fix: { title: 'Fix', sub: 'Alle fixierten Kooperationen. Ab heute in voller Farbe, bereits Durchgeführtes ausgegraut.' },
    verhandlung: { title: 'In Verhandlung', sub: 'Alle Häuser mit Zusage, deren Termin noch nicht fix ist.' },
    achtung: { title: 'Achtung', sub: 'Hier muss Miri bald handeln oder ein Termin überschneidet sich mit einem fixen Termin.' },
    fenster: { title: 'Angebotene Fenster', sub: 'Zeitfenster, die wir den Häusern vorgeschlagen haben oder die sie angeboten haben.' },
    ferien: { title: 'Schulferien und Feiertage', sub: 'Ab heute.' },
  };

  let state = { model: null, status: {}, lastFocus: null, current: null };

  // ---------- Helfer ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const toDate = (iso) => new Date(iso + 'T00:00:00');
  const dateIso = (dt) => isoOf(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const addDays = (iso, n) => { const d = toDate(iso); d.setDate(d.getDate() + n); return dateIso(d); };
  const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const fmtDM = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
  const fmtDMY = (iso) => `${fmtDM(iso)}${iso.slice(0, 4)}`;
  function fmtRange(von, bis) {
    if (!bis || bis === von) return fmtDMY(von);
    return von.slice(0, 4) === bis.slice(0, 4) ? `${fmtDM(von)} bis ${fmtDMY(bis)}` : `${fmtDMY(von)} bis ${fmtDMY(bis)}`;
  }
  // Kurzform für Listen: "27.–29." im selben Monat, sonst "31.10.–02.11."
  function fmtShort(von, bis) {
    if (!bis || bis === von) return fmtDM(von);
    return von.slice(0, 7) === bis.slice(0, 7) ? `${von.slice(8, 10)}.–${bis.slice(8, 10)}.` : `${fmtDM(von)}–${fmtDM(bis)}`;
  }
  // Datum fuer Listen: "27.–29.11.2026", "31.10.–02.11.2026", "30.12.2026–02.01.2027", ein Tag "04.11.2026"
  function fmtList(von, bis) {
    if (!bis || bis === von) return fmtDMY(von);
    if (von.slice(0, 4) !== bis.slice(0, 4)) return `${fmtDMY(von)}–${fmtDMY(bis)}`;
    return von.slice(0, 7) === bis.slice(0, 7) ? `${von.slice(8, 10)}.–${fmtDMY(bis)}` : `${fmtDM(von)}–${fmtDMY(bis)}`;
  }
  // Bundesland, sonst Land (beides aus der DB)
  const bl = (h) => h.bundesland || h.land || '';
  const nightsText = (von, bis) => {
    const n = diffDays(von, bis || von);
    return n <= 0 ? 'Tagestermin' : `${n} ${n === 1 ? 'Nacht' : 'Nächte'}`;
  };
  function relText(von, bis, today) {
    if ((bis || von) < today) return 'vorbei';
    if (von <= today) return 'läuft gerade';
    const n = diffDays(today, von);
    return n === 1 ? 'morgen' : `in ${n} Tagen`;
  }
  // Nur http(s)-Links aus der DB werden zu href (kein javascript: o. ä.)
  const safeUrl = (u) => {
    const s = String(u || '').trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
  };
  // Mail-Link: nur Gmail-Weboberfläche
  const safeMailUrl = (u) => {
    const s = String(u || '').trim();
    return /^https:\/\/mail\.google\.com\/mail\/[^\s"'<>]+$/.test(s) ? s : '';
  };
  const hotelUrl = (h) => safeUrl(h.homepage);
  const hotelSearchUrl = (h) => `https://www.google.com/search?q=${encodeURIComponent([h.hotelname, h.ort].filter(Boolean).join(' '))}`;
  const mapsUrl = (h) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([h.hotelname, h.ort, h.land].filter(Boolean).join(', '))}`;
  const cut = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + ' …' : t; };
  // Tage von..bis (inklusive), begrenzt gegen absurde Daten
  function eachDay(von, bis, fn) {
    if (!isIso(von) || !isIso(bis)) return;
    const last = addDays(von, MAX_SPAN);
    const end = bis < last ? bis : last;
    for (let d = von; d <= end; d = addDays(d, 1)) fn(d);
  }

  // ---------- Modell ----------
  function build({ hotels, plan, ferien, todos, today }) {
    const byId = new Map(hotels.map((h) => [h.id, h]));
    const months = [];
    const start = new Date(+today.slice(0, 4), +today.slice(5, 7) - 1, 1);
    for (let i = 0; i < MONTH_COUNT; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      months.push({ y: d.getFullYear(), m: d.getMonth() });
    }
    const calStart = isoOf(months[0].y, months[0].m, 1);
    const lastM = months[months.length - 1];
    const calEnd = isoOf(lastM.y, lastM.m, new Date(lastM.y, lastM.m + 1, 0).getDate());

    // Tag -> { art: 'ferien' | 'schulfrei', name }
    const ferienDay = {};
    (ferien || []).forEach((f) => {
      eachDay(f.von, f.bis, (d) => {
        if (f.art === 'ferien') ferienDay[d] = { art: 'ferien', name: f.bezeichnung };
        else if (!ferienDay[d]) ferienDay[d] = { art: 'schulfrei', name: f.bezeichnung };
      });
    });

    const items = [];
    // dates that are not plain YYYY-MM-DD (e.g. Postgres "infinity") are skipped instead of breaking the whole view
    hotels.forEach((h) => {
      if (!isIso(h.termin_von)) return;
      const bis = isIso(h.termin_bis) ? h.termin_bis : h.termin_von;
      if (bis < today) return;
      const art = (h.status === 'kooperiert' || !h.ball_bei) ? 'fix' : 'verhandlung';
      items.push({ key: 'h:' + h.id, hotel: h, art, von: h.termin_von, bis, titel: h.hotelname, notiz: '' });
    });
    (plan || []).forEach((p) => {
      if (!isIso(p.von) || !isIso(p.bis) || p.bis < today) return;
      const hotel = p.hotel_id ? byId.get(p.hotel_id) : null;
      if (p.hotel_id && !hotel) return;
      const titel = p.art === 'event' && p.titel ? p.titel : (hotel ? hotel.hotelname : p.titel);
      items.push({ key: 'p:' + p.id, hotel, art: p.art, von: p.von, bis: p.bis, titel, notiz: p.notiz || '' });
    });
    items.sort((a, b) => (a.von < b.von ? -1 : a.von > b.von ? 1 : a.bis < b.bis ? -1 : a.bis > b.bis ? 1 : 0));

    // Überschneidungen: nur wenn mindestens eine Seite fix, in Verhandlung oder ein Event ist
    const commit = (x) => x.art === 'fix' || x.art === 'verhandlung' || x.art === 'event';
    const sameHotel = (a, b) => a.hotel && b.hotel && a.hotel.id === b.hotel.id;
    items.forEach((it) => {
      it.konflikte = items.filter((o) => o !== it && !sameHotel(it, o) && o.von <= it.bis && o.bis >= it.von && (commit(it) || commit(o)));
    });
    // Ampel je Eintrag
    items.forEach((it) => {
      if (it.art === 'event') { it.ampel = 'event'; return; }
      if (it.art === 'angebot') { it.ampel = 'grau'; return; }
      const days = diffDays(today, it.von);
      const fixConflict = it.konflikte.some((k) => k.art === 'fix');
      it.ampelGrund = '';
      if (it.art === 'fix') {
        it.ampel = fixConflict ? 'rot' : 'gruen';
        if (fixConflict) it.ampelGrund = 'Überschneidung mit einem anderen fixen Termin';
      } else if (days <= 7) {
        it.ampel = 'rot';
        it.ampelGrund = 'Termin in wenigen Tagen und noch nicht bestätigt';
      } else if (it.hotel && it.hotel.ball_bei === 'miri' && days <= URGENT_DAYS) {
        it.ampel = 'rot';
        it.ampelGrund = 'Miri muss bald antworten';
      } else if (fixConflict) {
        it.ampel = 'rot';
        it.ampelGrund = 'Überschneidung mit einem fixen Termin';
      } else {
        it.ampel = 'gelb';
      }
    });

    // Hauptmonat: bei Terminen über zwei Monate steht der Eintrag nur in dem Monat mit den meisten Tagen
    items.forEach((it) => {
      const count = {};
      eachDay(it.von, it.bis, (d) => { const ym = d.slice(0, 7); count[ym] = (count[ym] || 0) + 1; });
      let best = it.von.slice(0, 7), n = 0;
      Object.keys(count).sort().forEach((ym) => { if (count[ym] > n) { best = ym; n = count[ym]; } });
      it.mainYM = best;
    });

    // Kalendertage: der wichtigste Eintrag gewinnt (rot vor grün vor gelb vor grau), Events getrennt
    const dayMap = {};
    const eventDays = {};
    items.forEach((it) => {
      eachDay(it.von < calStart ? calStart : it.von, it.bis > calEnd ? calEnd : it.bis, (d) => {
        if (it.art === 'event') { (eventDays[d] = eventDays[d] || []).push(it); return; }
        const cur = dayMap[d];
        if (!cur || PRIO[it.ampel] > PRIO[cur.ampel]) dayMap[d] = it;
      });
    });

    const open = hotels
      .filter((h) => h.status === 'zusage' && !(h.termin_von && (h.termin_bis || h.termin_von) >= today))
      .sort((a, b) => (a.ball_bei === 'miri' ? 0 : 1) - (b.ball_bei === 'miri' ? 0 : 1) || String(a.antwort_datum || '').localeCompare(String(b.antwort_datum || '')));

    const stays = items.filter((i) => i.hotel && (i.art === 'fix' || i.art === 'verhandlung'));
    const windows = (hotelId) => items.filter((i) => i.art === 'angebot' && i.hotel && i.hotel.id === hotelId);

    // ---- Listen hinter den Chips der Legende ----
    const byVon = (a, b) => (a.von || '9999') < (b.von || '9999') ? -1 : (a.von || '9999') > (b.von || '9999') ? 1 : 0;
    // Fix: alle Kooperationen mit Status kooperiert (auch vergangene) plus kuenftige fixe Termine anderer Haeuser
    const fixRows = hotels.filter((h) => h.status === 'kooperiert').map((h) => {
      const von = isIso(h.termin_von) ? h.termin_von : null;
      return { key: 'o:' + h.id, hotel: h, von, bis: isIso(h.termin_bis) ? h.termin_bis : von };
    });
    const seenFix = new Set(fixRows.map((r) => r.hotel.id));
    items.filter((i) => i.hotel && i.art === 'fix' && !seenFix.has(i.hotel.id)).forEach((i) => fixRows.push({ key: i.key, hotel: i.hotel, von: i.von, bis: i.bis }));
    const isFuture = (r) => !!r.bis && r.bis >= today;
    const fixUpcoming = fixRows.filter(isFuture).sort(byVon);
    const fixPast = fixRows.filter((r) => !isFuture(r)).sort((a, b) => String(b.von || '').localeCompare(String(a.von || '')));
    // In Verhandlung: alle Haeuser mit Zusage, deren Termin nicht fix ist (mit eigenem Termin, mit angebotenem Fenster oder ganz ohne Datum)
    const verhRows = hotels
      .filter((h) => (h.status === 'zusage' || stays.some((i) => i.hotel.id === h.id && i.art === 'verhandlung')) && !stays.some((i) => i.hotel.id === h.id && i.art === 'fix'))
      .map((h) => {
        const own = stays.find((i) => i.hotel.id === h.id && i.art === 'verhandlung');
        const win = own ? null : windows(h.id)[0];
        const src = own || win;
        return { key: own ? own.key : 'o:' + h.id, hotel: h, von: src ? src.von : null, bis: src ? src.bis : null, fenster: !own && !!win };
      }).sort(byVon);
    const achtungRows = stays.filter((i) => i.ampel === 'rot').map((i) => ({ key: i.key, hotel: i.hotel, von: i.von, bis: i.bis, grund: i.ampelGrund }));
    const fensterRows = items.filter((i) => i.art === 'angebot' && i.hotel).map((i) => ({ key: i.key, hotel: i.hotel, von: i.von, bis: i.bis }));
    const ferienRows = (ferien || []).filter((f) => isIso(f.von) && isIso(f.bis) && f.bis >= today).slice().sort(byVon);
    const bundeslaender = [...new Set((ferien || []).map((f) => f.bundesland).filter(Boolean))];

    const todoList = (todos || []).filter((t) => !t.erledigt).slice().sort((a, b) =>
      (TODO_ORDER[a.prio] ?? 1) - (TODO_ORDER[b.prio] ?? 1) || String(a.frist || '9999').localeCompare(String(b.frist || '9999')));

    return {
      today, items, open, months, ferien: ferien || [], ferienDay, dayMap, eventDays, todos: todoList, bundeslaender,
      lists: { fixUpcoming, fixPast, verhRows, achtungRows, fensterRows, ferienRows },
      counts: { fix: fixUpcoming.length, verhandlung: verhRows.length, rot: achtungRows.length, fenster: fensterRows.length, ferien: ferienRows.length, open: open.length },
      windows,
      byKey: new Map(items.map((i) => [i.key, i])),
      byId,
    };
  }

  function ferienText(von, bis, ferienDay) {
    if (!isIso(von) || diffDays(von, bis || von) > MAX_SPAN) return '';
    let schultage = 0, weekdays = 0;
    const names = [];
    eachDay(von, bis || von, (d) => {
      const dow = toDate(d).getDay();
      const f = ferienDay[d];
      if (f && f.art === 'ferien' && !names.includes(f.name)) names.push(f.name);
      if (dow === 0 || dow === 6) return;
      weekdays++;
      if (!f) schultage++;
    });
    if (!weekdays) return 'Wochenende';
    if (!schultage) return names.length ? `komplett in den ${names.join(' und ')}` : 'nur schulfreie Tage (Feiertage)';
    const st = `${schultage} ${schultage === 1 ? 'Schultag' : 'Schultage'}`;
    return names.length ? `teils in den ${names.join(' und ')}, ${st}` : `Schulzeit, ${st}`;
  }

  // ---------- HTML-Bausteine ----------
  const linkCls = 'relative z-10 inline-flex items-center text-xs text-zinc-500 hover:text-zinc-900 underline underline-offset-4';
  function linksHtml(h) {
    const hp = hotelUrl(h);
    const mail = safeMailUrl(h.mail_url);
    return `<a class="${linkCls}" style="min-height:32px" href="${esc(hp || hotelSearchUrl(h))}" target="_blank" rel="noopener noreferrer">${hp ? 'Hotel' : 'Hotel (Suche)'} ↗</a>` +
      `<a class="${linkCls}" style="min-height:32px" href="${esc(mapsUrl(h))}" target="_blank" rel="noopener noreferrer">Karte ↗</a>` +
      (mail ? `<a class="${linkCls}" style="min-height:32px" href="${esc(mail)}" target="_blank" rel="noopener noreferrer">Mail ↗</a>` : '');
  }
  const pillHtml = (ampel, text) => `<span class="shrink-0 text-xs rounded-full px-2 py-1 ${AMPEL[ampel].pill}">${esc(text || AMPEL[ampel].label)}</span>`;
  const dotHtml = (ampel) => `<span class="mt-1 shrink-0 inline-block w-2 h-2 rounded-full ${AMPEL[ampel].dot}" aria-hidden="true"></span>`;
  const place = (h) => [h.ort, bl(h)].filter(Boolean).join(', ');
  const sectionHead = (title, count, note) => `<div class="flex items-baseline gap-2 mb-1">
      <h3 class="text-sm font-medium text-zinc-900">${esc(title)}</h3>
      ${count == null ? '' : `<span class="text-xs text-zinc-400 tabular-nums">${count}</span>`}
    </div>${note ? `<p class="text-xs text-zinc-500 mb-3">${esc(note)}</p>` : '<div class="mb-3"></div>'}`;

  // Die Chips der Legende sind Knoepfe: ein Klick oeffnet die Liste dazu (Datum, Hotel, Bundesland oder Land)
  function legendHtml(model) {
    const c = model.counts;
    const chip = (key, swatch, label, count, hint) => `<button type="button" data-open="l:${key}" class="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 text-xs text-zinc-700 hover:border-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20" style="min-height:40px" title="${esc(hint)}" aria-label="${esc(label + ' (' + count + '): Liste öffnen')}">${swatch}<span>${esc(label)}</span><span class="tabular-nums text-zinc-400">${count}</span></button>`;
    const sq = (cls) => `<span class="inline-block w-3 h-3 rounded-sm ${cls}"></span>`;
    const strip = (cls) => `<span class="relative inline-block w-3 h-3 rounded-sm bg-zinc-100 overflow-hidden"><span class="absolute inset-x-0 bottom-0 h-1 ${cls}"></span></span>`;
    const ferienLabel = 'Schulferien' + (model.bundeslaender.length ? ' ' + model.bundeslaender.join(' und ') : '');
    return `<div class="mb-6 flex flex-wrap items-center gap-2">
      ${chip('fix', sq(AMPEL.gruen.dot), 'Fix', c.fix, 'Termin steht: Liste aller fixierten Kooperationen')}
      ${chip('verhandlung', sq(AMPEL.gelb.dot), 'In Verhandlung', c.verhandlung, 'Zusage, Termin noch nicht fix: Liste öffnen')}
      ${chip('achtung', sq(AMPEL.rot.dot), 'Achtung', c.rot, 'Miri muss bald handeln oder Überschneidung mit einem fixen Termin')}
      ${chip('fenster', sq(AMPEL.grau.dot), 'Angebotene Fenster', c.fenster, 'Vorgeschlagene Zeitfenster: Liste öffnen')}
      ${chip('ferien', strip(FERIEN_STRIP.ferien) + strip(FERIEN_STRIP.schulfrei), ferienLabel, c.ferien, 'Schulferien und Feiertage ab heute: Liste öffnen')}
      <span class="inline-flex items-center gap-2 px-1 text-xs text-zinc-500"><span class="inline-block w-1 h-1 rounded-full bg-zinc-900"></span>Anderer Termin (kein Hotel)</span>
    </div>`;
  }

  function headerHtml(model, hinweis) {
    const c = model.counts;
    const next = model.items.find((i) => i.hotel && (i.art === 'fix' || i.art === 'verhandlung'));
    const nextTxt = next ? ` · nächster Termin: ${next.titel} ${relText(next.von, next.bis, model.today)}` : '';
    return `<div class="mb-6">
      <h2 class="text-xl font-semibold">Termine</h2>
      <p class="text-sm text-zinc-600 mt-1">${esc(`${c.fix} fix anstehend · ${c.verhandlung} in Verhandlung · ${c.rot} Achtung${nextTxt}`)}</p>
      ${hinweis ? `<p class="text-sm text-amber-700 mt-2">${esc(hinweis)}</p>` : ''}
    </div>`;
  }

  // ---- To-do für Miri (kompakt: fünf sichtbar, Rest aufklappbar) ----
  function todoRow(t, model) {
    const h = t.hotel_id ? model.byId.get(t.hotel_id) : null;
    const frist = isIso(t.frist) ? `<span class="shrink-0 text-xs text-zinc-500 tabular-nums">bis ${esc(fmtDM(t.frist))}</span>` : '';
    const inner = `<span class="mt-1 shrink-0 inline-block w-2 h-2 rounded-full ${TODO_DOT[t.prio] || TODO_DOT.gelb}" aria-hidden="true"></span>
      <span class="min-w-0 flex-1 text-sm text-zinc-900">${esc(t.titel)}${t.notiz ? `<span class="block text-xs text-zinc-500">${esc(t.notiz)}</span>` : ''}</span>${frist}`;
    return h
      ? `<button type="button" data-open="${esc('o:' + h.id)}" class="flex w-full items-start gap-3 text-left py-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20" style="min-height:44px">${inner}</button>`
      : `<div class="flex items-start gap-3 py-2" style="min-height:44px">${inner}</div>`;
  }
  function todoHtml(model) {
    if (!model.todos.length) return '';
    const first = model.todos.slice(0, 5), rest = model.todos.slice(5);
    return `<section class="mb-6">
      ${sectionHead('Für Miri', model.todos.length)}
      <div class="bg-white border border-zinc-200 rounded-xl card-shadow px-4 py-2 divide-y divide-zinc-100">
        ${first.map((t) => `<div>${todoRow(t, model)}</div>`).join('')}
        ${rest.length ? `<details class="py-1"><summary class="cursor-pointer select-none text-xs text-zinc-500 hover:text-zinc-900 py-3" style="min-height:44px">${rest.length} weitere anzeigen</summary><div class="divide-y divide-zinc-100">${rest.map((t) => `<div>${todoRow(t, model)}</div>`).join('')}</div></details>` : ''}
      </div>
    </section>`;
  }

  // ---- Kalender: zwölf Monatsblätter, farbige Tage = Hotelkooperationen ----
  function monthCal(model, y, m) {
    const days = new Date(y, m + 1, 0).getDate();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Montag = 0
    const ym = `${y}-${pad(m + 1)}`;
    let cells = '<span></span>'.repeat(lead);
    for (let d = 1; d <= days; d++) {
      const iso = isoOf(y, m, d);
      const col = (lead + d - 1) % 7;
      const it = model.dayMap[iso];
      const ev = model.eventDays[iso];
      const f = model.ferienDay[iso];
      let cls = 'relative flex items-center justify-center h-6 text-xs tabular-nums overflow-hidden ';
      if (it) {
        const left = iso === it.von || col === 0 ? ' rounded-l-md' : '';
        const right = iso === it.bis || col === 6 ? ' rounded-r-md' : '';
        cls += AMPEL[it.ampel].cell + ' font-medium' + left + right;
      } else if (f && f.art === 'ferien') cls += 'bg-zinc-200 text-zinc-600';
      else if (f) cls += 'bg-zinc-100 text-zinc-500';
      else cls += col >= 5 ? 'text-zinc-400' : 'text-zinc-700';
      if (iso === model.today) cls += ' ring-2 ring-zinc-900 ring-inset rounded-md';
      // Schulferien und Feiertage: Streifen am unteren Rand, auch unter eingefaerbten Tagen sichtbar; Punkt oben = anderer Termin
      const dot = (ev ? '<span class="absolute top-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-zinc-900"></span>' : '')
        + (f ? `<span class="absolute inset-x-0 bottom-0 h-1 ${f.art === 'ferien' ? FERIEN_STRIP.ferien : FERIEN_STRIP.schulfrei}"></span>` : '');
      const target = it || (ev && ev[0]);
      const ferienTitle = f && f.name ? ' · ' + f.name : '';
      cells += target
        ? `<button type="button" data-open="${esc(target.key)}" class="${cls}" aria-label="${esc(target.titel + ', ' + fmtDM(iso) + ferienTitle)}" title="${esc(target.titel + ferienTitle)}">${d}${dot}</button>`
        : `<span class="${cls}"${f ? ` title="${esc(f.name)}"` : ''}>${d}${dot}</span>`;
    }
    // multi-month items are listed once, in their main month; hotels first, other appointments separated below
    const entries = model.items.filter((i) => i.mainYM === ym);
    const lineHtml = (i) => {
      const dot = i.art === 'event' ? '<span class="mt-1 shrink-0 inline-block w-2 h-2 rounded-full bg-zinc-900" aria-hidden="true"></span>' : dotHtml(i.ampel);
      const muted = i.art === 'angebot' ? ' text-zinc-500' : ' text-zinc-900';
      // schmale Karte: der Name rutscht als Ganzes in die naechste Zeile, statt mitten im Wort umzubrechen
      return `<button type="button" data-open="${esc(i.key)}" class="flex w-full flex-wrap items-start gap-x-2 text-left text-xs rounded-md py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20">${dot}<span class="shrink-0 tabular-nums text-zinc-500">${esc(fmtShort(i.von, i.bis))}</span><span class="min-w-[8rem] flex-1 break-words${muted}">${esc(i.titel)}</span></button>`;
    };
    const hotelLines = entries.filter((i) => i.art !== 'event').map(lineHtml).join('');
    const eventLines = entries.filter((i) => i.art === 'event').map(lineHtml).join('');
    const monthFerien = model.ferien.filter((f) => f.art === 'ferien' && f.von.slice(0, 7) <= ym && f.bis.slice(0, 7) >= ym);
    const ferienNote = monthFerien.length ? `<p class="text-xs text-zinc-500 mt-2">${esc(monthFerien.map((f) => f.bezeichnung).join(' · '))}</p>` : '';
    return `<section class="min-w-0 bg-white border border-zinc-200 rounded-xl card-shadow p-3">
      <h4 class="text-sm font-medium text-zinc-900 mb-2">${MONTHS[m]} ${y}</h4>
      <div class="grid grid-cols-7 text-center text-xs text-zinc-400 mb-1">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="grid grid-cols-7 gap-y-1">${cells}</div>
      ${ferienNote}
      ${hotelLines ? `<div class="mt-2 space-y-1">${hotelLines}</div>` : ''}
      ${eventLines ? `<div class="mt-2 pt-2 border-t border-zinc-100 space-y-1">${eventLines}</div>` : ''}
    </section>`;
  }

  function calendarHtml(model) {
    const wo = model.bundeslaender.length ? ' in ' + model.bundeslaender.join(' und ') : '';
    return `<section class="mb-8">
      ${sectionHead('Kalender', null, `Farbige Tage sind Hotelkooperationen. Der Streifen unter einem Tag zeigt Schulferien (dunkel) und Feiertage (hell)${wo}. Tippe auf einen Tag, einen Eintrag oder einen Chip oben.`)}
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">${model.months.map((mo) => monthCal(model, mo.y, mo.m)).join('')}</div>
    </section>`;
  }

  // ---- Hotelkooperationen nach Datum ----
  function dateBadge(von, ampel) {
    const d = toDate(von);
    return `<div class="shrink-0 w-12 text-center rounded-lg border border-zinc-200 py-2 self-start ${ampel ? '' : 'bg-zinc-50'}">
      <div class="text-xs text-zinc-400 uppercase">${esc(MONTHS[d.getMonth()].slice(0, 3))}</div>
      <div class="text-sm font-medium text-zinc-900 tabular-nums">${d.getDate()}</div>
    </div>`;
  }

  function konflikteHtml(it) {
    if (!it.konflikte || !it.konflikte.length) return '';
    const txt = it.konflikte.map((k) => `${k.titel} (${k.art === 'angebot' ? 'Fenster' : AMPEL[k.ampel] ? AMPEL[k.ampel].label : 'Termin'}, ${fmtShort(k.von, k.bis)})`).join('; ');
    return `<p class="text-xs text-amber-700 mt-2">Überschneidung mit ${esc(txt)}</p>`;
  }

  function stayCard(model, it) {
    const h = it.hotel;
    const a = AMPEL[it.ampel];
    const ball = h && h.ball_bei && BALL[h.ball_bei] ? `${BALL[h.ball_bei]} · ` : '';
    return `<article class="lift relative bg-white border border-zinc-200 rounded-xl card-shadow p-4 flex gap-3 overflow-hidden">
      <button type="button" data-open="${esc(it.key)}" class="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20" aria-label="${esc('Details zu ' + it.titel + ' öffnen')}"></button>
      <span class="absolute left-0 top-0 bottom-0 w-1 ${a.bar}" aria-hidden="true"></span>
      ${dateBadge(it.von, it.ampel)}
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-zinc-900">${esc(it.titel)}</div>
            ${h && place(h) ? `<div class="text-xs text-zinc-400">${esc(place(h))}</div>` : ''}
          </div>
          ${pillHtml(it.ampel)}
        </div>
        <p class="text-sm text-zinc-600 mt-2">${esc(fmtRange(it.von, it.bis))} · ${esc(nightsText(it.von, it.bis))} · ${esc(relText(it.von, it.bis, model.today))}</p>
        <p class="text-xs text-zinc-500 mt-1">${esc(ball + ferienText(it.von, it.bis, model.ferienDay))}</p>
        ${it.ampelGrund ? `<p class="text-xs ${it.ampel === 'rot' ? 'text-red-700' : 'text-zinc-500'} mt-1">${esc(it.ampelGrund)}</p>` : ''}
        ${konflikteHtml(it)}
        ${h ? `<div class="mt-2 flex gap-4">${linksHtml(h)}</div>` : ''}
      </div>
    </article>`;
  }

  function staysHtml(model) {
    const rows = model.items.filter((i) => i.hotel && (i.art === 'fix' || i.art === 'verhandlung'));
    return `<section class="mb-8">
      ${sectionHead('Hotelkooperationen', rows.length, 'Fixe und verhandelte Aufenthalte, der nächste zuerst. Die Farbe links ist die Ampel.')}
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">${rows.length ? rows.map((i) => stayCard(model, i)).join('') : '<div class="text-sm text-zinc-400 bg-white border border-dashed border-zinc-200 rounded-xl p-6 text-center">Keine anstehenden Termine eingetragen.</div>'}</div>
    </section>`;
  }

  // ---- Noch ohne Termin (kompakte Liste) ----
  function openRow(model, h) {
    const wins = model.windows(h.id);
    const winTxt = wins.length ? `Fenster: ${wins.map((w) => fmtShort(w.von, w.bis)).join(' · ')}` : '';
    const sub = h.aktuell ? h.aktuell : cut(h.antwort_stand, 140);
    return `<li class="relative px-4 py-3">
      <button type="button" data-open="${esc('o:' + h.id)}" class="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-900/20" aria-label="${esc('Details zu ' + h.hotelname + ' öffnen')}"></button>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm font-medium text-zinc-900">${esc(h.hotelname)}</div>
          <div class="text-xs text-zinc-500 mt-1">${esc(sub)}</div>
        </div>
        ${h.ball_bei && BALL[h.ball_bei] ? `<span class="shrink-0 text-xs rounded-full px-2 py-1 bg-zinc-100 text-zinc-600">${esc(BALL[h.ball_bei])}</span>` : ''}
      </div>
      ${winTxt ? `<div class="text-xs text-zinc-500 mt-1">${esc(winTxt)}</div>` : ''}
      <div class="mt-1 flex gap-4">${linksHtml(h)}</div>
    </li>`;
  }

  function openHtml(model) {
    return `<section class="mb-8">
      ${sectionHead('Noch ohne Termin', model.open.length, 'Zusagen oder Interesse, aber noch kein Datum. Wer am Zug ist, steht rechts.')}
      ${model.open.length ? `<ul class="bg-white border border-zinc-200 rounded-xl card-shadow divide-y divide-zinc-100 overflow-hidden">${model.open.map((h) => openRow(model, h)).join('')}</ul>` : '<div class="text-sm text-zinc-400 bg-white border border-dashed border-zinc-200 rounded-xl p-6 text-center">Alles hat ein Datum.</div>'}
    </section>`;
  }

  // ---- Andere Termine (Agenturen, Treffen, Veranstaltungen), bewusst getrennt ----
  function eventsHtml(model) {
    const rows = model.items.filter((i) => i.art === 'event');
    return `<section class="mb-8">
      ${sectionHead('Andere Termine', rows.length, 'Agenturen, Veranstaltungen und Treffen, keine Hotelkooperationen.')}
      ${rows.length ? `<ul class="bg-zinc-50 border border-zinc-200 rounded-xl divide-y divide-zinc-200 overflow-hidden">${rows.map((i) => `<li class="relative flex gap-3 px-4 py-3">
        <button type="button" data-open="${esc(i.key)}" class="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-900/20" aria-label="${esc('Details zu ' + i.titel + ' öffnen')}"></button>
        <div class="shrink-0 w-12 text-center rounded-lg bg-zinc-900 text-white py-2 self-start">
          <div class="text-xs uppercase opacity-70">${esc(MONTHS[toDate(i.von).getMonth()].slice(0, 3))}</div>
          <div class="text-sm font-medium tabular-nums">${toDate(i.von).getDate()}</div>
        </div>
        <div class="min-w-0">
          <div class="text-sm font-medium text-zinc-900">${esc(i.titel)}</div>
          <div class="text-xs text-zinc-500 mt-1">${esc(fmtRange(i.von, i.bis))} · ${esc(relText(i.von, i.bis, model.today))}</div>
          ${i.notiz ? `<div class="text-xs text-zinc-500 mt-1">${esc(cut(i.notiz, 140))}</div>` : ''}
        </div>
      </li>`).join('')}</ul>` : '<div class="text-sm text-zinc-400 bg-white border border-dashed border-zinc-200 rounded-xl p-6 text-center">Keine anderen Termine eingetragen.</div>'}
    </section>`;
  }

  // ---------- Detail (Modal) ----------
  // vereinbarung: Zeilen "Label: Text" (Leerzeilen erlaubt)
  function kurzHtml(text) {
    return String(text).split(/\n+/).map((l) => l.trim()).filter(Boolean).map((line) => {
      const m = line.match(/^([^:\n]{2,40}):\s*([\s\S]*)$/);
      return m
        ? `<div class="grid grid-cols-1 sm:grid-cols-[128px_1fr] sm:gap-x-3 sm:items-baseline py-1"><span class="text-xs text-zinc-500">${esc(m[1])}</span><span class="text-sm text-zinc-800">${esc(m[2].trim())}</span></div>`
        : `<div class="py-1 text-sm text-zinc-800">${esc(line)}</div>`;
    }).join('');
  }

  // Verlauf als senkrechte Linie, überholte Vorschläge durchgestrichen
  function verlaufHtml(v) {
    if (!Array.isArray(v)) return '';
    const steps = v.filter((s) => s && isIso(s.d) && s.t);
    if (!steps.length) return '';
    const rows = steps.map((s) => {
      const miri = s.w === 'miri';
      const dot = miri ? 'bg-zinc-900' : 'bg-white border-2 border-zinc-900';
      const txt = s.alt ? 'text-zinc-400 line-through' : 'text-zinc-800';
      return `<li class="relative pb-3 last:pb-0">
        <span class="absolute -left-5 top-1 w-2 h-2 rounded-full ${dot}" aria-hidden="true"></span>
        <div class="flex items-baseline gap-2 flex-wrap"><span class="text-xs tabular-nums text-zinc-500">${esc(fmtDM(s.d))}</span><span class="text-xs text-zinc-500">${miri ? 'Miri' : 'Hotel'}</span></div>
        <div class="text-sm ${txt}">${esc(s.t)}</div>
      </li>`;
    }).join('');
    return `<ol class="relative ml-1 pl-5 border-l border-zinc-200">${rows}</ol>`;
  }

  // ---------- Listen (Chips der Legende) ----------
  // Zeile: Datum | Hotel (mit Zusatzzeile) | Bundesland oder Land. Mit key wird sie zum Knopf und oeffnet das Haus.
  function listRow({ datum, datumSub, name, sub, ort, key, past }) {
    const tag = key ? 'button' : 'div';
    const attrs = key ? ` type="button" data-open="${esc(key)}"` : '';
    const hover = key ? ' rounded-lg hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20' : '';
    return `<li class="${past ? 'opacity-60' : ''}"><${tag}${attrs} class="grid w-full grid-cols-[104px_1fr] sm:grid-cols-[168px_1fr_168px] gap-x-3 items-baseline text-left px-2 py-2${hover}">
      <span class="text-xs tabular-nums text-zinc-600">${esc(datum)}${datumSub ? `<span class="block text-zinc-400">${esc(datumSub)}</span>` : ''}</span>
      <span class="text-sm text-zinc-900">${esc(name)}${sub ? `<span class="block text-xs text-zinc-500">${esc(sub)}</span>` : ''}</span>
      <span class="col-start-2 sm:col-start-auto text-xs text-zinc-500">${esc(ort)}</span>
    </${tag}></li>`;
  }
  const groupHead = (label, n) => `<h3 class="text-xs font-medium text-zinc-500 mt-4 mb-1 px-2">${esc(label)} <span class="tabular-nums text-zinc-400">${n}</span></h3>`;

  function listHtml(model, listKey) {
    const head = LIST_HEAD[listKey];
    if (!head) return null;
    const L = model.lists;
    let cols = ['Datum', 'Hotel', 'Bundesland / Land'];
    let title = head.title;
    let body = '';
    const hotelRow = (r, extra) => listRow({ datum: r.von ? fmtList(r.von, r.bis) : 'Datum offen', name: r.hotel.hotelname, ort: bl(r.hotel), key: r.key, ...(extra || {}) });
    if (listKey === 'fix') {
      title = `Fix: ${L.fixUpcoming.length + L.fixPast.length} Kooperationen`;
      body = (L.fixUpcoming.length ? groupHead('Ab heute', L.fixUpcoming.length) + `<ul>${L.fixUpcoming.map((r) => hotelRow(r)).join('')}</ul>` : '')
        + (L.fixPast.length ? groupHead('Bisher', L.fixPast.length) + `<ul>${L.fixPast.map((r) => hotelRow(r, { past: true })).join('')}</ul>` : '');
    } else if (listKey === 'verhandlung') {
      body = `<ul>${L.verhRows.map((r) => listRow({
        datum: r.von ? fmtList(r.von, r.bis) : 'kein Termin', datumSub: r.fenster ? 'Fenster' : '',
        name: r.hotel.hotelname, sub: r.hotel.ball_bei && BALL[r.hotel.ball_bei] ? BALL[r.hotel.ball_bei] : '', ort: bl(r.hotel), key: r.key,
      })).join('')}</ul>`;
    } else if (listKey === 'achtung') {
      body = `<ul>${L.achtungRows.map((r) => hotelRow(r, { sub: r.grund })).join('')}</ul>`;
    } else if (listKey === 'fenster') {
      body = `<ul>${L.fensterRows.map((r) => hotelRow(r)).join('')}</ul>`;
    } else if (listKey === 'ferien') {
      cols = ['Datum', 'Bezeichnung', 'Bundesland'];
      if (model.bundeslaender.length) title += ' ' + model.bundeslaender.join(' und ');
      body = `<ul>${L.ferienRows.map((f) => listRow({ datum: fmtList(f.von, f.bis), name: f.bezeichnung, sub: f.art === 'ferien' ? 'Schulferien' : 'Feiertag, schulfrei', ort: f.bundesland || '' })).join('')}</ul>`;
    }
    const empty = !/<li/.test(body);
    return `<h2 id="termine-modal-title" class="text-xl font-semibold">${esc(title)}</h2>
      <p class="text-xs text-zinc-500 mt-1">${esc(head.sub)}</p>
      <div class="mt-4">
        ${empty ? '<p class="text-sm text-zinc-500">Keine Einträge.</p>' : `<div class="hidden sm:grid grid-cols-[168px_1fr_168px] gap-x-3 px-2 pb-1 text-xs text-zinc-400"><span>${esc(cols[0])}</span><span>${esc(cols[1])}</span><span>${esc(cols[2])}</span></div>${body}`}
      </div>`;
  }

  // "Zurueck zur Liste", wenn ein Haus aus einer Liste heraus geoeffnet wurde
  const backHtml = () => {
    const k = state.back && state.back.startsWith('l:') ? state.back.slice(2) : '';
    return k && LIST_HEAD[k] ? `<button type="button" data-open="${esc(state.back)}" class="${linkCls} -mt-2 mb-2" style="min-height:44px">← Zurück zur Liste</button>` : '';
  };

  function detailHtml(model, key) {
    if (key.startsWith('l:')) return listHtml(model, key.slice(2));
    const status = state.status || {};
    const item = model.byKey.get(key) || null;
    let h = null;
    if (key.startsWith('o:')) h = model.byId.get(key.slice(2)) || null;
    else if (item) h = item.hotel;
    if (!item && !h) return null;
    // Event ohne Hotel
    if (!h) {
      return `${backHtml()}<h2 id="termine-modal-title" class="text-xl font-semibold">${esc(item.titel)}</h2>
        <div class="mt-2"><span class="shrink-0 text-xs rounded-full px-2 py-1 bg-zinc-900 text-white">Anderer Termin</span></div>
        <p class="text-sm text-zinc-800 mt-4">${esc(fmtRange(item.von, item.bis))} · ${esc(relText(item.von, item.bis, model.today))}</p>
        ${item.notiz ? `<div class="mt-3 text-sm text-zinc-800" style="white-space:pre-line">${esc(item.notiz)}</div>` : ''}`;
    }
    const mine = model.items.filter((i) => i.hotel && i.hotel.id === h.id);
    const main = mine.find((i) => i.art === 'fix' || i.art === 'verhandlung') || null;
    const ampel = main ? main.ampel : null;
    const st = status[h.status];
    const stPill = st ? `<span class="shrink-0 text-xs rounded-full px-2 py-1 ${esc(st.cls)}">${esc(st.label)}</span>` : '';
    const ballPill = h.ball_bei && BALL[h.ball_bei] ? `<span class="shrink-0 text-xs rounded-full px-2 py-1 bg-zinc-100 text-zinc-600">${esc(BALL[h.ball_bei])}</span>` : '';
    const aktuell = h.aktuell || cut(h.antwort_stand, 200);
    const verlauf = verlaufHtml(h.verlauf);
    const termine = mine.length ? mine.map((i) => `<li class="py-2 border-t border-zinc-100 first:border-t-0">
        <div class="flex items-start justify-between gap-3"><span class="text-sm text-zinc-900">${esc(fmtRange(i.von, i.bis))}</span>${pillHtml(i.ampel)}</div>
        <div class="text-xs text-zinc-500 mt-1">${esc(nightsText(i.von, i.bis))} · ${esc(relText(i.von, i.bis, model.today))} · ${esc(ferienText(i.von, i.bis, model.ferienDay))}</div>
        ${i.ampelGrund ? `<div class="text-xs ${i.ampel === 'rot' ? 'text-red-700' : 'text-zinc-500'} mt-1">${esc(i.ampelGrund)}</div>` : ''}
        ${i.notiz && !verlauf ? `<div class="text-xs text-zinc-500 mt-1">${esc(i.notiz)}</div>` : ''}
      </li>`).join('') : '<li class="text-sm text-zinc-500">Noch kein Termin vereinbart.</li>';
    const konfl = [];
    mine.forEach((i) => (i.konflikte || []).forEach((k) => konfl.push(`${k.titel} (${fmtShort(k.von, k.bis)})`)));
    const konflHtml = konfl.length ? `<div class="mt-3 rounded-lg bg-amber-50 text-amber-700 text-sm p-3">Überschneidung mit ${esc([...new Set(konfl)].join('; '))}</div>` : '';
    // short version first; the long text (hotels.vereinbarung) stays available but folded
    const kurzSrc = h.vereinbarung_kurz || h.vereinbarung || '';
    const kurz = kurzSrc ? kurzHtml(kurzSrc) : '';
    const lang = h.vereinbarung_kurz && h.vereinbarung ? kurzHtml(h.vereinbarung) : '';
    const mail = safeMailUrl(h.mail_url);
    const meta = [place(h), h.gruppe].filter(Boolean).join(' · ');
    return `${backHtml()}<h2 id="termine-modal-title" class="text-xl font-semibold">${esc(h.hotelname)}</h2>
      ${meta ? `<p class="text-xs text-zinc-400 mt-1">${esc(meta)}</p>` : ''}
      <div class="mt-3 flex flex-wrap items-center gap-2">${ampel ? pillHtml(ampel) : ''}${stPill}${ballPill}</div>
      <div class="mt-2 flex gap-4">${linksHtml(h)}</div>
      ${aktuell ? `<div class="mt-4 rounded-lg bg-zinc-50 border border-zinc-200 p-3"><div class="text-xs font-medium text-zinc-500 mb-1">Aktuell</div><div class="text-sm text-zinc-900">${esc(aktuell)}</div></div>` : ''}
      <ul class="mt-3">${termine}</ul>
      ${konflHtml}
      ${kurz ? `<h3 class="text-sm font-medium text-zinc-900 mt-5 mb-2">Kurz gesagt</h3>${kurz}` : ''}
      ${verlauf ? `<h3 class="text-sm font-medium text-zinc-900 mt-5 mb-3">Verlauf</h3>${verlauf}` : ''}
      ${mail ? `<p class="mt-5"><a class="${linkCls}" style="min-height:44px" href="${esc(mail)}" target="_blank" rel="noopener noreferrer">Original-Mail öffnen ↗</a></p>` : ''}
      ${lang ? `<details class="mt-2"><summary class="cursor-pointer select-none text-xs text-zinc-500 hover:text-zinc-900 py-3" style="min-height:44px">Ausführliche Fassung anzeigen</summary><div class="mt-2">${lang}</div></details>` : ''}
      ${h.vereinbarung_stand ? `<p class="text-xs text-zinc-400 mt-3">Stand ${esc(fmtDMY(h.vereinbarung_stand))}</p>` : ''}`;
  }

  function ensureModal(doc) {
    let el = doc.getElementById('termine-modal');
    if (el) return el;
    el = doc.createElement('div');
    el.id = 'termine-modal';
    el.className = 'hidden fixed inset-0 z-50 overflow-y-auto';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'termine-modal-title');
    el.innerHTML = `<div data-close class="fixed inset-0 bg-black/25"></div>
      <div class="relative min-h-full flex items-end sm:items-center justify-center sm:px-4 pointer-events-none">
        <div class="relative pointer-events-auto w-full max-w-2xl bg-white border border-zinc-200 rounded-t-xl sm:rounded-xl card-shadow p-6 fade-in max-h-[90vh] overflow-auto">
          <button type="button" data-close class="absolute top-2 right-2 inline-flex items-center justify-center text-zinc-400 hover:text-zinc-900 text-xl leading-none rounded-lg" style="width:44px;height:44px" aria-label="Schliessen">&times;</button>
          <div data-content class="pr-8"></div>
        </div>
      </div>`;
    doc.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { closeModal(); return; }
      // Zeile in einer Liste oder "Zurueck zur Liste": Inhalt im selben Dialog wechseln, der Fokus-Rueckweg bleibt der urspruengliche Knopf
      const b = e.target.closest('[data-open]');
      if (b && el.contains(b)) showModal(b.dataset.open, el, doc, state.current && state.current.startsWith('l:') ? state.current : null);
    });
    doc.addEventListener('keydown', (e) => {
      if (el.classList.contains('hidden')) return;
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll('a[href],button:not([disabled]),summary')];
      if (!f.length) return;
      const firstEl = f[0], lastEl = f[f.length - 1];
      if (!el.contains(doc.activeElement)) { e.preventDefault(); firstEl.focus(); } // Klick auf Text setzt den Fokus auf body
      else if (e.shiftKey && doc.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && doc.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    });
    return el;
  }

  // Inhalt des Dialogs setzen (Haus, Ereignis oder Liste); back = Schluessel der Liste, aus der man kam
  function showModal(key, el, doc, back) {
    if (!state.model) return false;
    state.back = back || null;
    const html = detailHtml(state.model, key);
    if (!html) return false;
    state.current = key;
    el.querySelector('[data-content]').innerHTML = html;
    el.classList.remove('hidden');
    doc.body.classList.add('overflow-hidden');
    el.querySelector('button[data-close].absolute').focus();
    return true;
  }

  function openModal(key, opener) {
    if (!state.model) return;
    const doc = (opener || document.body).ownerDocument || document;
    const el = ensureModal(doc);
    if (showModal(key, el, doc, null)) state.lastFocus = opener || null;
  }

  function closeModal() {
    const el = document.getElementById('termine-modal');
    if (!el) return;
    el.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    state.current = null;
    state.back = null;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  // ---------- Einstieg ----------
  // data: { hotels, plan, ferien, todos, status, today, hinweis? }
  function render(root, data) {
    const model = build(data);
    state.model = model;
    state.status = data.status || {};
    root.innerHTML = headerHtml(model, data.hinweis) + todoHtml(model) + legendHtml(model) + calendarHtml(model) + staysHtml(model) + openHtml(model) + eventsHtml(model);
    root.onclick = (e) => {
      const b = e.target.closest('[data-open]');
      if (b && root.contains(b)) openModal(b.dataset.open, b);
    };
    ensureModal(root.ownerDocument || document);
    return model;
  }

  return { render, build, openModal, closeModal, ferienText, fmtRange, safeUrl };
})();
