/* Wattman — couche d'analyse pour Chart.js (chargée juste après la librairie).
   Ajoute à chaque graphique, sans modifier ses données :
   - thème cohérent (axes, grilles, légendes, infobulles) clair/sombre ;
   - réticule avec coordonnées exactes au survol ;
   - zoom molette (X ; Alt+molette = Y), déplacement par glisser, sélection
     d'une plage par Maj+glisser, double-clic = vue initiale — uniquement pour
     les graphiques cartésiens qui n'ont pas déjà leur propre navigation ;
   - barre d'outils : vue initiale, réticule, export PNG, export CSV des
     valeurs sources (non arrondies, non décimées).
   Toutes les opérations sont non destructives : seules les bornes d'affichage
   (scale.min / scale.max) changent. */
(function () {
  'use strict';
  const Chart = window.Chart;
  if (!Chart || Chart.__rgStudio) return;
  Chart.__rgStudio = true;

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

  // Valeurs par défaut (ne s'appliquent qu'aux options non définies par la page).
  const t0 = theme();
  Chart.defaults.font.family = t0.font;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = t0.ink2;
  Chart.defaults.borderColor = t0.grid;
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(11,12,14,.94)';
  Chart.defaults.plugins.tooltip.titleColor = '#f4f4f2';
  Chart.defaults.plugins.tooltip.bodyColor = '#e6e6e4';
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(255,255,255,.12)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.cornerRadius = 4;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.boxPadding = 4;
  Chart.defaults.plugins.tooltip.titleFont = { weight: '600' };
  Chart.defaults.plugins.tooltip.bodyFont = { family: t0.mono, size: 12 };
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.legend.labels.boxHeight = 8;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.elements.point.hoverBorderWidth = 2;
  Chart.defaults.animation.duration = (window.RGUI && window.RGUI.reducedMotion()) ? 0 : 420;
  Chart.defaults.animation.easing = 'easeOutQuart';

  const ICON = {
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="3"/></svg>',
    png: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/></svg>'
  };

  const isCartesian = chart => {
    const x = chart.scales && chart.scales.x;
    return !!x && ['linear', 'category', 'time', 'timeseries', 'logarithmic'].includes(x.type);
  };
  const ownsNavigation = chart => !!chart.canvas._navigationAttached; // dashboard de mesure
  const titleOf = (chart, axis) => {
    const title = chart.options.scales && chart.options.scales[axis] && chart.options.scales[axis].title;
    return title && title.display !== false && title.text ? String(title.text) : axis;
  };

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
  function fileBase(chart) {
    const heading = chart.canvas.closest('section, article, .analysis, .chart-shell, .chart-box, .chart-card, .card, div')?.querySelector('h2, h3, h4');
    const base = (heading && heading.textContent.trim()) || document.title || 'graphique';
    return base.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\s+/g, '_').slice(0, 80);
  }

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

    canvas.addEventListener('pointerdown', event => {
      const c = active();
      if (!c || event.button !== 0 || ownsNavigation(c) || !isCartesian(c)) return;
      const scale = c.scales.x;
      initialBounds(c);
      const start = { x: event.offsetX, clientX: event.clientX, min: scale.min, max: scale.max, width: scale.width };
      const selecting = event.shiftKey;
      if (!selecting && !c.$rgZoomed) return; // pan seulement une fois zoomé
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

  // -------------------------------------------------------------- toolbar
  function syncToolbar(chart) {
    const bar = chart.$rgToolbar;
    if (!bar) return;
    bar.classList.toggle('is-zoomed', !!chart.$rgZoomed);
    const cross = bar.querySelector('[data-rg="cross"]');
    if (cross) cross.setAttribute('aria-pressed', String(chart.$rgCrosshair !== false));
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
      b.addEventListener('click', () => { const c = host.$rgChart; if (c) action(c); });
      bar.append(b);
      return b;
    };
    const cartesian = isCartesian(chart);
    if (cartesian) {
      add('reset', ICON.reset, 'Vue initiale (double-clic)', resetView);
      add('cross', ICON.cross, 'Réticule et coordonnées', c => { c.$rgCrosshair = c.$rgCrosshair === false; c.draw(); syncToolbar(c); });
      const sep = document.createElement('span'); sep.className = 'rg-sep'; bar.append(sep);
    }
    add('png', ICON.png, 'Exporter en PNG', exportPng);
    add('csv', 'CSV', 'Exporter les valeurs sources (CSV)', exportCsv);
    host.append(bar);
    if (cartesian) {
      const hint = document.createElement('div');
      hint.className = 'rg-chart-hint';
      hint.textContent = ownsNavigation(chart)
        ? 'Molette : zoom · glisser : déplacer · double-clic : vue initiale'
        : 'Molette : zoom X · Alt+molette : zoom Y · Maj+glisser : plage · double-clic : vue initiale';
      host.append(hint);
    }
    host.$rgToolbar = bar;
    chart.$rgToolbar = bar;
    syncToolbar(chart);
  }

  // ----------------------------------------------------------- plugin
  Chart.register({
    id: 'rgStudio',
    afterUpdate(chart) {
      // Premier rendu seulement : les échelles n'existent qu'après la 1re mise à jour.
      chart.canvas.$rgChart = chart;
      if (chart.canvas.parentNode) chart.canvas.parentNode.$rgChart = chart;
      if (chart.$rgReady) return;
      chart.$rgReady = true;
      if (chart.options.plugins && chart.options.plugins.rgStudio === false) return;
      buildToolbar(chart);
      if (isCartesian(chart)) attachNavigation(chart);
    },
    beforeUpdate(chart) {
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
      if (!isCartesian(chart)) return;
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
      // Étiquettes de coordonnées sur les axes
      ctx.font = `600 11px ${t.mono}`;
      const label = (text, x, y, align) => {
        const w = ctx.measureText(text).width + 10;
        const bx = align === 'center' ? x - w / 2 : x - w;
        ctx.fillStyle = 'rgba(11,12,14,.92)';
        ctx.fillRect(bx, y - 9, w, 18);
        ctx.fillStyle = '#f4f4f2';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 5, y);
      };
      const xs = chart.scales.x;
      const ys = chart.scales.y;
      if (xs && xs.type !== 'category') label(fmt(xs.getValueForPixel(p.x)), p.x, area.bottom + 11, 'center');
      if (ys) label(fmt(ys.getValueForPixel(p.y)), area.left - 2, p.y, 'right');
      ctx.restore();
    }
  });

  // Redessine les graphiques existants au changement de thème.
  window.addEventListener('rg-themechange', () => {
    Object.values(Chart.instances || {}).forEach(chart => { try { chart.update('none'); } catch { /* graphique détruit */ } });
  });

  window.RGCharts = Object.freeze({ exportPng, exportCsv, resetView });
})();
