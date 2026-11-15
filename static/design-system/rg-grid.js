/* Wattman — data grid progressif pour les tableaux HTML existants.
   Activé automatiquement sur les tableaux de données en LECTURE SEULE à
   structure simple (une ligne d'en-tête, pas de fusion de cellules, pas de
   champ de saisie, au moins 4 lignes). Forçage : data-rg-grid="on" / "off".

   Fonctions : recherche globale, tri 3 états, réorganisation des colonnes par
   glisser-déposer, masquage, redimensionnement, densité, en-tête fixe,
   regroupement par catégorie (dépliable) avec statistiques min/max marquées
   « dérivées », mise en évidence des extrêmes par colonne, sélection de lignes
   (Ctrl/Maj + clic), copie, export CSV (complet / vue filtrée / sélection).

   Non destructif : le texte, les classes (.xl-*) et les styles des cellules ne
   sont jamais modifiés. Seuls l'ordre et la visibilité changent ; « ordre
   d'origine » restaure exactement l'ordre initial des lignes et des colonnes.
   Les lignes de groupe (.rg-group-row) sont des lignes d'affichage, exclues des
   copies et exports. */
(function () {
  'use strict';
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* indisponible */ } }
  };
  const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

  /** Convertit un texte de cellule FR (« 1 234,56 Ah », « -0,048 ») en nombre, sinon null. */
  function parseNumber(text) {
    const cleaned = String(text).replace(/[\s  ]/g, '').replace(',', '.');
    const match = cleaned.match(/^[-+−]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i);
    if (!match) return null;
    const value = Number(match[0].replace('−', '-'));
    return Number.isFinite(value) ? value : null;
  }
  /** Unité affichée après le nombre (« 0,048 Ah/j » → « Ah/j »), sinon ''. */
  function unitOf(text) {
    const m = String(text).trim().match(/^[-+−]?[\d\s  .,]+(?:e[-+]?\d+)?\s*(.*)$/i);
    return m ? m[1].trim() : '';
  }
  // Grandeurs physiques : conversion vers l'unité de base pour comparer
  // « 50,00 µA » et « 1,25 mA ». Unités inconnues : comparaison du nombre seul.
  const PREFIX = { G: 1e9, M: 1e6, k: 1e3, h: 1e2, m: 1e-3, 'µ': 1e-6, 'μ': 1e-6, u: 1e-6, n: 1e-9, p: 1e-12 };
  const BASES = ['A', 'Ah', 'Ah/j', 'A/j', 'W', 'Wh', 'V', 'Hz', 's', 'Ω', 'F', 'J', 'Wh/j'];
  const TIME = { s: 1, min: 60, h: 3600, j: 86400, jour: 86400, jours: 86400, jrs: 86400 };
  function physical(text) {
    const value = parseNumber(text);
    if (value === null) return null;
    const unit = unitOf(text).replace(/\s+/g, '');
    if (!unit) return { base: '', value };
    if (TIME[unit] !== undefined) return { base: 's', value: value * TIME[unit] };
    if (BASES.includes(unit)) return { base: unit, value };
    const prefix = PREFIX[unit[0]];
    if (prefix !== undefined && BASES.includes(unit.slice(1))) return { base: unit.slice(1), value: value * prefix };
    return { base: unit, value };
  }
  /** Comparaison de deux textes de cellule : nombres avec unités compatibles, sinon texte. */
  function compareCells(ta, tb) {
    const pa = physical(ta); const pb = physical(tb);
    if (pa && pb) return pa.base === pb.base ? pa.value - pb.value : (pa.value - pb.value) || collator.compare(pa.base, pb.base);
    return collator.compare(ta, tb);
  }
  const cellText = cell => (cell.querySelector('input,select') ? (cell.querySelector('input,select').value || '') : cell.textContent).replace(/\s+/g, ' ').trim();

  function headerRow(table) {
    if (table.tHead && table.tHead.rows.length === 1) return table.tHead.rows[0];
    if (table.tHead) return null;
    const first = table.rows[0];
    return first && Array.from(first.cells).every(c => c.tagName === 'TH') ? first : null;
  }
  function bodyRows(table, head) {
    const rows = [];
    Array.from(table.tBodies).forEach(tb => rows.push(...tb.rows));
    return rows.filter(r => r !== head && !r.classList.contains('rg-group-row'));
  }

  function eligible(table) {
    if (table.dataset.rgGrid === 'off' || table.classList.contains('rg-grid')) return false;
    if (table.closest('dialog, .menu-content, .retractable-menu, [data-rg-grid-scope="off"]')) return false;
    const head = headerRow(table);
    if (!head) return false;
    const forced = table.dataset.rgGrid === 'on';
    const columns = head.cells.length;
    if (columns < 2 || Array.from(head.cells).some(c => c.colSpan > 1 || c.rowSpan > 1)) return false;
    const rows = bodyRows(table, head);
    if (!forced && rows.length < 4) return false;
    if (table.querySelector('tbody :is(input, select, textarea, button, [contenteditable="true"])')) return false;
    return rows.every(r => r.cells.length === columns && Array.from(r.cells).every(c => c.colSpan === 1 && c.rowSpan === 1));
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    children.forEach(c => node.append(c));
    return node;
  }

  let tableSeq = 0;
  function enhance(table) {
    const head = headerRow(table);
    const name = th => th.dataset.rgName || (th.dataset.rgName = th.textContent.trim());
    Array.from(head.cells).forEach((th, i) => { name(th); th.dataset.rgCol = String(i); });
    const cells = () => Array.from(head.cells);
    const colIndex = th => cells().indexOf(th);
    const key = `rg-grid:${location.pathname}:${table.id || table.getAttribute('aria-label') || cells().map(name).join('|').slice(0, 120) || tableSeq}`;
    tableSeq += 1;
    const prefs = Object.assign({ hidden: [], density: 'normal', widths: {}, order: null, extremes: false }, store.get(key));
    const state = { query: '', sort: null, lastClicked: null, groupBy: null, collapsed: new Set() };
    table.classList.add('rg-grid');
    table.dataset.density = prefs.density;
    const indexRows = () => bodyRows(table, head).forEach((row, i) => { if (row.dataset.rgIndex === undefined) row.dataset.rgIndex = String(i); });
    indexRows();

    const markNumeric = () => bodyRows(table, head).forEach(row => Array.from(row.cells).forEach(cell => {
      const t = cellText(cell);
      if (!cell.style.textAlign && parseNumber(t) !== null && /^[-+−\d.,\s  ]+[^\d]{0,8}$/.test(t)) cell.classList.add('rg-num');
    }));
    markNumeric();

    // En-tête fixe : sous la barre d'application si le défilement est celui de la page
    let scroller = table.parentElement;
    while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const stickyTop = (!scroller || scroller === document.body) && document.documentElement.classList.contains('rg-has-appbar') ? 'var(--rg-appbar-h)' : '0px';

    let observer;
    const quiet = fn => { observer && observer.disconnect(); try { fn(); } finally { observe(); } };

    // ----------------------------------------------- ordre des colonnes
    function moveColumn(from, to) {
      if (from === to || from < 0 || to < 0) return;
      [head, ...bodyRows(table, head)].forEach(row => {
        const list = Array.from(row.cells);
        const cell = list[from];
        const target = list[to];
        if (!cell || !target) return;
        if (from < to) target.after(cell); else target.before(cell);
      });
    }
    function applyOrder(order) {
      quiet(() => order.forEach((colName, position) => {
        const from = cells().findIndex(th => name(th) === colName);
        if (from >= 0) moveColumn(from, position);
      }));
    }
    const originalOrder = cells().slice().sort((a, b) => a.dataset.rgCol - b.dataset.rgCol).map(name);

    // ---------------------------------------------------------- toolbar
    const bar = el('div', { class: 'rg-grid-toolbar', role: 'toolbar', 'aria-label': 'Outils du tableau' });
    const search = el('input', { type: 'search', class: 'rg-grid-search', placeholder: 'Rechercher dans le tableau…', 'aria-label': 'Rechercher dans le tableau' });

    const columnsMenu = el('details', {}, el('summary', { text: 'Colonnes' }));
    const pop = el('div', { class: 'rg-pop' });
    columnsMenu.append(pop);
    function renderColumnMenu() {
      pop.replaceChildren(el('p', { class: 'rg-pop-hint', text: 'Glissez les en-têtes pour réorganiser.' }));
      cells().forEach(th => {
        const box = el('input', { type: 'checkbox' });
        box.checked = !prefs.hidden.includes(name(th));
        box.addEventListener('change', () => {
          prefs.hidden = prefs.hidden.filter(h => h !== name(th));
          if (!box.checked) prefs.hidden.push(name(th));
          store.set(key, prefs);
          applyColumns();
        });
        pop.append(el('label', {}, box, document.createTextNode(name(th) || 'Colonne')));
      });
      pop.append(el('button', { type: 'button', text: 'Tout afficher', onclick: () => { prefs.hidden = []; store.set(key, prefs); renderColumnMenu(); applyColumns(); } }));
      pop.append(el('button', { type: 'button', text: 'Ordre des colonnes d’origine', onclick: () => { prefs.order = null; store.set(key, prefs); applyOrder(originalOrder); renderColumnMenu(); refresh(); } }));
    }
    columnsMenu.addEventListener('toggle', () => { if (columnsMenu.open) renderColumnMenu(); });

    // Regroupement : colonnes catégorielles (2 à 30 valeurs distinctes, non numériques)
    const groupSelect = el('select', { class: 'rg-grid-group', 'aria-label': 'Regrouper par' });
    function renderGroupOptions() {
      groupSelect.replaceChildren(el('option', { value: '', text: 'Sans regroupement' }));
      cells().forEach(th => {
        const i = colIndex(th);
        const values = bodyRows(table, head).map(r => cellText(r.cells[i]));
        const distinct = new Set(values);
        const numeric = values.filter(v => parseNumber(v) !== null).length > values.length / 2;
        if (!numeric && distinct.size >= 2 && distinct.size <= 30 && distinct.size < values.length) {
          groupSelect.append(el('option', { value: name(th), text: `Grouper : ${name(th)}` }));
        }
      });
      groupSelect.value = state.groupBy || '';
      groupSelect.hidden = groupSelect.options.length < 2;
    }
    groupSelect.addEventListener('change', () => { state.groupBy = groupSelect.value || null; state.collapsed.clear(); refresh(); });

    const densities = ['compact', 'normal', 'comfortable'];
    const densityLabel = { compact: 'Compacte', normal: 'Standard', comfortable: 'Aérée' };
    const densityBtn = el('button', { type: 'button', title: 'Densité d’affichage' });
    const renderDensity = () => { densityBtn.textContent = `Densité : ${densityLabel[prefs.density]}`; table.dataset.density = prefs.density; };
    densityBtn.addEventListener('click', () => { prefs.density = densities[(densities.indexOf(prefs.density) + 1) % 3]; store.set(key, prefs); renderDensity(); });
    renderDensity();

    const extremesBtn = el('button', { type: 'button', title: 'Encadrer le minimum et le maximum de chaque colonne numérique (affichage seulement)' });
    const renderExtremesBtn = () => { extremesBtn.textContent = 'Min / Max'; extremesBtn.setAttribute('aria-pressed', String(!!prefs.extremes)); };
    extremesBtn.addEventListener('click', () => { prefs.extremes = !prefs.extremes; store.set(key, prefs); renderExtremesBtn(); applyExtremes(); });
    renderExtremesBtn();

    const resetSortBtn = el('button', { type: 'button', text: 'Ordre d’origine', hidden: '' });
    resetSortBtn.addEventListener('click', () => sortBy(null));

    const copyBtn = el('button', { type: 'button', text: 'Copier', title: 'Copier la sélection (ou la vue filtrée) au format tableur' });
    const exportMenu = el('details', { class: 'rg-export' }, el('summary', { text: 'Exporter' }));
    const exportPop = el('div', { class: 'rg-pop' });
    [['filtered', 'Vue filtrée (CSV)'], ['selected', 'Lignes sélectionnées (CSV)'], ['all', 'Tableau complet (CSV)']].forEach(([scope, label]) => {
      exportPop.append(el('button', { type: 'button', 'data-scope': scope, text: label, onclick: () => { exportCsv(scope); exportMenu.open = false; } }));
    });
    exportMenu.append(exportPop);
    const count = el('span', { class: 'rg-grid-count', 'aria-live': 'polite' });
    bar.append(search, columnsMenu, groupSelect, densityBtn, extremesBtn, resetSortBtn, copyBtn, exportMenu, count);

    const anchor = table.parentElement && table.parentElement !== document.body
      && table.parentElement.children.length === 1 && /table|scroll|wrap|container|excel|shell/i.test(table.parentElement.className)
      ? table.parentElement : table;
    anchor.before(bar);

    // ---------------------------------------------------------- logique
    function applyColumns() {
      const hidden = new Set(cells().map((th, i) => (prefs.hidden.includes(name(th)) ? i : -1)).filter(i => i >= 0));
      [head, ...bodyRows(table, head)].forEach(row => Array.from(row.cells).forEach((cell, i) => { cell.style.display = hidden.has(i) ? 'none' : ''; }));
      table.querySelectorAll('tr.rg-group-row > td').forEach(td => { td.colSpan = cells().length - hidden.size; });
    }
    function matches(row, terms) {
      const text = row.textContent.toLowerCase();
      return terms.every(t => text.includes(t));
    }
    function applyFilter() {
      const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = bodyRows(table, head);
      let shown = 0;
      rows.forEach(row => {
        const match = matches(row, terms);
        row.dataset.rgMatch = match ? '1' : '0';
        const collapsed = state.groupBy && state.collapsed.has(row.dataset.rgGroup);
        row.hidden = !match || collapsed;
        if (match) shown += 1;
      });
      table.querySelectorAll('tr.rg-group-row').forEach(gr => {
        const members = rows.filter(r => r.dataset.rgGroup === gr.dataset.rgGroup && r.dataset.rgMatch === '1');
        gr.hidden = members.length === 0;
      });
      const selected = rows.filter(r => r.classList.contains('rg-selected')).length;
      count.textContent = `${shown} / ${rows.length} ligne${rows.length > 1 ? 's' : ''}${selected ? ` · ${selected} sélectionnée${selected > 1 ? 's' : ''}` : ''}`;
    }
    function compareRows(a, b) {
      if (!state.sort) return Number(a.dataset.rgIndex) - Number(b.dataset.rgIndex);
      const col = colIndex(state.sort.th);
      const ta = cellText(a.cells[col]); const tb = cellText(b.cells[col]);
      if (ta === '' && tb !== '') return 1;          // vides toujours en bas
      if (tb === '' && ta !== '') return -1;
      const cmp = compareCells(ta, tb);
      return cmp * state.sort.dir || Number(a.dataset.rgIndex) - Number(b.dataset.rgIndex);
    }
    function layoutRows() {
      quiet(() => {
        table.querySelectorAll('tr.rg-group-row').forEach(r => r.remove());
        const rows = bodyRows(table, head).sort(compareRows);
        const tbody = table.tBodies[0];
        if (!state.groupBy) {
          rows.forEach(row => { delete row.dataset.rgGroup; tbody.append(row); });
          return;
        }
        const gth = cells().find(th => name(th) === state.groupBy);
        if (!gth) { state.groupBy = null; rows.forEach(row => tbody.append(row)); return; }
        const gi = colIndex(gth);
        const groups = new Map();
        rows.forEach(row => {
          const value = cellText(row.cells[gi]) || '(vide)';
          row.dataset.rgGroup = value;
          if (!groups.has(value)) groups.set(value, []);
          groups.get(value).push(row);
        });
        groups.forEach((members, value) => {
          tbody.append(groupHeader(value, members));
          members.forEach(row => tbody.append(row));
        });
      });
    }
    // Ligne de groupe : clé, effectif et min–max par colonne numérique.
    // Statistiques DÉRIVÉES calculées sur les valeurs affichées, signalées comme telles.
    function groupHeader(value, members) {
      const tr = el('tr', { class: 'rg-group-row', 'data-rg-group': value });
      const td = el('td');
      const toggle = el('button', { type: 'button', class: 'rg-group-toggle', 'aria-expanded': String(!state.collapsed.has(value)) });
      toggle.append(el('span', { class: 'rg-caret', 'aria-hidden': 'true' }), el('strong', { text: value }), el('span', { class: 'rg-group-count', text: `${members.length} ligne${members.length > 1 ? 's' : ''}` }));
      toggle.addEventListener('click', () => {
        if (state.collapsed.has(value)) state.collapsed.delete(value); else state.collapsed.add(value);
        toggle.setAttribute('aria-expanded', String(!state.collapsed.has(value)));
        applyFilter();
      });
      td.append(toggle);
      const stats = el('span', { class: 'rg-group-stats', title: 'Statistiques dérivées, calculées sur les valeurs affichées — non issues des classeurs' });
      cells().forEach((th, i) => {
        if (prefs.hidden.includes(name(th))) return;
        const texts = members.map(r => cellText(r.cells[i])).filter(Boolean);
        const phys = texts.map(t => ({ t, p: physical(t) }));
        if (phys.length < 2 || phys.some(o => !o.p) || new Set(phys.map(o => o.p.base)).size > 1) return; // non numérique ou unités incompatibles
        phys.sort((a, b) => a.p.value - b.p.value);
        // Textes affichés des cellules min et max : aucune valeur recalculée ni re-arrondie.
        stats.append(el('span', { class: 'rg-stat' }, el('em', { text: name(th) }), document.createTextNode(` min ${phys[0].t} · max ${phys[phys.length - 1].t}`)));
      });
      if (stats.childNodes.length) td.append(el('span', { class: 'rg-derived-badge', text: 'dérivé' }), stats);
      tr.append(td);
      return tr;
    }
    function applyExtremes() {
      table.querySelectorAll('td.rg-min, td.rg-max').forEach(td => td.classList.remove('rg-min', 'rg-max'));
      if (!prefs.extremes) return;
      cells().forEach((th, i) => {
        const rows = bodyRows(table, head).filter(r => r.dataset.rgMatch !== '0');
        const vals = rows.map(r => ({ r, t: cellText(r.cells[i]) })).filter(o => o.t).map(o => { const p = physical(o.t); return { ...o, v: p ? p.value : null, base: p ? p.base : null }; });
        const nums = vals.filter(o => o.v !== null);
        if (nums.length < 2 || nums.length < vals.length || new Set(nums.map(o => o.base)).size > 1) return;
        const min = Math.min(...nums.map(o => o.v)); const max = Math.max(...nums.map(o => o.v));
        if (min === max) return;
        nums.forEach(o => { if (o.v === min) o.r.cells[i].classList.add('rg-min'); if (o.v === max) o.r.cells[i].classList.add('rg-max'); });
      });
    }
    function refresh() {
      layoutRows();
      applyColumns();
      applyFilter();
      applyExtremes();
      renderGroupOptions();
    }
    function sortBy(th) {
      if (!th) state.sort = null;
      else if (!state.sort || state.sort.th !== th) state.sort = { th, dir: 1 };
      else if (state.sort.dir === 1) state.sort.dir = -1;
      else state.sort = null;
      cells().forEach(h => h.setAttribute('aria-sort', state.sort && state.sort.th === h ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none'));
      resetSortBtn.hidden = !state.sort;
      refresh();
    }

    cells().forEach(th => {
      th.style.top = stickyTop;
      th.classList.add('rg-sortable');
      th.setAttribute('aria-sort', 'none');
      th.tabIndex = 0;
      th.draggable = true;
      th.title = th.title || 'Trier (clic : croissant → décroissant → origine) · glisser pour déplacer la colonne';
      th.addEventListener('click', event => { if (!event.target.closest('.rg-resize')) sortBy(th); });
      th.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sortBy(th); }
        if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { // réorganisation au clavier
          event.preventDefault();
          const from = colIndex(th);
          quiet(() => moveColumn(from, Math.max(0, Math.min(cells().length - 1, from + (event.key === 'ArrowLeft' ? -1 : 1)))));
          prefs.order = cells().map(name); store.set(key, prefs);
          th.focus();
        }
      });
      th.addEventListener('dragstart', event => { event.dataTransfer.setData('text/rg-col', name(th)); event.dataTransfer.effectAllowed = 'move'; th.classList.add('rg-dragging'); });
      th.addEventListener('dragend', () => { th.classList.remove('rg-dragging'); cells().forEach(h => h.classList.remove('rg-drop-before', 'rg-drop-after')); });
      th.addEventListener('dragover', event => {
        if (!event.dataTransfer.types.includes('text/rg-col')) return;
        event.preventDefault();
        const rect = th.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        th.classList.toggle('rg-drop-before', before);
        th.classList.toggle('rg-drop-after', !before);
      });
      th.addEventListener('dragleave', () => th.classList.remove('rg-drop-before', 'rg-drop-after'));
      th.addEventListener('drop', event => {
        const dragged = cells().find(h => name(h) === event.dataTransfer.getData('text/rg-col'));
        th.classList.remove('rg-drop-before', 'rg-drop-after');
        if (!dragged || dragged === th) return;
        event.preventDefault();
        const rect = th.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        const from = colIndex(dragged);
        let to = colIndex(th) + (before ? 0 : 1);
        if (from < to) to -= 1;
        quiet(() => moveColumn(from, to));
        prefs.order = cells().map(name);
        store.set(key, prefs);
        refresh();
      });
      const handle = el('span', { class: 'rg-resize', 'aria-hidden': 'true' });
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-active');
        const startX = event.clientX;
        const startW = th.getBoundingClientRect().width;
        const move = e => { const w = Math.max(48, startW + e.clientX - startX); th.style.width = `${w}px`; th.style.minWidth = `${w}px`; };
        const up = () => {
          handle.classList.remove('is-active');
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          prefs.widths[name(th)] = th.style.width;
          store.set(key, prefs);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
      handle.addEventListener('dblclick', event => { event.stopPropagation(); th.style.width = ''; th.style.minWidth = ''; delete prefs.widths[name(th)]; store.set(key, prefs); });
      handle.draggable = false;
      th.append(handle);
      const width = prefs.widths[name(th)];
      if (width) { th.style.width = width; th.style.minWidth = width; }
    });

    // Sélection : Ctrl/⌘ + clic (bascule), Maj + clic (plage). Le clic simple reste à la page.
    table.addEventListener('click', event => {
      const row = event.target.closest('tr');
      if (!row || row === head || row.classList.contains('rg-group-row') || !(event.ctrlKey || event.metaKey || event.shiftKey)) return;
      event.preventDefault();
      const rows = bodyRows(table, head).filter(r => !r.hidden);
      if (event.shiftKey && state.lastClicked && rows.includes(state.lastClicked)) {
        const [a, b] = [rows.indexOf(state.lastClicked), rows.indexOf(row)].sort((x, y) => x - y);
        rows.slice(a, b + 1).forEach(r => r.classList.add('rg-selected'));
      } else {
        row.classList.toggle('rg-selected');
        state.lastClicked = row;
      }
      window.getSelection()?.removeAllRanges();
      applyFilter();
    });

    function matrix(scope) {
      const visibleCols = cells().map((th, i) => (scope !== 'all' && prefs.hidden.includes(name(th)) ? -1 : i)).filter(i => i >= 0);
      const all = bodyRows(table, head);
      let rows;
      if (scope === 'all') rows = all.slice().sort((a, b) => Number(a.dataset.rgIndex) - Number(b.dataset.rgIndex));
      else if (scope === 'selected') rows = all.filter(r => r.classList.contains('rg-selected'));
      else if (scope === 'filtered') rows = all.filter(r => r.dataset.rgMatch !== '0');
      else { const sel = all.filter(r => r.classList.contains('rg-selected')); rows = sel.length ? sel : all.filter(r => r.dataset.rgMatch !== '0'); }
      return [visibleCols.map(i => name(cells()[i])), ...rows.map(r => visibleCols.map(i => cellText(r.cells[i])))];
    }
    const flash = (button, text) => { const old = button.textContent; button.textContent = text; setTimeout(() => { button.textContent = old; }, 1400); };
    copyBtn.addEventListener('click', async () => {
      const tsv = matrix('auto').map(r => r.join('\t')).join('\n');
      try { await navigator.clipboard.writeText(tsv); flash(copyBtn, 'Copié ✓'); } catch { flash(copyBtn, 'Copie impossible'); }
    });
    function exportCsv(scope) {
      const data = matrix(scope);
      if (data.length < 2) { flash(exportMenu.querySelector('summary'), scope === 'selected' ? 'Aucune sélection' : 'Aucune ligne'); return; }
      const q = v => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const csv = '﻿' + data.map(r => r.map(q).join(';')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const title = (table.closest('section, article, .card, .panel, div')?.querySelector('h2, h3')?.textContent || document.title || 'tableau').trim();
      a.download = `${title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\s+/g, '_').slice(0, 70)}_${scope}.csv`;
      document.body.append(a); a.click(); a.remove();
    }
    let searchTimer;
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.query = search.value; applyFilter(); applyExtremes(); }, 120); });

    // Si la page régénère le corps du tableau, on réindexe et on réapplique la vue.
    observer = new MutationObserver(() => {
      bodyRows(table, head).forEach((row, i) => { row.dataset.rgIndex = String(i); });
      state.sort = null;
      cells().forEach(th => th.setAttribute('aria-sort', 'none'));
      resetSortBtn.hidden = true;
      markNumeric();
      refresh();
    });
    function observe() { Array.from(table.tBodies).forEach(tb => observer.observe(tb, { childList: true })); }
    if (Array.isArray(prefs.order)) applyOrder(prefs.order);
    observe();
    refresh();
    table.$rgGrid = { refresh, sortBy: thName => sortBy(cells().find(th => name(th) === thName) || null), groupBy: n => { state.groupBy = n; refresh(); }, matrix, moveColumn: (a, b) => { quiet(() => moveColumn(a, b)); refresh(); } };
  }

  function scan() {
    document.querySelectorAll('table').forEach(table => {
      try { if (eligible(table)) enhance(table); } catch (error) { console.warn('rg-grid', error); }
    });
  }
  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(scan, 250); };
  function start() {
    scan();
    new MutationObserver(mutations => {
      if (mutations.some(m => Array.from(m.addedNodes).some(n => n.nodeType === 1 && !n.classList?.contains('rg-group-row') && (n.tagName === 'TABLE' || n.tagName === 'TBODY' || n.tagName === 'TR' || n.querySelector?.('table'))))) schedule();
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.RGGrid = Object.freeze({ scan, parseNumber, unitOf, physical, compareCells });
})();
