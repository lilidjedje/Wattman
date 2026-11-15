/* Wattman — scène 3D d'accueil : module batterie 12 V filaire (création
   originale). Canvas 2D + projection perspective, sans dépendance.
   - rotation lente + parallaxe au pointeur ;
   - impulsions jaunes = flux de courant le long des busbars (illustratif) ;
   - image fixe si mouvements réduits ; pause hors écran / onglet masqué. */
(function () {
  'use strict';
  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function buildModel() {
    const segs = [];      // [x1,y1,z1,x2,y2,z2,weight]
    const add = (a, b, w = 1) => segs.push([...a, ...b, w]);
    const W = 2.6, D = 1.5, H = 0.9;           // demi-largeur / demi-profondeur / hauteur
    const c = [[-W, 0, -D], [W, 0, -D], [W, 0, D], [-W, 0, D]];
    const top = c.map(([x, , z]) => [x, H, z]);
    for (let i = 0; i < 4; i++) {
      add(c[i], c[(i + 1) % 4], 1.2);
      add(top[i], top[(i + 1) % 4], 1.2);
      add(c[i], top[i], 1.2);
    }
    // Cellules cylindriques 6 x 3
    const cells = [];
    const cols = 6, rows = 3, r = 0.3;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const cx = -W + (i + 0.5) * (2 * W / cols);
        const cz = -D + (j + 0.5) * (2 * D / rows);
        cells.push([cx, cz]);
        const n = 18;
        for (let k = 0; k < n; k++) {
          const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
          const p = a => [cx + Math.cos(a) * r, cz + Math.sin(a) * r];
          const [x0, z0] = p(a0), [x1, z1] = p(a1);
          add([x0, H + 0.02, z0], [x1, H + 0.02, z1], 0.55);
          if (k % 6 === 0) add([x0, 0.05, z0], [x0, H, z0], 0.25);
        }
      }
    }
    // Busbars (série) : serpentin sur le dessus
    const path = [];
    for (let j = 0; j < rows; j++) {
      const rowCells = cells.filter((_, idx) => idx % rows === j);
      const ordered = j % 2 === 0 ? rowCells : rowCells.slice().reverse();
      ordered.forEach(([x, z]) => path.push([x, H + 0.12, z]));
    }
    for (let i = 0; i < path.length - 1; i++) add(path[i], path[i + 1], 0.9);
    // Bornes
    const term = (x, z) => { add([x, H, z], [x, H + 0.45, z], 1.4); add([x - 0.12, H + 0.45, z], [x + 0.12, H + 0.45, z], 1.4); };
    term(path[0][0], path[0][2]);
    term(path[path.length - 1][0], path[path.length - 1][2]);
    // Plan de sol (grille d'atelier)
    for (let g = -4; g <= 4; g++) {
      add([g * 0.9, -0.02, -2.8], [g * 0.9, -0.02, 2.8], 0.18);
      add([-3.6, -0.02, g * 0.7], [3.6, -0.02, g * 0.7], 0.18);
    }
    return { segs, path };
  }

  function start(canvas) {
    const ctx = canvas.getContext('2d');
    const { segs, path } = buildModel();
    const reduced = () => (window.RGUI ? window.RGUI.reducedMotion() : false);
    let w = 0, h = 0, dpr = 1, raf = 0, visible = true, t0 = performance.now();
    let target = { x: 0, y: 0 }, tilt = { x: 0, y: 0 };

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
      const Y = (y - 0.45) * cx - Z * sx; Z = (y - 0.45) * sx + Z * cx;
      const dist = 8.5, f = Math.min(w, h * 1.6) * 0.95;
      const s = f / (dist + Z);
      return [w / 2 + X * s, h * 0.56 - Y * s, Z];
    }
    function frame(now) {
      raf = 0;
      const t = reduced() ? 0 : (now - t0) / 1000;
      tilt.x += (target.x - tilt.x) * 0.06;
      tilt.y += (target.y - tilt.y) * 0.06;
      const rotY = -0.55 + Math.sin(t * 0.18) * 0.35 + tilt.x * 0.25;
      const rotX = 0.42 + tilt.y * 0.12;
      const ink = css('--rg-ink', '#0b0c0e');
      const accent = css('--rg-yellow', '#efdf00');
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = 'round';
      for (const s of segs) {
        const a = project(s[0], s[1], s[2], rotY, rotX);
        const b = project(s[3], s[4], s[5], rotY, rotX);
        const depth = Math.max(0.15, Math.min(1, 0.75 - (a[2] + b[2]) * 0.09));
        ctx.globalAlpha = depth * Math.min(1, s[6]);
        ctx.strokeStyle = ink;
        ctx.lineWidth = 0.6 + s[6] * 0.55;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      // Impulsions de courant le long du serpentin
      const pulses = 4, len = path.length - 1;
      for (let k = 0; k < pulses; k++) {
        const u = ((t * 0.12 + k / pulses) % 1) * len;
        const i = Math.floor(u), f = u - i;
        const p = path[i], q = path[Math.min(i + 1, len)];
        const pt = project(p[0] + (q[0] - p[0]) * f, p[1], p[2] + (q[2] - p[2]) * f, rotY, rotX);
        const g = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 14);
        g.addColorStop(0, accent); g.addColorStop(1, 'transparent');
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 14, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.6, 0, Math.PI * 2); ctx.fill();
      }
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
