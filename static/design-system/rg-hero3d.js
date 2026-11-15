/* Wattman — scène 3D d'accueil : Renault 5 E-Tech « en verre » (Canvas 2D,
   sans dépendance). Carrosserie en panneaux semi-transparents ombrés, vitrages
   teintés, roues pleines ; l'intérieur reste visible au travers : plancher,
   pack batterie, sièges, boîtiers ECU reliés par le faisceau.
   Silhouette d'après les proportions publiques du véhicule (L 3,92 m,
   empattement 2,54 m, H 1,50 m) : capot court, ceinture haute, ailes élargies,
   phares ronds, écope de capot, hayon vertical, becquet. Aucun logo dessiné.
   - impulsions jaunes = courant 12 V circulant entre les ECU ;
   - rotation lente, parallaxe, reflet balayant la caisse ;
   - image fixe si mouvements réduits ; pause hors écran / onglet masqué. */
(function () {
  'use strict';

  // Repère : x = longueur (avant négatif), y = hauteur, z = largeur (mètres).
  const PROFILE = [ // [x, haut, demi-largeur]
    [-1.96, 0.60, 0.72], [-1.91, 0.72, 0.80], [-1.72, 0.80, 0.86], [-1.45, 0.84, 0.89],
    [-1.10, 0.87, 0.89], [-0.86, 0.90, 0.88], [-0.70, 0.99, 0.87], [-0.40, 1.30, 0.83],
    [-0.12, 1.46, 0.81], [0.45, 1.49, 0.81], [1.05, 1.48, 0.83], [1.48, 1.45, 0.87],
    [1.70, 1.30, 0.89], [1.84, 1.04, 0.89], [1.93, 0.84, 0.86], [1.97, 0.62, 0.78]
  ];
  const BELT = 0.98, SILL = 0.20;
  const WHEELS = [[-1.27, -0.80], [-1.27, 0.80], [1.27, -0.80], [1.27, 0.80]];
  const WR = 0.35;
  const ECUS = [
    { pos: [-1.52, 0.56, 0.42], size: [0.26, 0.18, 0.20] },
    { pos: [-1.50, 0.62, -0.36], size: [0.24, 0.10, 0.18] },
    { pos: [-0.56, 0.72, 0.00], size: [0.18, 0.07, 0.14] },
    { pos: [-0.62, 0.68, 0.56], size: [0.20, 0.07, 0.14] },
    { pos: [-0.72, 0.76, -0.48], size: [0.22, 0.09, 0.16] },
    { pos: [0.20, 0.32, 0.00], size: [0.26, 0.07, 0.20] },
    { pos: [-0.30, 1.34, 0.00], size: [0.16, 0.05, 0.12] },
    { pos: [1.50, 0.80, 0.46], size: [0.18, 0.07, 0.14] }
  ];
  const HARNESS = [[0, 1], [0, 2], [2, 3], [2, 4], [2, 5], [2, 6], [5, 7]];

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = v => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  // Section transversale à 10 points : bas de caisse → flanc → ceinture → épaule → pavillon (et symétrique).
  function section([x, top, half]) {
    const flare = WHEELS.some(([wx]) => Math.abs(x - wx) < 0.5) ? 0.03 : 0; // ailes élargies
    const h = half + flare;
    const greenhouse = top > BELT + 0.03;
    const shoulderY = greenhouse ? BELT + 0.05 : top;
    const roofY = greenhouse ? top : top + 0.005;
    const side = s => [
      [x, SILL, s * h * 0.93], [x, 0.48, s * h], [x, Math.min(BELT, top - 0.02), s * h * 0.99],
      [x, shoulderY, s * h * (greenhouse ? 0.9 : 0.9)], [x, roofY, s * h * (greenhouse ? 0.74 : 0.62)]
    ];
    const left = side(-1), right = side(1).reverse();
    return { pts: [...left, ...right], greenhouse };
  }

  function buildModel() {
    const sections = PROFILE.map(section);
    const panels = []; // { pts, kind }
    for (let i = 1; i < sections.length; i++) {
      const a = sections[i - 1], b = sections[i];
      for (let k = 0; k < 9; k++) {
        const glass = (k === 3 || k === 5) && a.greenhouse && b.greenhouse; // vitres latérales
        const roof = k === 4;
        const windscreen = roof && (!a.greenhouse || !b.greenhouse);
        const clad = k === 0 || k === 8; // protections noires de bas de caisse (signature R5)
        panels.push({ pts: [a.pts[k], b.pts[k], b.pts[k + 1], a.pts[k + 1]], kind: windscreen ? 'glass' : glass ? 'glass' : roof && a.greenhouse ? 'roof' : clad ? 'clad' : 'body' });
      }
    }
    // Boucliers avant / arrière (éventail).
    [sections[0], sections[sections.length - 1]].forEach(s => {
      for (let k = 1; k < 9; k++) panels.push({ pts: [s.pts[0], s.pts[k], s.pts[k + 1]], kind: 'body' });
    });
    // Arêtes vives (lignes de caractère).
    const edges = [];
    for (let k = 0; k < 10; k++) edges.push({ pts: sections.map(s => s.pts[k]), w: k === 2 || k === 7 ? 1.1 : k === 4 || k === 5 ? 0.9 : 0.5 });
    [0, sections.length - 1].forEach(i => edges.push({ pts: [...sections[i].pts, sections[i].pts[0]], w: 0.9 }));
    // Montants de vitrage.
    [6, 9, 12].forEach(i => { const s = sections[i]; edges.push({ pts: [s.pts[2], s.pts[3], s.pts[4]], w: 0.9 }); edges.push({ pts: [s.pts[7], s.pts[6], s.pts[5]], w: 0.9 }); });
    // Becquet, écope de capot, phares ronds, feux arrière.
    const details = [];
    details.push({ pts: [[1.50, 1.47, -0.66], [1.50, 1.47, 0.66], [1.62, 1.42, 0.66], [1.62, 1.42, -0.66], [1.50, 1.47, -0.66]], w: 1.2 });
    details.push({ pts: [[-1.42, 0.86, 0.08], [-1.22, 0.875, 0.08], [-1.22, 0.875, 0.30], [-1.42, 0.86, 0.30], [-1.42, 0.86, 0.08]], w: 1.1 });
    const circle = (cx, cy, z, r, n) => Array.from({ length: n + 1 }, (_, k) => { const a = (k / n) * Math.PI * 2; return [cx, cy + Math.sin(a) * r, z + Math.cos(a) * r]; });
    const lights = [];
    [-0.52, 0.52].forEach(z => lights.push({ pts: circle(-1.945, 0.70, z, 0.085, 18), kind: 'head' }));
    [-0.66, 0.66].forEach(z => lights.push({ pts: [[1.94, 0.82, z - 0.05], [1.94, 0.82, z + 0.05], [1.93, 1.0, z + 0.05], [1.93, 1.0, z - 0.05]], kind: 'tail' }));
    // Intérieur.
    const interior = [];
    const rect = (x0, x1, y, z0, z1) => [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [x0, y, z0]];
    interior.push({ pts: rect(-0.95, 1.15, 0.28, -0.72, 0.72), kind: 'floor' });
    interior.push({ pts: rect(-0.85, 0.95, 0.22, -0.62, 0.62), kind: 'pack' });
    for (let i = 1; i < 7; i++) { const x = -0.85 + i * 0.257; interior.push({ pts: [[x, 0.22, -0.62], [x, 0.22, 0.62]], kind: 'pack' }); }
    const seat = (x, z) => {
      interior.push({ pts: [[x, 0.42, z - 0.19], [x, 0.42, z + 0.19], [x - 0.3, 0.42, z + 0.19], [x - 0.3, 0.42, z - 0.19], [x, 0.42, z - 0.19]], kind: 'seat' });
      interior.push({ pts: [[x, 0.42, z - 0.18], [x + 0.08, 0.92, z - 0.16], [x + 0.08, 0.92, z + 0.16], [x, 0.42, z + 0.18]], kind: 'seat' });
    };
    seat(0.0, -0.36); seat(0.0, 0.36); seat(0.95, -0.36); seat(0.95, 0.36);
    interior.push({ pts: circle(-0.55, 1.02, 0.36, 0.17, 20).map(p => [p[0] + (p[1] - 1.02) * 0.4, p[1], p[2]]), kind: 'seat' }); // volant
    // ECU (boîtes) et faisceau.
    const boxes = ECUS.map(e => {
      const [x, y, z] = e.pos, [w, h, d] = e.size.map(v => v / 2);
      return [[x - w, y - h, z - d], [x + w, y - h, z - d], [x + w, y - h, z + d], [x - w, y - h, z + d],
        [x - w, y + h, z - d], [x + w, y + h, z - d], [x + w, y + h, z + d], [x - w, y + h, z + d]];
    });
    const paths = HARNESS.map(([i, j]) => {
      const a = ECUS[i].pos, b = ECUS[j].pos, y = Math.min(a[1], b[1], 0.5);
      return [a, [a[0], y, a[2]], [b[0], y, a[2]], [b[0], y, b[2]], b];
    });
    return { panels, edges, details, lights, interior, boxes, paths };
  }

  function start(canvas) {
    const ctx = canvas.getContext('2d');
    const model = buildModel();
    const reduced = () => (window.RGUI ? window.RGUI.reducedMotion() : false);
    let w = 0, h = 0, dpr = 1, raf = 0, visible = true;
    const t0 = performance.now();
    let target = { x: 0, y: 0 }; const tilt = { x: 0, y: 0 };
    const LIGHT = norm([-0.4, 0.9, -0.5]);

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = rect.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!raf) frame(performance.now());
    }

    function frame(now) {
      raf = 0;
      const t = reduced() ? 0 : Math.max(0, now - t0) / 1000;
      tilt.x += (target.x - tilt.x) * 0.06;
      tilt.y += (target.y - tilt.y) * 0.06;
      const rotY = 0.62 + Math.sin(t * 0.16) * 0.3 + tilt.x * 0.25; // 3/4 avant
      const rotX = 0.38 + tilt.y * 0.08;
      const cy = Math.cos(rotY), sy = Math.sin(rotY), cx = Math.cos(rotX), sx = Math.sin(rotX);
      const dist = 7.6, f = Math.min(w * 1.2, h * 2.15);
      const view = p => { // repère caméra
        const X = p[0] * cy - p[2] * sy, Z0 = p[0] * sy + p[2] * cy;
        const Y = (p[1] - 0.66) * cx + Z0 * sx, Z = -(p[1] - 0.66) * sx + Z0 * cx; // caméra au-dessus
        return [X, Y, Z];
      };
      const proj = p => { const v = view(p); const s = f / (dist + v[2]); return [w / 2 + v[0] * s, h * 0.5 - v[1] * s, v[2]]; };
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--rg-yellow').trim() || '#efdf00';
      const sheen = reduced() ? -9 : ((t * 0.35) % 4) - 2; // reflet balayant
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      // Sol : ombre douce + grille.
      const c0 = proj([0, 0, 0]);
      const shadow = ctx.createRadialGradient(c0[0], c0[1], 0, c0[0], c0[1], w * 0.32);
      shadow.addColorStop(0, 'rgba(0,0,0,.55)'); shadow.addColorStop(1, 'transparent');
      ctx.fillStyle = shadow; ctx.beginPath(); ctx.ellipse(c0[0], c0[1], w * 0.32, h * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#e9e6e1'; ctx.lineWidth = 0.6; ctx.globalAlpha = 0.07;
      for (let g = -5; g <= 5; g++) {
        let a = proj([g * 0.6, 0, -1.8]), b = proj([g * 0.6, 0, 1.8]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        a = proj([-3, 0, g * 0.36]); b = proj([3, 0, g * 0.36]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }

      // Panneaux : normale, orientation, profondeur.
      const camPos = [0, 0, -dist];
      const faces = model.panels.map(pn => {
        const vs = pn.pts.map(view);
        let n = norm(cross(sub(vs[1], vs[0]), sub(vs[vs.length - 1], vs[0])));
        const c = vs.reduce((acc, v) => [acc[0] + v[0] / vs.length, acc[1] + v[1] / vs.length, acc[2] + v[2] / vs.length], [0, 0, 0]);
        // Normale orientée vers l'extérieur de la caisse (centre approx. en 0, 0.75, 0).
        const out = sub(c, view([0, 0.75, 0]));
        if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) n = [-n[0], -n[1], -n[2]];
        const toCam = sub(camPos, c);
        const front = n[0] * toCam[0] + n[1] * toCam[1] + n[2] * toCam[2] > 0;
        const lightN = view([0, 0, 0]); // (non utilisé : éclairage dans le repère caméra)
        void lightN;
        const shade = 0.35 + 0.65 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
        const worldX = pn.pts.reduce((s, p) => s + p[0], 0) / pn.pts.length;
        return { pn, pts: pn.pts.map(proj), z: c[2], front, shade, worldX };
      }).sort((a, b) => b.z - a.z);

      const paint = (f) => {
        const glass = f.pn.kind === 'glass', roof = f.pn.kind === 'roof', clad = f.pn.kind === 'clad';
        const sh = f.shade + (Math.abs(f.worldX - sheen) < 0.25 ? 0.35 : 0);
        const base = glass ? [60, 85, 110] : roof || clad ? [34, 38, 46] : [150, 178, 205];
        const alpha = glass ? (f.front ? 0.2 : 0.28) : roof ? (f.front ? 0.5 : 0.55) : clad ? (f.front ? 0.55 : 0.35) : (f.front ? 0.2 : 0.3);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `rgb(${Math.round(base[0] * sh)},${Math.round(base[1] * sh)},${Math.round(base[2] * sh)})`;
        ctx.beginPath(); ctx.moveTo(f.pts[0][0], f.pts[0][1]);
        for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i][0], f.pts[i][1]);
        ctx.closePath(); ctx.fill();
      };
      const wheel = ([x, z], near) => {
        const pts = Array.from({ length: 28 }, (_, k) => { const a = (k / 28) * Math.PI * 2; return proj([x + Math.cos(a) * WR, 0.35 + Math.sin(a) * WR, z]); });
        ctx.globalAlpha = near ? 0.92 : 0.28; ctx.fillStyle = '#0d0f12';
        ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill();
        const rim = Array.from({ length: 24 }, (_, k) => { const a = (k / 24) * Math.PI * 2; return proj([x + Math.cos(a) * WR * 0.68, 0.35 + Math.sin(a) * WR * 0.68, z + Math.sign(z) * 0.02]); });
        ctx.globalAlpha = near ? 0.9 : 0.25; ctx.strokeStyle = '#d6cfa0'; ctx.lineWidth = 1.2;
        ctx.beginPath(); rim.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
        const hub = proj([x, 0.35, z + Math.sign(z) * 0.02]);
        for (let k = 0; k < 10; k++) { const p = rim[Math.round(k * 2.4) % 24]; ctx.beginPath(); ctx.moveTo(hub[0], hub[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); }
      };
      const nearSide = view([0, 0.35, 1])[2] < view([0, 0.35, -1])[2] ? 1 : -1;

      // 1) Faces arrière + roues éloignées.
      WHEELS.filter(([, z]) => Math.sign(z) !== nearSide).forEach(wh => wheel(wh, false));
      faces.filter(f => !f.front).forEach(paint);

      // 2) Intérieur visible au travers.
      const line = (pts, color, alpha, width) => {
        const ps = pts.map(proj); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.beginPath(); ps.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
      };
      model.interior.forEach(it => line(it.pts, it.kind === 'pack' ? '#7fd3ff' : '#e9e6e1', it.kind === 'pack' ? 0.45 : it.kind === 'floor' ? 0.22 : 0.4, 0.8));
      model.paths.forEach(p => line(p, accent, 0.4, 1.1));
      model.boxes.forEach(c => {
        const p = c.map(proj);
        ctx.globalAlpha = 0.28; ctx.fillStyle = accent;
        ctx.beginPath(); [4, 5, 6, 7].forEach((i, k) => (k ? ctx.lineTo(p[i][0], p[i][1]) : ctx.moveTo(p[i][0], p[i][1]))); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 0.95; ctx.strokeStyle = accent; ctx.lineWidth = 1.2;
        [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([i, j]) => { ctx.beginPath(); ctx.moveTo(p[i][0], p[i][1]); ctx.lineTo(p[j][0], p[j][1]); ctx.stroke(); });
      });
      ECUS.forEach((e, i) => {
        const pt = proj(e.pos);
        const pulse = reduced() ? 0.6 : 0.45 + 0.35 * Math.sin(t * 2.2 + i * 1.3);
        const g = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 24);
        g.addColorStop(0, `rgba(239,223,0,${0.32 * pulse})`); g.addColorStop(1, 'transparent');
        ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(pt[0], pt[1], 24, 0, Math.PI * 2); ctx.fill();
      });
      model.paths.forEach((pts, i) => {
        const lens = []; let total = 0;
        for (let k = 0; k < pts.length - 1; k++) { const d = Math.hypot(...sub(pts[k + 1], pts[k])); lens.push(d); total += d; }
        for (let n = 0; n < 2; n++) {
          let u = ((((t * 0.42 + i * 0.17 + n * 0.5) % 1) + 1) % 1) * total;
          let k = 0; while (k < lens.length - 1 && u > lens[k]) { u -= lens[k]; k += 1; }
          const fr = lens[k] ? Math.min(1, u / lens[k]) : 0;
          const a = pts[k], b = pts[k + 1];
          const pt = proj([a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr, a[2] + (b[2] - a[2]) * fr]);
          const g = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 12);
          g.addColorStop(0, accent); g.addColorStop(1, 'transparent');
          ctx.globalAlpha = 0.85; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(pt[0], pt[1], 12, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1; ctx.fillStyle = '#fffbd0'; ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.1, 0, Math.PI * 2); ctx.fill();
        }
      });

      // 3) Faces avant translucides + roues proches.
      faces.filter(f => f.front).forEach(paint);
      WHEELS.filter(([, z]) => Math.sign(z) === nearSide).forEach(wh => wheel(wh, true));

      // Élargisseurs d'ailes noirs autour des roues visibles.
      WHEELS.filter(([, z]) => Math.sign(z) === nearSide).forEach(([x, z]) => {
        const arch = Array.from({ length: 19 }, (_, k) => { const a = Math.PI * (k / 18); return [x + Math.cos(a) * 0.47, 0.35 + Math.sin(a) * 0.45, z * 1.14]; });
        line(arch, '#1b1e23', 0.9, 5);
        line(arch, '#f2f6ff', 0.35, 0.8);
      });
      // 4) Arêtes brillantes, détails, optiques.
      model.edges.forEach(e => line(e.pts, '#f2f6ff', 0.32 * e.w, 0.8));
      model.details.forEach(d => line(d.pts, '#f2f6ff', 0.75, d.w));
      model.lights.forEach(l => {
        const ps = l.pts.map(proj);
        ctx.globalAlpha = l.kind === 'head' ? 0.9 : 0.7;
        ctx.fillStyle = l.kind === 'head' ? 'rgba(255,250,215,.85)' : 'rgba(255,90,80,.7)';
        ctx.beginPath(); ps.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill();
        if (l.kind === 'head') {
          const c = ps.reduce((a, p) => [a[0] + p[0] / ps.length, a[1] + p[1] / ps.length], [0, 0]);
          const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], 26);
          g.addColorStop(0, 'rgba(255,248,200,.5)'); g.addColorStop(1, 'transparent');
          ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c[0], c[1], 26, 0, Math.PI * 2); ctx.fill();
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
