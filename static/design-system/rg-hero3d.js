/* Wattman — scène 3D d'accueil : véhicule en vue éclatée filaire (création
   originale, silhouette générique, aucun logo). Canvas 2D + projection
   perspective, sans dépendance.
   - la caisse se soulève (vue éclatée) pour révéler l'intérieur : plancher,
     sièges, pack batterie, calculateurs (ECU) et faisceau ;
   - impulsions jaunes = courant circulant de la batterie 12 V vers les ECU ;
   - balayage de scan, halo des ECU actifs, rotation lente + parallaxe ;
   - image fixe si mouvements réduits ; pause hors écran / onglet masqué. */
(function () {
  'use strict';

  // Repère : x = longueur (avant négatif), y = hauteur, z = largeur.
  const PROFILE = [ // [x, haut de caisse, demi-largeur]
    [-2.25, 0.58, 0.70], [-2.05, 0.68, 0.82], [-1.55, 0.78, 0.86], [-1.05, 0.84, 0.88],
    [-0.75, 1.02, 0.86], [-0.45, 1.30, 0.80], [0.10, 1.38, 0.78], [0.80, 1.36, 0.78],
    [1.45, 1.26, 0.80], [1.85, 1.08, 0.82], [2.15, 0.86, 0.80], [2.28, 0.66, 0.72]
  ];
  const BELT = 0.82;   // ligne de ceinture : au-dessus, la caisse est « éclatée »
  const FLOOR = 0.30;
  const WHEELS = [[-1.42, -0.86], [-1.42, 0.86], [1.38, -0.86], [1.38, 0.86]];
  const ECUS = [
    { id: '12V', pos: [-1.78, 0.52, 0.48], size: [0.30, 0.20, 0.22] },
    { id: 'ECM', pos: [-1.75, 0.56, -0.38], size: [0.26, 0.12, 0.20] },
    { id: 'GW', pos: [-0.62, 0.62, 0.00], size: [0.20, 0.08, 0.16] },
    { id: 'BCM', pos: [-0.78, 0.60, 0.58], size: [0.22, 0.08, 0.16] },
    { id: 'HVAC', pos: [-0.92, 0.66, -0.50], size: [0.24, 0.10, 0.18] },
    { id: 'DCDC', pos: [0.10, 0.36, 0.00], size: [0.28, 0.08, 0.22] },
    { id: 'ADAS', pos: [-0.30, 1.20, 0.00], size: [0.18, 0.06, 0.14], lifted: true },
    { id: 'TCU', pos: [1.70, 0.62, 0.48], size: [0.20, 0.08, 0.16] }
  ];
  // Faisceau : 12 V → passerelle → calculateurs.
  const HARNESS = [['12V', 'ECM'], ['12V', 'GW'], ['GW', 'BCM'], ['GW', 'HVAC'], ['GW', 'DCDC'], ['GW', 'ADAS'], ['DCDC', 'TCU']];

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function buildModel() {
    const segs = []; // { a:[x,y,z], b:[x,y,z], w, kind }
    const add = (a, b, w, kind) => segs.push({ a, b, w, kind });
    // Sections transversales (couples) + lisses longitudinales.
    const ring = ([x, top, half]) => {
      const t = Math.max(top, BELT + 0.04);
      const roof = top > 1.0;
      return [
        [x, 0.24, -half], [x, BELT, -half - 0.02], [x, t, -(roof ? half * 0.78 : half * 0.94)],
        [x, t, roof ? half * 0.78 : half * 0.94], [x, BELT, half + 0.02], [x, 0.24, half]
      ];
    };
    const rings = PROFILE.map(ring);
    rings.forEach((r, i) => {
      for (let k = 0; k < r.length; k++) add(r[k], r[(k + 1) % r.length], i % 3 === 0 ? 0.9 : 0.45, 'body');
      if (i > 0) rings[i - 1].forEach((p, k) => add(p, r[k], k === 2 || k === 3 ? 0.9 : 0.6, 'body'));
    });
    // Montants de vitrage (A, B, C).
    [-0.62, 0.45, 1.6].forEach(x => {
      const p = PROFILE.reduce((a, b) => (Math.abs(b[0] - x) < Math.abs(a[0] - x) ? b : a));
      [-1, 1].forEach(s => add([x, BELT, s * p[2]], [x, p[1], s * p[2] * 0.8], 0.8, 'body'));
    });
    // Roues : jantes + moyeux.
    WHEELS.forEach(([x, z]) => {
      const n = 22, r = 0.34, y0 = 0.34;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        add([x + Math.cos(a0) * r, y0 + Math.sin(a0) * r, z], [x + Math.cos(a1) * r, y0 + Math.sin(a1) * r, z], 1, 'wheel');
        if (k % 4 === 0) add([x, y0, z], [x + Math.cos(a0) * r * 0.62, y0 + Math.sin(a0) * r * 0.62, z], 0.4, 'wheel');
      }
    });
    // Plancher, pack batterie (cellules) et sièges.
    const rect = (x0, x1, y, z0, z1, w, kind) => {
      add([x0, y, z0], [x1, y, z0], w, kind); add([x1, y, z0], [x1, y, z1], w, kind);
      add([x1, y, z1], [x0, y, z1], w, kind); add([x0, y, z1], [x0, y, z0], w, kind);
    };
    rect(-1.1, 1.2, FLOOR, -0.72, 0.72, 0.5, 'chassis');
    rect(-0.95, 1.05, 0.26, -0.62, 0.62, 0.9, 'pack');
    for (let i = 1; i < 8; i++) { const x = -0.95 + i * 0.25; add([x, 0.26, -0.62], [x, 0.26, 0.62], 0.3, 'pack'); }
    add([-0.95, 0.26, 0], [1.05, 0.26, 0], 0.3, 'pack');
    const seat = (x, z) => {
      add([x, FLOOR + 0.14, z - 0.2], [x, FLOOR + 0.14, z + 0.2], 0.6, 'chassis');
      add([x - 0.32, FLOOR + 0.14, z - 0.2], [x - 0.32, FLOOR + 0.14, z + 0.2], 0.6, 'chassis');
      add([x, FLOOR + 0.14, z], [x - 0.32, FLOOR + 0.14, z], 0.6, 'chassis');
      add([x, FLOOR + 0.14, z - 0.2], [x + 0.08, FLOOR + 0.62, z - 0.18], 0.6, 'chassis');
      add([x, FLOOR + 0.14, z + 0.2], [x + 0.08, FLOOR + 0.62, z + 0.18], 0.6, 'chassis');
      add([x + 0.08, FLOOR + 0.62, z - 0.18], [x + 0.08, FLOOR + 0.62, z + 0.18], 0.6, 'chassis');
    };
    seat(-0.05, -0.38); seat(-0.05, 0.38); seat(0.95, -0.38); seat(0.95, 0.38);
    // Sol d'atelier.
    for (let g = -5; g <= 5; g++) {
      add([g * 0.6, 0, -1.9], [g * 0.6, 0, 1.9], 0.16, 'grid');
      add([-3.0, 0, g * 0.38], [3.0, 0, g * 0.38], 0.16, 'grid');
    }
    // Calculateurs.
    ECUS.forEach(e => {
      const [x, y, z] = e.pos, [w, h, d] = e.size.map(v => v / 2);
      const c = [[x - w, y - h, z - d], [x + w, y - h, z - d], [x + w, y - h, z + d], [x - w, y - h, z + d],
        [x - w, y + h, z - d], [x + w, y + h, z - d], [x + w, y + h, z + d], [x - w, y + h, z + d]];
      [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
        .forEach(([i, j]) => add(c[i], c[j], 1, e.lifted ? 'ecu-lifted' : 'ecu'));
    });
    // Faisceau : chemins en L (le long du plancher), utilisés aussi par les impulsions.
    const byId = Object.fromEntries(ECUS.map(e => [e.id, e]));
    const paths = HARNESS.map(([from, to]) => {
      const a = byId[from].pos, b = byId[to].pos;
      const mid = [b[0], Math.min(a[1], b[1], 0.5), a[2]];
      return { to, lifted: !!byId[to].lifted, pts: [a, [a[0], mid[1], a[2]], mid, [b[0], mid[1], b[2]], b] };
    });
    paths.forEach(p => { for (let i = 0; i < p.pts.length - 1; i++) add(p.pts[i], p.pts[i + 1], 0.9, p.lifted && i === p.pts.length - 2 ? 'harness-lifted' : 'harness'); });
    return { segs, paths };
  }

  function start(canvas) {
    const ctx = canvas.getContext('2d');
    const { segs, paths } = buildModel();
    const reduced = () => (window.RGUI ? window.RGUI.reducedMotion() : false);
    let w = 0, h = 0, dpr = 1, raf = 0, visible = true;
    const t0 = performance.now();
    let target = { x: 0, y: 0 }; const tilt = { x: 0, y: 0 };

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = rect.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!raf) frame(performance.now());
    }
    function project(x, y, z, rotY, rotX) {
      const cy = Math.cos(rotY), sy = Math.sin(rotY);
      let X = x * cy - z * sy, Z = x * sy + z * cy;
      const cx = Math.cos(rotX), sx = Math.sin(rotX);
      const Y = (y - 0.6) * cx - Z * sx; Z = (y - 0.6) * sx + Z * cx;
      const dist = 9, f = Math.min(w * 1.05, h * 1.9);
      const s = f / (dist + Z);
      return [w / 2 + X * s, h * 0.55 - Y * s, Z];
    }
    // Soulèvement de la caisse (vue éclatée).
    const lift = (p, e) => (p[1] > BELT - 0.001 ? [p[0], p[1] + e, p[2]] : p);

    function frame(now) {
      raf = 0;
      const t = reduced() ? 0 : Math.max(0, now - t0) / 1000;
      tilt.x += (target.x - tilt.x) * 0.06;
      tilt.y += (target.y - tilt.y) * 0.06;
      const rotY = -0.62 + Math.sin(t * 0.16) * 0.28 + tilt.x * 0.25;
      const rotX = 0.36 + tilt.y * 0.1;
      const explode = reduced() ? 0.42 : 0.34 + 0.12 * (0.5 - 0.5 * Math.cos(t * 0.45));
      const scanX = reduced() ? 99 : ((t * 0.55) % 6) - 3; // plan de scan le long du véhicule
      const ink = '#e9e6e1';
      const accent = css('--rg-yellow', '#efdf00');
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = 'round';

      for (const s of segs) {
        let a = s.a, b = s.b;
        if (s.kind === 'body' || s.kind === 'ecu-lifted' || s.kind === 'harness-lifted') { a = lift(a, explode); b = lift(b, explode); }
        const pa = project(a[0], a[1], a[2], rotY, rotX), pb = project(b[0], b[1], b[2], rotY, rotX);
        const depth = Math.max(0.18, Math.min(1, 0.78 - (pa[2] + pb[2]) * 0.08));
        const near = Math.abs((a[0] + b[0]) / 2 - scanX) < 0.18;
        let color = ink, alpha = depth * s.w * 0.55, width = 0.7;
        if (s.kind === 'grid') { alpha = 0.12; }
        else if (s.kind === 'wheel') { alpha = depth * 0.55; }
        else if (s.kind === 'chassis') { alpha = depth * 0.35; }
        else if (s.kind === 'pack') { color = '#7fd3ff'; alpha = depth * 0.45; }
        else if (s.kind.startsWith('ecu')) { color = accent; alpha = 0.9; width = 1.2; }
        else if (s.kind.startsWith('harness')) { color = accent; alpha = 0.32; width = 1; }
        if (near && s.kind !== 'grid') { alpha = Math.min(1, alpha + 0.35); }
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
      }
      // Liens pointillés entre la caisse soulevée et le soubassement (lecture « éclatée »).
      ctx.setLineDash([2, 4]);
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = ink;
      [[-1.55, -0.86], [-1.55, 0.86], [1.85, -0.82], [1.85, 0.82]].forEach(([x, z]) => {
        const p = project(x, BELT, z, rotY, rotX), q = project(x, BELT + explode, z, rotY, rotX);
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      });
      ctx.setLineDash([]);

      // Plan de scan.
      if (scanX < 2.6 && scanX > -2.6) {
        const top = project(scanX, 1.45 + explode, 0, rotY, rotX), bottom = project(scanX, 0, 0, rotY, rotX);
        const g = ctx.createLinearGradient(top[0], top[1], bottom[0], bottom[1]);
        g.addColorStop(0, 'transparent'); g.addColorStop(0.5, 'rgba(239,223,0,.28)'); g.addColorStop(1, 'transparent');
        ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(bottom[0], bottom[1]); ctx.stroke();
      }

      // Halos des ECU et étiquettes.
      ctx.font = '600 9px Consolas, monospace';
      ECUS.forEach((e, i) => {
        const p = e.lifted ? lift(e.pos, explode) : e.pos;
        const pt = project(p[0], p[1], p[2], rotY, rotX);
        const pulse = reduced() ? 0.6 : 0.45 + 0.35 * Math.sin(t * 2.2 + i * 1.3);
        const g = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 22);
        g.addColorStop(0, `rgba(239,223,0,${0.28 * pulse})`); g.addColorStop(1, 'transparent');
        ctx.globalAlpha = 1; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 22, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.75; ctx.fillStyle = '#f4f2ef';
        ctx.fillText(e.id, pt[0] + 10, pt[1] - 9);
      });

      // Impulsions de courant le long du faisceau.
      paths.forEach((p, i) => {
        const pts = p.pts.map((q, k) => (p.lifted && k === p.pts.length - 1 ? lift(q, explode) : q));
        const lens = []; let total = 0;
        for (let k = 0; k < pts.length - 1; k++) { const d = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1], pts[k + 1][2] - pts[k][2]); lens.push(d); total += d; }
        for (let n = 0; n < 2; n++) {
          let u = ((((t * 0.42 + i * 0.17 + n * 0.5) % 1) + 1) % 1) * total;
          let k = 0; while (k < lens.length - 1 && u > lens[k]) { u -= lens[k]; k += 1; }
          const f = lens[k] ? Math.min(1, u / lens[k]) : 0;
          const a = pts[k], b = pts[k + 1];
          const pt = project(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, rotY, rotX);
          const g = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 12);
          g.addColorStop(0, accent); g.addColorStop(1, 'transparent');
          ctx.globalAlpha = 0.85; ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(pt[0], pt[1], 12, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1; ctx.fillStyle = '#fffbd0';
          ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.1, 0, Math.PI * 2); ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
      if (!reduced() && visible && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame); };
    new ResizeObserver(resize).observe(canvas);
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; kick(); }).observe(canvas);
    document.addEventListener('visibilitychange', kick);
    window.addEventListener('rg-themechange', () => frame(performance.now()));
    canvas.parentElement.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      target = { x: (e.clientX - r.left) / r.width * 2 - 1, y: (e.clientY - r.top) / r.height * 2 - 1 };
      if (reduced()) frame(performance.now());
    });
    resize();
  }

  function init() { document.querySelectorAll('canvas[data-rg-hero3d]').forEach(start); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
