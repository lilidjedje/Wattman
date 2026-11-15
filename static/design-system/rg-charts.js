/* Wattman — couche d'analyse pour Chart.js (chargée juste après la librairie).
   Ajoute à chaque graphique, sans modifier ses données :
   - thème cohérent (axes, grilles, légendes, infobulles) clair/sombre ;
   - réticule avec coordonnées exactes au survol ;
   - zoom molette (X ; Alt+molette = Y), déplacement par glisser, sélection
     d'une plage par Maj+glisser, double-clic = vue initiale (graphiques sans
     navigation propre) ;
   - curseurs de mesure A/B (Ctrl+clic) accrochés au point mesuré le plus
     proche, avec écarts ΔX / ΔY ;
   - affichage / masquage des seuils, limites et consignes ;
   - synchronisation des axes X entre graphiques de même axe (option) ;
   - exports PNG, SVG vectoriel, PDF (Electron) et CSV des valeurs sources.
   Toutes les opérations sont non destructives : seules les bornes d'affichage
   et la visibilité des séries changent. */
(function () {
  'use strict';
  const Chart = window.Chart;
  if (!Chart || Chart.__rgStudio) return;
  Chart.__rgStudio = true;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* indisponible */ } }
  };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const theme = () => ({
    ink: css('--rg-ink') || '#0b0c0e',
    ink2: css('--rg-ink-2') || '#3a3c41',
    ink3: css('--rg-ink-3') || '#62656b',
    grid: css('--rg-grid-line') || 'rgba(0,0,0,.08)',
    line: css('--rg-line') || '#dcdcda',
    surface: css('--rg-surface') || '#ffffff',
    accent: css('--rg-yellow') || '#efdf00',
    font: css('--rg-font-sans') || 'Segoe UI, Arial, sans-serif',
    mono: css('--rg-font-mono') || 'Consolas, monospace'
  });
  const THRESHOLD = /seuil|limite|threshold|consigne|th[ée]orique|cible|target|limit/i;
  const MARKER_COLORS = ['#1f5fbf', '#d55e00'];

  // Valeurs par défaut (ne s'appliquent qu'aux options non définies par la page).
  const t0 = theme();
  Chart.defaults.font.family = t0.font;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = t0.ink2;
  Chart.defaults.borderColor = t0.grid;
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: 'rgba(11,12,14,.94)', titleColor: '#f4f4f2', bodyColor: '#e6e6e4',
    borderColor: 'rgba(255,255,255,.12)', borderWidth: 1, cornerRadius: 4, padding: 10, boxPadding: 4,
    titleFont: { weight: '600' }, bodyFont: { family: t0.mono, size: 12 }
  });
  Object.assign(Chart.defaults.plugins.legend.labels, { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 14 });
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.elements.point.hoverBorderWidth = 2;
  Chart.defaults.animation.duration = (window.RGUI && window.RGUI.reducedMotion()) ? 0 : 420;
  Chart.defaults.animation.easing = 'easeOutQuart';

  const svgIcon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    reset: svgIcon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    cross: svgIcon('<path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="3"/>'),
    marker: svgIcon('<path d="M7 3v18M17 3v18"/><path d="M7 12h10"/><path d="m10 9-3 3 3 3M14 9l3 3-3 3"/>'),
    threshold: svgIcon('<path d="M3 8h18" stroke-dasharray="3 3"/><path d="m3 18 5-6 4 3 5-7 4 4"/>'),
    sync: svgIcon('<path d="M4 7h13l-3-3M20 17H7l3 3"/>'),
    png: svgIcon('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>')
  };

  const isCartesian = chart => {
    const x = chart.scales && chart.scales.x;
    return !!x && ['linear', 'category', 'time', 'timeseries', 'logarithmic'].includes(x.type);
  };
  const isNumericX = chart => isCartesian(chart) && chart.scales.x.type !== 'category';
  const ownsNavigation = chart => !!chart.canvas._navigationAttached; // dashboard de mesure
  const titleOf = (chart, axis) => {
    const title = chart.options.scales && chart.options.scales[axis] && chart.options.scales[axis].title;
    return title && title.display !== false && title.text ? String(title.text) : axis;
  };
  const instances = () => Object.values(Chart.instances || {});

  function fmt(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '—');
    const abs = Math.abs(value);
    const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 3 : 4;
    return value.toLocaleString('fr-FR', { maximumFractionDigits: digits });
  }

  function download(name, href) {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
  }
  function chartTitle(chart) {
    const heading = chart.canvas.closest('section, article, .analysis, .chart-shell, .chart-box, .chart-card, .card, div')?.querySelector('h2, h3, h4');
    return ((heading && heading.textContent.trim()) || document.title || 'Graphique').replace(/\s+/g, ' ');
  }
  const fileBase = chart => chartTitle(chart).replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\s+/g, '_').slice(0, 80);
  function metadata(chart) {
    let project = '';
    try { project = JSON.parse(store.get('activeProject') || '{}').name || ''; } catch { /* aucun */ }
    const x = chart.scales.x;
    const visible = chart.data.datasets.filter((d, i) => chart.isDatasetVisible(i)).map(d => d.label).filter(Boolean);
    return {
      title: chartTitle(chart),
      project,
      page: location.pathname,
      exportedAt: new Date().toLocaleString('fr-FR'),
      axes: isCartesian(chart) ? `${titleOf(chart, 'x')} / ${titleOf(chart, 'y')}` : '',
      view: x && isNumericX(chart) ? `${titleOf(chart, 'x')} : ${fmt(x.min)} → ${fmt(x.max)}` : '',
      series: visible.join(' · ')
    };
  }

  // ------------------------------------------------------------ exports
  function exportPng(chart) {
    const src = chart.canvas;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = theme().surface;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    download(`${fileBase(chart)}.png`, out.toDataURL('image/png'));
  }

  // CSV au format long : une ligne par point source (valeurs exactes).
  function exportCsv(chart) {
    const q = v => {
      const s = v == null ? '' : String(v);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const labels = chart.data.labels || [];
    const rows = [['serie', titleOf(chart, 'x'), titleOf(chart, 'y')]];
    chart.data.datasets.forEach((dataset, index) => {
      const source = dataset._data || dataset.data || []; // _data = données avant décimation Chart.js
      source.forEach((point, i) => {
        let x; let y;
        if (point !== null && typeof point === 'object') { x = point.x; y = point.y; }
        else { x = labels[i] !== undefined ? labels[i] : i; y = point; }
        rows.push([dataset.label || `Série ${index + 1}`, x, y]);
      });
    });
    const text = '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n');
    download(`${fileBase(chart)}.csv`, URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })));
  }

  // SVG vectoriel : le graphique est redessiné (vue courante) dans un contexte SVG.
  let c2sReady;
  function loadCanvas2Svg() {
    if (c2sReady) return c2sReady;
    c2sReady = new Promise((resolve, reject) => {
      if (window.C2S) { resolve(); return; }
      const s = document.createElement('script');
      s.src = '/static/vendor/canvas2svg.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('canvas2svg indisponible'));
      document.head.append(s);
    }).then(() => {
      // Adaptateurs Chart.js 4 : pointillés, transformations, police, tracés vides.
      const P = window.C2S.prototype;
      if (P.__rgPatched) return;
      P.__rgPatched = true;
      const safe = fn => function () { try { return fn.apply(this, arguments); } catch (e) { if (/path command/.test(e.message)) return undefined; throw e; } };
      const save = P.save; const restore = P.restore; const stroke = safe(P.stroke); const strokeRect = P.strokeRect;
      P.fill = safe(P.fill); P.clip = safe(P.clip);
      P.setLineDash = function (a) { this.__rgDash = (a || []).slice(); };
      P.getLineDash = function () { return (this.__rgDash || []).slice(); };
      P.save = function () { (this.__rgDashStack || (this.__rgDashStack = [])).push(this.__rgDash || []); return save.apply(this, arguments); };
      P.restore = function () { this.__rgDash = (this.__rgDashStack || []).pop() || []; return restore.apply(this, arguments); };
      const dash = function () { if (this.__rgDash && this.__rgDash.length && this.__currentElement) this.__currentElement.setAttribute('stroke-dasharray', this.__rgDash.join(' ')); };
      P.stroke = function () { const r = stroke.apply(this, arguments); dash.call(this); return r; };
      P.strokeRect = function () { const r = strokeRect.apply(this, arguments); dash.call(this); return r; };
      P.resetTransform = function () {};
      P.ellipse = function (x, y, rx, ry, rot, a0, a1, ccw) { this.save(); this.translate(x, y); this.rotate(rot); this.scale(rx, ry || rx); this.arc(0, 0, 1, a0, a1, ccw); this.restore(); };
      P.__parseFont = function () {
        const f = String(this.font || '10px sans-serif');
        const m = f.match(/(\d*\.?\d+(?:px|pt|em|rem|%))(?:\s*\/\s*\S+)?\s+(.+)$/);
        const pre = m ? f.slice(0, m.index) : '';
        const w = (pre.match(/\b(bold(?:er)?|lighter|[1-9]00)\b/) || [])[1];
        return { style: /italic|oblique/.test(pre) ? 'italic' : 'normal', size: m ? m[1] : '10px', family: m ? m[2] : 'sans-serif', weight: w || 'normal', decoration: 'normal', href: null };
      };
    });
    return c2sReady;
  }
  async function toSvg(chart) {
    await loadCanvas2Svg();
    const width = Math.round(chart.width); const height = Math.round(chart.height);
    const ctx = new window.C2S(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext = () => ctx;
    ctx.canvas = canvas;
    ctx.fillStyle = theme().surface;
    ctx.fillRect(0, 0, width, height);
    const raw = chart.config.options || {};
    const options = Object.assign({}, raw, {
      animation: false, responsive: false, maintainAspectRatio: false, devicePixelRatio: 1,
      plugins: Object.assign({}, raw.plugins, { rgStudio: false })
    });
    const datasets = chart.data.datasets.map((d, i) => Object.assign({}, d, { hidden: !chart.isDatasetVisible(i) }));
    const clone = new Chart(canvas, { type: chart.config.type, data: { labels: chart.data.labels, datasets }, options, platform: Chart.BasicPlatform });
    const svg = ctx.getSerializedSvg(true);
    clone.destroy();
    const meta = metadata(chart);
    const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    return svg.replace(/<svg([^>]*)>/, `<svg$1><title>${esc(meta.title)}</title><desc>${esc([meta.project && `Projet : ${meta.project}`, meta.axes, meta.view, `Exporté le ${meta.exportedAt}`].filter(Boolean).join(' — '))}</desc>`);
  }
  async function exportSvg(chart) {
    const svg = await toSvg(chart);
    download(`${fileBase(chart)}.svg`, URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })));
    return svg;
  }
  async function exportPdf(chart) {
    const svg = await toSvg(chart);
    const env = window.desktopEnvironment;
    if (env && typeof env.exportChartPdf === 'function') return env.exportChartPdf(metadata(chart), svg);
    download(`${fileBase(chart)}.svg`, URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })));
    return { canceled: false, fallback: 'svg' };
  }

  // ---------------------------------------------------------- navigation
  function initialBounds(chart) {
    if (!chart.$rgInitial) {
      chart.$rgInitial = {};
      Object.entries(chart.scales).forEach(([id, scale]) => {
        const opt = chart.options.scales[id] || {};
        chart.$rgInitial[id] = { min: opt.min, max: opt.max, dataMin: scale.min, dataMax: scale.max };
      });
    }
    return chart.$rgInitial;
  }
  function setRange(chart, axis, min, max) {
    const initial = initialBounds(chart)[axis];
    if (!initial || !(max > min)) return;
    const lo = Math.min(initial.dataMin, initial.min ?? initial.dataMin);
    const hi = Math.max(initial.dataMax, initial.max ?? initial.dataMax);
    const span = hi - lo;
    let range = Math.max(span / 5000, Math.min(max - min, span));
    if (chart.scales[axis].type === 'category') range = Math.max(1, Math.round(range));
    if (min < lo) { min = lo; max = lo + range; }
    if (max > hi) { max = hi; min = hi - range; }
    chart.options.scales[axis].min = min;
    chart.options.scales[axis].max = max;
    chart.$rgZoomed = true;
    chart.update('none');
    syncToolbar(chart);
  }
  function resetView(chart) {
    if (ownsNavigation(chart)) {
      // Dashboard de mesure : il gère lui-même ses bornes (double-clic natif).
      chart.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return;
    }
    const initial = chart.$rgInitial;
    if (!initial) return;
    Object.entries(initial).forEach(([id, bounds]) => {
      if (!chart.options.scales[id]) return;
      if (bounds.min === undefined) delete chart.options.scales[id].min; else chart.options.scales[id].min = bounds.min;
      if (bounds.max === undefined) delete chart.options.scales[id].max; else chart.options.scales[id].max = bounds.max;
    });
    chart.$rgZoomed = false;
    chart.update(window.RGUI && window.RGUI.reducedMotion() ? 'none' : undefined);
    syncToolbar(chart);
  }

  // Curseurs de mesure : point réel le plus proche (valeurs exactes, non interpolées).
  function placeMarker(chart, event) {
    const hits = chart.getElementsAtEventForMode(event, 'nearest', { intersect: false, axis: 'x' }, false);
    if (!hits.length) return;
    const { datasetIndex, index } = hits[0];
    const dataset = chart.data.datasets[datasetIndex];
    const parsed = chart.getDatasetMeta(datasetIndex).controller.getParsed(index);
    const markers = chart.$rgMarkers || (chart.$rgMarkers = []);
    if (markers.length === 2) markers.shift();
    markers.push({ x: parsed.x, y: parsed.y, series: dataset.label || `Série ${datasetIndex + 1}`, label: chart.data.labels ? chart.data.labels[index] : undefined });
    markers.forEach((m, i) => { m.name = i === 0 ? 'A' : 'B'; });
    chart.draw();
    syncToolbar(chart);
    chart.canvas.dispatchEvent(new CustomEvent('rg-marker', { detail: markers.slice(), bubbles: true }));
  }

  function attachNavigation(chart) {
    const canvas = chart.canvas;
    if (canvas.$rgNav) return;
    canvas.$rgNav = true;
    const active = () => canvas.$rgChart;
    canvas.addEventListener('wheel', event => {
      const c = active();
      if (!c || ownsNavigation(c) || !isCartesian(c)) return;
      event.preventDefault();
      const axis = event.altKey ? 'y' : 'x';
      const scale = c.scales[axis];
      if (!scale) return;
      initialBounds(c);
      const ratio = axis === 'x'
        ? Math.max(0, Math.min(1, (event.offsetX - scale.left) / scale.width))
        : Math.max(0, Math.min(1, (scale.bottom - event.offsetY) / scale.height));
      const range = scale.max - scale.min;
      const next = range * (event.deltaY < 0 ? 0.8 : 1.25);
      const anchor = scale.min + range * ratio;
      setRange(c, axis, anchor - next * ratio, anchor + next * (1 - ratio));
    }, { passive: false });

    canvas.addEventListener('dblclick', () => {
      const c = active();
      if (c && !ownsNavigation(c) && c.$rgZoomed) resetView(c);
    });
    canvas.addEventListener('click', event => {
      const c = active();
      if (c && isCartesian(c) && (event.ctrlKey || event.metaKey)) { event.preventDefault(); placeMarker(c, event); }
    });

    canvas.addEventListener('pointerdown', event => {
      const c = active();
      if (!c || event.button !== 0 || event.ctrlKey || event.metaKey || ownsNavigation(c) || !isCartesian(c)) return;
      const scale = c.scales.x;
      initialBounds(c);
      const start = { x: event.offsetX, clientX: event.clientX, min: scale.min, max: scale.max, width: scale.width };
      const selecting = event.shiftKey;
      if (!selecting && !c.$rgZoomed) return; // déplacement seulement une fois zoomé
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = selecting ? 'col-resize' : 'grabbing';
      const move = e => {
        if (selecting) {
          c.$rgBand = [Math.min(start.x, e.offsetX), Math.max(start.x, e.offsetX)];
          c.draw();
        } else {
          const shift = -(e.clientX - start.clientX) / start.width * (start.max - start.min);
          setRange(c, 'x', start.min + shift, start.max + shift);
        }
      };
      const up = () => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
        canvas.style.cursor = '';
        if (selecting && c.$rgBand) {
          const [a, b] = c.$rgBand;
          c.$rgBand = null;
          if (b - a > 6) setRange(c, 'x', scale.getValueForPixel(a), scale.getValueForPixel(b));
          else c.draw();
        }
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
    });
  }

  // ------------------------------------------------ synchronisation des axes X
  const syncEnabled = () => store.get('rg-chart-sync') === '1';
  let syncing = false;
  function syncPeers(source) {
    if (!syncEnabled() || syncing || !isNumericX(source)) return;
    const title = titleOf(source, 'x');
    const { min, max } = source.scales.x;
    syncing = true;
    try {
      instances().forEach(peer => {
        if (peer === source || !isNumericX(peer) || titleOf(peer, 'x') !== title) return;
        const opt = peer.options.scales.x;
        if (opt.min === min && opt.max === max) return;
        initialBounds(peer);
        opt.min = min; opt.max = max;
        peer.$rgZoomed = true;
        peer.$userNavigated = true; // respecté par le dashboard de mesure
        peer.update('none');
        peer.$rgLastX = [min, max];
        syncToolbar(peer);
      });
    } finally { syncing = false; }
  }

  // -------------------------------------------------------------- toolbar
  const thresholdIndexes = chart => chart.data.datasets.map((d, i) => (THRESHOLD.test(d.label || '') ? i : -1)).filter(i => i >= 0);
  function syncToolbar(chart) {
    const bar = chart.$rgToolbar;
    if (!bar) return;
    bar.classList.toggle('is-zoomed', !!chart.$rgZoomed || !!(chart.$rgMarkers && chart.$rgMarkers.length));
    const set = (key, value) => { const b = bar.querySelector(`[data-rg="${key}"]`); if (b) b.setAttribute('aria-pressed', String(value)); };
    set('cross', chart.$rgCrosshair !== false);
    set('sync', syncEnabled());
    const th = thresholdIndexes(chart);
    set('threshold', th.length > 0 && th.some(i => chart.isDatasetVisible(i)));
    const markerBtn = bar.querySelector('[data-rg="marker"]');
    if (markerBtn) markerBtn.hidden = !(chart.$rgMarkers && chart.$rgMarkers.length);
  }
  function buildToolbar(chart) {
    const host = chart.canvas.parentNode;
    if (!host || host.$rgToolbar) { if (host) { chart.$rgToolbar = host.$rgToolbar; syncToolbar(chart); } return; }
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.classList.add('rg-chart-host');
    const bar = document.createElement('div');
    bar.className = 'rg-chart-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Outils du graphique');
    const add = (key, html, label, action) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.rg = key;
      b.innerHTML = html;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', async () => {
        const c = host.$rgChart;
        if (!c) return;
        b.disabled = true;
        try { await action(c); } catch (error) { console.warn('rg-charts', error); } finally { b.disabled = false; }
      });
      bar.append(b);
      return b;
    };
    const sep = () => { const s = document.createElement('span'); s.className = 'rg-sep'; bar.append(s); };
    const cartesian = isCartesian(chart);
    if (cartesian) {
      add('reset', ICON.reset, 'Vue initiale (double-clic)', resetView);
      add('cross', ICON.cross, 'Réticule et coordonnées', c => { c.$rgCrosshair = c.$rgCrosshair === false; c.draw(); syncToolbar(c); });
      add('marker', ICON.marker, 'Effacer les curseurs A/B (Ctrl+clic pour placer)', c => { c.$rgMarkers = []; c.draw(); syncToolbar(c); });
      if (thresholdIndexes(chart).length) {
        add('threshold', ICON.threshold, 'Afficher / masquer les seuils et consignes', c => {
          const idx = thresholdIndexes(c);
          const show = !idx.some(i => c.isDatasetVisible(i));
          idx.forEach(i => c.setDatasetVisibility(i, show));
          c.update();
          syncToolbar(c);
        });
      }
      if (isNumericX(chart)) {
        add('sync', ICON.sync, 'Synchroniser l’axe horizontal des graphiques de même axe', c => {
          store.set('rg-chart-sync', syncEnabled() ? '0' : '1');
          instances().forEach(syncToolbar);
          syncPeers(c);
        });
      }
      sep();
    }
    add('png', ICON.png, 'Exporter en PNG', exportPng);
    add('svg', 'SVG', 'Exporter en SVG vectoriel', exportSvg);
    add('pdf', 'PDF', 'Exporter en PDF', exportPdf);
    add('csv', 'CSV', 'Exporter les valeurs sources (CSV)', exportCsv);
    host.append(bar);
    if (cartesian) {
      const hint = document.createElement('div');
      hint.className = 'rg-chart-hint';
      hint.textContent = ownsNavigation(chart)
        ? 'Molette : zoom · glisser : déplacer · double-clic : vue initiale · Ctrl+clic : curseur A/B'
        : 'Molette : zoom X · Alt+molette : zoom Y · Maj+glisser : plage · Ctrl+clic : curseur A/B · double-clic : vue initiale';
      host.append(hint);
    }
    host.$rgToolbar = bar;
    chart.$rgToolbar = bar;
    syncToolbar(chart);
  }

  // ----------------------------------------------------------- dessin
  function label(ctx, text, x, y, align, bg = 'rgba(11,12,14,.92)') {
    const w = ctx.measureText(text).width + 10;
    const bx = align === 'center' ? x - w / 2 : align === 'left' ? x : x - w;
    ctx.fillStyle = bg;
    ctx.fillRect(bx, y - 9, w, 18);
    ctx.fillStyle = '#f4f4f2';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 5, y);
  }
  function drawMarkers(chart, t) {
    const markers = chart.$rgMarkers;
    if (!markers || !markers.length) return;
    const { ctx, chartArea: area } = chart;
    const xs = chart.scales.x; const ys = chart.scales.y;
    ctx.save();
    ctx.font = `600 11px ${t.mono}`;
    markers.forEach((m, i) => {
      const px = xs.type === 'category' ? xs.getPixelForValue(m.x) : xs.getPixelForValue(m.x);
      if (px < area.left || px > area.right) return;
      const color = MARKER_COLORS[i];
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, area.top); ctx.lineTo(px, area.bottom); ctx.stroke();
      if (ys && Number.isFinite(m.y)) {
        const py = ys.getPixelForValue(m.y);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
      }
      const xText = m.label !== undefined ? String(m.label) : fmt(m.x);
      label(ctx, `${m.name}  x=${xText}  y=${fmt(m.y)}`, px + 4, area.top + 12 + i * 22, 'left', color);
    });
    if (markers.length === 2) {
      const [a, b] = markers;
      const dx = typeof a.x === 'number' && typeof b.x === 'number' ? fmt(b.x - a.x) : '—';
      const text = `ΔX (B−A) = ${dx}   ΔY (B−A) = ${fmt(b.y - a.y)}`;
      label(ctx, text, area.right - 4, area.bottom - 14, 'right');
    }
    ctx.restore();
  }

  // ----------------------------------------------------------- plugin
  Chart.register({
    id: 'rgStudio',
    afterUpdate(chart) {
      // Premier rendu seulement : les échelles n'existent qu'après la 1re mise à jour.
      chart.canvas.$rgChart = chart;
      if (chart.canvas.parentNode) chart.canvas.parentNode.$rgChart = chart;
      if (chart.options.plugins && chart.options.plugins.rgStudio === false) return;
      if (!chart.$rgReady) {
        chart.$rgReady = true;
        buildToolbar(chart);
        if (isCartesian(chart)) attachNavigation(chart);
      }
      // Propagation de la vue (y compris la navigation propre du dashboard).
      if (isNumericX(chart)) {
        const now = [chart.scales.x.min, chart.scales.x.max];
        const last = chart.$rgLastX;
        chart.$rgLastX = now;
        if (last && (last[0] !== now[0] || last[1] !== now[1])) syncPeers(chart);
      }
    },
    beforeUpdate(chart) {
      if (chart.options.plugins && chart.options.plugins.rgStudio === false && chart.canvas.isConnected === false) return;
      // Habillage (axes, grille, légende) aligné sur le thème : jamais les séries.
      const t = theme();
      const scales = chart.options.scales || {};
      Object.values(scales).forEach(scale => {
        if (!scale || typeof scale !== 'object') return;
        if (scale.ticks) { scale.ticks.color = t.ink3; scale.ticks.font = Object.assign({}, scale.ticks.font, { family: t.font }); }
        if (scale.grid) { scale.grid.color = t.grid; if ('borderColor' in scale.grid) scale.grid.borderColor = t.line; }
        if (scale.border) scale.border.color = t.line;
        if (scale.title) { scale.title.color = t.ink2; scale.title.font = Object.assign({ weight: '600' }, scale.title.font, { family: t.font }); }
      });
      const legend = chart.options.plugins && chart.options.plugins.legend;
      if (legend && legend.labels) legend.labels.color = t.ink2;
      const title = chart.options.plugins && chart.options.plugins.title;
      if (title) title.color = t.ink;
    },
    afterEvent(chart, args) {
      const e = args.event;
      if (e.type === 'mousemove') { chart.$rgPointer = { x: e.x, y: e.y }; args.changed = true; }
      if (e.type === 'mouseout') { chart.$rgPointer = null; args.changed = true; }
    },
    afterDatasetsDraw(chart) {
      if (!isCartesian(chart) || (chart.options.plugins && chart.options.plugins.rgStudio === false)) return;
      const { ctx, chartArea: area } = chart;
      const t = theme();
      if (chart.$rgBand) {
        const [a, b] = chart.$rgBand;
        ctx.save();
        ctx.fillStyle = 'rgba(239,223,0,.18)';
        ctx.strokeStyle = t.ink;
        ctx.fillRect(a, area.top, b - a, area.bottom - area.top);
        ctx.strokeRect(a + .5, area.top + .5, b - a - 1, area.bottom - area.top - 1);
        ctx.restore();
      }
      drawMarkers(chart, t);
      const p = chart.$rgPointer;
      if (chart.$rgCrosshair === false || !p || p.x < area.left || p.x > area.right || p.y < area.top || p.y > area.bottom) return;
      ctx.save();
      ctx.strokeStyle = t.ink3;
      ctx.globalAlpha = .55;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(p.x) + .5, area.top); ctx.lineTo(Math.round(p.x) + .5, area.bottom);
      ctx.moveTo(area.left, Math.round(p.y) + .5); ctx.lineTo(area.right, Math.round(p.y) + .5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.font = `600 11px ${t.mono}`;
      const xs = chart.scales.x;
      const ys = chart.scales.y;
      if (xs && xs.type !== 'category') label(ctx, fmt(xs.getValueForPixel(p.x)), p.x, area.bottom + 11, 'center');
      if (ys) label(ctx, fmt(ys.getValueForPixel(p.y)), area.left - 2, p.y, 'right');
      ctx.restore();
    }
  });

  // Redessine les graphiques existants au changement de thème.
  window.addEventListener('rg-themechange', () => {
    instances().forEach(chart => { try { chart.update('none'); } catch { /* graphique détruit */ } });
  });

  window.RGCharts = Object.freeze({ exportPng, exportCsv, exportSvg, exportPdf, toSvg, resetView, setRange, syncPeers });
})();
