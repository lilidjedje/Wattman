/* Wattman — data grid progressif pour les tableaux HTML existants.
   Activé automatiquement sur les tableaux de données en LECTURE SEULE à
   structure simple (une ligne d'en-tête, pas de fusion de cellules, pas de
   champ de saisie, au moins 4 lignes). Forçage : data-rg-grid="on" / "off".
   Fonctions : recherche globale, tri par colonne (3 états), masquage de
   colonnes, redimensionnement, densité, en-tête fixe, sélection de lignes
   (Ctrl/Maj + clic), copie, export CSV (vue filtrée ou sélection).
   Non destructif : les cellules (texte, classes .xl-*, styles) ne sont jamais
   modifiées ; seules la visibilité et l'ordre d'affichage des lignes changent,
   et « ordre d'origine » restaure l'ordre initial exact. */
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
    return rows.filter(r => r !== head);
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

  let tableSeq = 0;
  function enhance(table) {
    const head = headerRow(table);
    const headers = Array.from(head.cells);
    const tbody = table.tBodies[0];
    const key = `rg-grid:${location.pathname}:${table.id || table.getAttribute('aria-label') || headers.map(h => h.textContent.trim()).join('|').slice(0, 120) || tableSeq}`;
    tableSeq += 1;
    const prefs = Object.assign({ hidden: [], density: 'normal', widths: {} }, store.get(key));
    const state = { query: '', sort: null, lastClicked: null };
    table.classList.add('rg-grid');
    table.dataset.density = prefs.density;
    const originalOrder = () => bodyRows(table, head);
    let rowsOrigin = originalOrder();
    rowsOrigin.forEach((row, i) => { row.dataset.rgIndex = String(i); });

    // Alignement numérique (présentation uniquement)
    const markNumeric = () => bodyRows(table, head).forEach(row => Array.from(row.cells).forEach(cell => {
      if (!cell.style.textAlign && parseNumber(cellText(cell)) !== null && /^[-+−\d.,\s  ]+[^\d]{0,8}$/.test(cellText(cell))) cell.classList.add('rg-num');
    }));
    markNumeric();

    // En-tête fixe : sous la barre d'application si le défilement est celui de la page
    let scroller = table.parentElement;
    while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const stickyTop = (!scroller || scroller === document.body) && document.documentElement.classList.contains('rg-has-appbar') ? 'var(--rg-appbar-h)' : '0px';
    headers.forEach(th => { th.style.top = stickyTop; });

    // ---------------------------------------------------------- toolbar
    const bar = document.createElement('div');
    bar.className = 'rg-grid-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Outils du tableau');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'rg-grid-search';
    search.placeholder = 'Rechercher dans le tableau…';
    search.setAttribute('aria-label', 'Rechercher dans le tableau');
    bar.append(search);

    const columnsMenu = document.createElement('details');
    columnsMenu.innerHTML = '<summary>Colonnes</summary><div class="rg-pop"></div>';
    const pop = columnsMenu.querySelector('.rg-pop');
    headers.forEach((th, index) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !prefs.hidden.includes(th.textContent.trim());
      box.addEventListener('change', () => {
        const name = th.textContent.trim();
        prefs.hidden = prefs.hidden.filter(h => h !== name);
        if (!box.checked) prefs.hidden.push(name);
        store.set(key, prefs);
        applyColumns();
      });
      label.append(box, document.createTextNode(th.textContent.trim() || `Colonne ${index + 1}`));
      pop.append(label);
    });
    const showAll = document.createElement('button');
    showAll.type = 'button';
    showAll.textContent = 'Tout afficher';
    showAll.addEventListener('click', () => { prefs.hidden = []; store.set(key, prefs); pop.querySelectorAll('input').forEach(b => { b.checked = true; }); applyColumns(); });
    pop.append(showAll);
    bar.append(columnsMenu);

    const densities = ['compact', 'normal', 'comfortable'];
    const densityLabel = { compact: 'Compacte', normal: 'Standard', comfortable: 'Aérée' };
    const densityBtn = document.createElement('button');
    densityBtn.type = 'button';
    densityBtn.title = 'Densité d’affichage';
    const renderDensity = () => { densityBtn.textContent = `Densité : ${densityLabel[prefs.density]}`; table.dataset.density = prefs.density; };
    densityBtn.addEventListener('click', () => { prefs.density = densities[(densities.indexOf(prefs.density) + 1) % 3]; store.set(key, prefs); renderDensity(); });
    renderDensity();

    const resetSortBtn = document.createElement('button');
    resetSortBtn.type = 'button';
    resetSortBtn.textContent = 'Ordre d’origine';
    resetSortBtn.hidden = true;
    resetSortBtn.addEventListener('click', () => sortBy(null));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copier';
    copyBtn.title = 'Copier la sélection (ou la vue filtrée) au format tableur';
    const csvBtn = document.createElement('button');
    csvBtn.type = 'button';
    csvBtn.textContent = 'CSV';
    csvBtn.title = 'Exporter la sélection (ou la vue filtrée) en CSV';
    const count = document.createElement('span');
    count.className = 'rg-grid-count';
    count.setAttribute('aria-live', 'polite');
    bar.append(densityBtn, resetSortBtn, copyBtn, csvBtn, count);

    const anchor = table.parentElement && table.parentElement !== document.body
      && table.parentElement.children.length === 1 && /table|scroll|wrap|container|excel|shell/i.test(table.parentElement.className)
      ? table.parentElement : table;
    anchor.before(bar);

    // ---------------------------------------------------------- logique
    const visibleColumnIndexes = () => headers.map((th, i) => (prefs.hidden.includes(th.textContent.trim()) ? -1 : i)).filter(i => i >= 0);
    function applyColumns() {
      const hidden = new Set(headers.map((th, i) => (prefs.hidden.includes(th.textContent.trim()) ? i : -1)).filter(i => i >= 0));
      [head, ...bodyRows(table, head)].forEach(row => Array.from(row.cells).forEach((cell, i) => { cell.style.display = hidden.has(i) ? 'none' : ''; }));
    }
    function applyFilter() {
      const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      const rows = bodyRows(table, head);
      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        const match = terms.every(t => text.includes(t));
        row.hidden = !match;
        if (match) shown += 1;
      });
      const selected = rows.filter(r => r.classList.contains('rg-selected')).length;
      count.textContent = `${shown} / ${rows.length} ligne${rows.length > 1 ? 's' : ''}${selected ? ` · ${selected} sélectionnée${selected > 1 ? 's' : ''}` : ''}`;
    }
    function sortBy(index) {
      if (index === null || index === undefined) state.sort = null;
      else if (!state.sort || state.sort.index !== index) state.sort = { index, dir: 1 };
      else if (state.sort.dir === 1) state.sort.dir = -1;
      else state.sort = null;
      headers.forEach((th, i) => th.setAttribute('aria-sort', state.sort && state.sort.index === i ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none'));
      const rows = bodyRows(table, head);
      let ordered;
      if (!state.sort) ordered = rows.slice().sort((a, b) => Number(a.dataset.rgIndex) - Number(b.dataset.rgIndex));
      else {
        const { index: col, dir } = state.sort;
        ordered = rows.slice().sort((a, b) => {
          const ta = cellText(a.cells[col]); const tb = cellText(b.cells[col]);
          const na = parseNumber(ta); const nb = parseNumber(tb);
          if (ta === '' && tb !== '') return 1;          // vides toujours en bas
          if (tb === '' && ta !== '') return -1;
          const cmp = na !== null && nb !== null ? na - nb : collator.compare(ta, tb);
          return cmp * dir || Number(a.dataset.rgIndex) - Number(b.dataset.rgIndex);
        });
      }
      observer.disconnect();
      ordered.forEach(row => row.parentElement.append(row));
      observe();
      resetSortBtn.hidden = !state.sort;
    }
    headers.forEach((th, index) => {
      th.classList.add('rg-sortable');
      th.setAttribute('aria-sort', 'none');
      th.tabIndex = 0;
      th.title = th.title || 'Trier (clic : croissant → décroissant → origine)';
      th.addEventListener('click', event => { if (!event.target.closest('.rg-resize')) sortBy(index); });
      th.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sortBy(index); } });
      const handle = document.createElement('span');
      handle.className = 'rg-resize';
      handle.setAttribute('aria-hidden', 'true');
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
          prefs.widths[th.textContent.trim()] = th.style.width;
          store.set(key, prefs);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
      handle.addEventListener('dblclick', event => { event.stopPropagation(); th.style.width = ''; th.style.minWidth = ''; delete prefs.widths[th.textContent.trim()]; store.set(key, prefs); });
      th.append(handle);
      const width = prefs.widths[th.textContent.trim()];
      if (width) { th.style.width = width; th.style.minWidth = width; }
    });

    // Sélection : Ctrl/⌘ + clic (bascule), Maj + clic (plage). Le clic simple reste à la page.
    table.addEventListener('click', event => {
      const row = event.target.closest('tr');
      if (!row || row === head || !(event.ctrlKey || event.metaKey || event.shiftKey)) return;
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

    function matrix() {
      const cols = visibleColumnIndexes();
      const all = bodyRows(table, head).filter(r => !r.hidden);
      const selected = all.filter(r => r.classList.contains('rg-selected'));
      const rows = selected.length ? selected : all;
      return [cols.map(i => headers[i].textContent.trim()), ...rows.map(r => cols.map(i => cellText(r.cells[i])))];
    }
    const flash = (button, text) => { const old = button.textContent; button.textContent = text; setTimeout(() => { button.textContent = old; }, 1400); };
    copyBtn.addEventListener('click', async () => {
      const tsv = matrix().map(r => r.join('\t')).join('\n');
      try { await navigator.clipboard.writeText(tsv); flash(copyBtn, 'Copié ✓'); } catch { flash(copyBtn, 'Copie impossible'); }
    });
    csvBtn.addEventListener('click', () => {
      const q = v => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const csv = '﻿' + matrix().map(r => r.map(q).join(';')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const title = (table.closest('section, article, .card, .panel, div')?.querySelector('h2, h3')?.textContent || document.title || 'tableau').trim();
      a.download = `${title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\s+/g, '_').slice(0, 80)}.csv`;
      document.body.append(a); a.click(); a.remove();
    });
    let searchTimer;
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.query = search.value; applyFilter(); }, 120); });

    // Si la page régénère le corps du tableau, on réindexe et on réapplique la vue.
    const observer = new MutationObserver(() => {
      rowsOrigin = originalOrder();
      rowsOrigin.forEach((row, i) => { row.dataset.rgIndex = String(i); });
      state.sort = null;
      headers.forEach(th => th.setAttribute('aria-sort', 'none'));
      resetSortBtn.hidden = true;
      markNumeric();
      applyColumns();
      applyFilter();
    });
    const observe = () => Array.from(table.tBodies).forEach(tb => observer.observe(tb, { childList: true }));
    observe();
    applyColumns();
    applyFilter();
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
      if (mutations.some(m => Array.from(m.addedNodes).some(n => n.nodeType === 1 && (n.tagName === 'TABLE' || n.tagName === 'TBODY' || n.tagName === 'TR' || n.querySelector?.('table'))))) schedule();
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.RGGrid = Object.freeze({ scan, parseNumber });
})();
