/* Application Course — historique */
(function () {
  'use strict';
  const C = window.Course;
  mapboxgl.accessToken = C.CONFIG.MAPBOX_TOKEN;

  const $ = (id) => document.getElementById(id);
  const runsEl = $('runs');
  const detailEl = $('detail');

  let runs = [];
  let current = null;
  let detailMap = null;
  let detailMapReady = false;
  let pendingRun = null;

  // ---------------------------------------------------------------- Chargement
  async function load() {
    try { await C.migrateLegacy(); } catch (e) { console.warn('Migration :', e); }
    try {
      runs = await C.DB.getAll();
    } catch (e) {
      runsEl.innerHTML = '<p class="empty">Impossible de lire l\'historique sur ce navigateur.</p>';
      return;
    }
    runs.sort((a, b) => b.startedAt - a.startedAt);
    renderTotals();
    renderList();
    openFromHash();
  }

  function metrics(run) {
    const sp = C.avgSpeed(run.distance, run.duration);
    return {
      km: C.formatKm(run.distance),
      duration: C.formatDuration(run.duration),
      pace: run.distance >= 50 ? C.formatPace(C.paceSecPerKm(sp)) : '--:--',
      speed: (sp * 3.6).toFixed(1),
      gain: Math.round(run.gain || 0),
      loss: Math.round(run.loss || 0),
      effort: C.kmEffort(run.distance, run.gain).toFixed(2),
      effortH: C.kmEffortPerHour(run.distance, run.gain, run.duration).toFixed(2),
    };
  }

  // ---------------------------------------------------------------- Totaux
  function renderTotals() {
    const box = $('totals');
    if (!runs.length) { box.hidden = true; return; }
    const dist = runs.reduce((s, r) => s + (r.distance || 0), 0);
    const ms = runs.reduce((s, r) => s + (r.duration || 0), 0);
    const gain = runs.reduce((s, r) => s + (r.gain || 0), 0);
    box.innerHTML = `
      <div class="total"><b class="num">${runs.length}</b><span>courses</span></div>
      <div class="total"><b class="num">${C.formatKm(dist, 1)}</b><span>km</span></div>
      <div class="total"><b class="num">${C.formatDuration(ms)}</b><span>temps</span></div>
      <div class="total"><b class="num">${Math.round(gain)}</b><span>m D+</span></div>`;
    box.hidden = false;
  }

  // ---------------------------------------------------------------- Liste
  function renderList() {
    if (!runs.length) {
      runsEl.innerHTML = '<p class="empty">Aucune course enregistrée pour l\'instant.</p>';
      return;
    }
    runsEl.innerHTML = runs.map((run) => {
      const m = metrics(run);
      return `
      <article class="run-card" data-id="${run.id}">
        <button class="run-thumb" type="button" data-action="open" aria-label="Voir le détail">${thumbHTML(run)}</button>
        <div class="run-body">
          <h2>${C.formatDate(run.startedAt)}${run.migrated ? '<span class="run-tag">ancienne version</span>' : ''}</h2>
          <div class="run-stats num">
            <div><b>${m.km}</b><span>km</span></div>
            <div><b>${m.duration}</b><span>durée</span></div>
            <div><b>${m.pace}</b><span>/km</span></div>
            <div><b>${m.gain}</b><span>m D+</span></div>
            <div><b>${m.effortH}</b><span>km-effort/h</span></div>
          </div>
          <div class="run-actions">
            <button class="btn btn-small" type="button" data-action="open">Détail</button>
            <button class="btn btn-small" type="button" data-action="gpx">GPX</button>
            <button class="btn btn-small btn-danger" type="button" data-action="delete">Supprimer</button>
          </div>
        </div>
      </article>`;
    }).join('');
  }

  runsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.run-card');
    const run = runs.find((r) => r.id === Number(card.dataset.id));
    if (!run) return;
    if (btn.dataset.action === 'open') openDetail(run, true);
    else if (btn.dataset.action === 'gpx') exportGPX(run);
    else if (btn.dataset.action === 'delete') deleteRun(run);
  });

  // Image statique indisponible (hors ligne…) → tracé dessiné localement
  runsEl.addEventListener('error', (e) => {
    if (e.target.tagName !== 'IMG') return;
    const card = e.target.closest('.run-card');
    const run = card && runs.find((r) => r.id === Number(card.dataset.id));
    if (run) e.target.outerHTML = trackSVG(run);
  }, true);

  // ---------------------------------------------------------------- Vignettes
  /** Une image statique par course au lieu d'une carte WebGL par course
   *  (les navigateurs limitent le nombre de cartes WebGL simultanées). */
  function thumbHTML(run) {
    const pts = C.segmentsOf(run).flat();
    if (pts.length < 2) return '<div class="thumb-empty">Pas de tracé</div>';
    let tol = 3, enc;
    do {
      enc = encodeURIComponent(C.encodePolyline(C.simplify(pts, tol)));
      tol *= 2;
    } while (enc.length > 6000 && tol < 10000); // l'URL doit rester < 8 192 caractères
    const url = `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/path-4+00aaff-0.95(${enc})/auto/600x300@2x?padding=30&access_token=${C.CONFIG.MAPBOX_TOKEN}`;
    return `<img src="${url}" loading="lazy" alt="Tracé de la course" width="600" height="300">`;
  }

  function trackSVG(run) {
    const pts = C.simplify(C.segmentsOf(run).flat(), 3);
    if (pts.length < 2) return '<div class="thumb-empty">Pas de tracé</div>';
    const kx = Math.cos(pts[0].lat * Math.PI / 180);
    const xs = pts.map((p) => p.lng * kx), ys = pts.map((p) => -p.lat);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = 600, H = 300, P = 24;
    const s = Math.min((W - 2 * P) / ((maxX - minX) || 1e-9), (H - 2 * P) / ((maxY - minY) || 1e-9));
    const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
    const d = xs.map((x, i) => `${((x - minX) * s + ox).toFixed(1)},${((ys[i] - minY) * s + oy).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Tracé de la course">` +
      `<polyline points="${d}" fill="none" stroke="#00aaff" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  // ---------------------------------------------------------------- Actions
  async function deleteRun(run) {
    if (!confirm('Supprimer définitivement cette course ?')) return false;
    try {
      await C.DB.delete(run.id);
    } catch (e) {
      alert('Suppression impossible : ' + e.message);
      return false;
    }
    runs = runs.filter((r) => r.id !== run.id);
    renderTotals();
    renderList();
    return true;
  }

  async function exportGPX(run) {
    const name = `course_${C.fileStamp(run.startedAt)}.gpx`;
    const file = new File([C.toGPX(run)], name, { type: 'application/gpx+xml' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Ma course' });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // partage annulé par l'utilisateur
      }
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------- Détail
  function openDetail(run, push) {
    current = run;
    const m = metrics(run);
    $('detail-title').textContent = C.formatDate(run.startedAt);
    $('detail-stats').innerHTML = [
      ['Distance', m.km + ' km'], ['Durée', m.duration], ['Allure moy.', m.pace + ' /km'],
      ['Vitesse moy.', m.speed + ' km/h'], ['D+', m.gain + ' m'], ['D-', m.loss + ' m'],
      ['Km-effort', m.effort], ['Km-effort/h', m.effortH],
    ].map(([l, v]) => `<div class="stat"><span class="v num">${v}</span><span class="l">${l}</span></div>`).join('');
    renderSplits(run);

    detailEl.hidden = false;
    detailEl.scrollTop = 0;
    document.body.classList.add('no-scroll');
    if (push) history.pushState({ detail: run.id }, '', '#' + run.id);

    requestAnimationFrame(() => {
      drawProfile(run);
      showOnMap(run);
    });
  }

  function hideDetail() {
    detailEl.hidden = true;
    document.body.classList.remove('no-scroll');
    current = null;
  }

  function closeDetail() {
    if (history.state && history.state.detail) history.back(); // popstate ferme le détail
    else {
      hideDetail();
      history.replaceState(null, '', location.pathname);
    }
  }

  function openFromHash() {
    const id = Number(location.hash.slice(1));
    const run = id && runs.find((r) => r.id === id);
    if (run) openDetail(run, false);
    else if (!detailEl.hidden) hideDetail();
  }

  window.addEventListener('popstate', openFromHash); // bouton « retour » Android
  $('detail-close').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !detailEl.hidden) closeDetail(); });
  $('detail-gpx').addEventListener('click', () => { if (current) exportGPX(current); });
  $('detail-delete').addEventListener('click', async () => {
    if (current && await deleteRun(current)) closeDetail();
  });
  $('btn-back').addEventListener('click', () => { location.href = 'index.html'; });
  window.addEventListener('resize', () => { if (current) drawProfile(current); });

  // ---------------------------------------------------------------- Carte du détail
  function showOnMap(run) {
    pendingRun = run;
    if (!detailMap) {
      detailMap = new mapboxgl.Map({
        container: 'detail-map',
        style: 'mapbox://styles/mapbox/outdoors-v12',
        center: C.CONFIG.DEFAULT_CENTER,
        zoom: 12,
      });
      detailMap.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
      detailMap.on('load', () => {
        detailMap.addSource('trace', { type: 'geojson', data: emptyFC() });
        detailMap.addLayer({
          id: 'trace', type: 'line', source: 'trace',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#00aaff', 'line-width': 5 },
        });
        detailMap.addSource('ends', { type: 'geojson', data: emptyFC() });
        detailMap.addLayer({
          id: 'ends', type: 'circle', source: 'ends',
          paint: {
            'circle-radius': 7,
            'circle-color': ['match', ['get', 'kind'], 'start', '#1fd37f', '#ff4d5e'],
            'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
          },
        });
        detailMapReady = true;
        if (pendingRun) drawOnMap(pendingRun);
      });
    } else {
      detailMap.resize();
      if (detailMapReady) drawOnMap(run);
    }
  }

  const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

  function drawOnMap(run) {
    const segs = C.segmentsOf(run).filter((s) => s.length);
    const all = segs.flat();
    detailMap.getSource('trace').setData({
      type: 'Feature', properties: {},
      geometry: { type: 'MultiLineString', coordinates: segs.filter((s) => s.length > 1).map((s) => s.map((p) => [p.lng, p.lat])) },
    });
    const ends = emptyFC();
    if (all.length) {
      const a = all[0], b = all[all.length - 1];
      ends.features.push(
        { type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: [a.lng, a.lat] } },
        { type: 'Feature', properties: { kind: 'end' }, geometry: { type: 'Point', coordinates: [b.lng, b.lat] } });
    }
    detailMap.getSource('ends').setData(ends);
    if (all.length > 1) {
      const bounds = all.reduce((bb, p) => bb.extend([p.lng, p.lat]), new mapboxgl.LngLatBounds([all[0].lng, all[0].lat], [all[0].lng, all[0].lat]));
      detailMap.fitBounds(bounds, { padding: 40, duration: 0, maxZoom: 17 });
    } else if (all.length === 1) {
      detailMap.jumpTo({ center: [all[0].lng, all[0].lat], zoom: 15 });
    }
  }

  // ---------------------------------------------------------------- Profil d'altitude
  function drawProfile(run) {
    const canvas = $('profile'), empty = $('profile-empty');
    const pts = C.segmentsOf(run).flat().filter((p) => Number.isFinite(p.ele) && Number.isFinite(p.d));
    if (pts.length < 2) { canvas.hidden = true; empty.hidden = false; return; }
    canvas.hidden = false;
    empty.hidden = true;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 44, padR = 8, padT = 10, padB = 22;
    let minE = Infinity, maxE = -Infinity;
    for (const p of pts) { if (p.ele < minE) minE = p.ele; if (p.ele > maxE) maxE = p.ele; }
    const realMin = minE, realMax = maxE;
    if (maxE - minE < 20) { const mid = (maxE + minE) / 2; minE = mid - 10; maxE = mid + 10; }
    const d0 = pts[0].d, dSpan = Math.max(1, pts[pts.length - 1].d - d0);
    const X = (d) => padL + ((d - d0) / dSpan) * (w - padL - padR);
    const Y = (e) => padT + ((maxE - e) / (maxE - minE)) * (h - padT - padB);

    ctx.beginPath();
    ctx.moveTo(X(pts[0].d), h - padB);
    for (const p of pts) ctx.lineTo(X(p.d), Y(p.ele));
    ctx.lineTo(X(pts[pts.length - 1].d), h - padB);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, 'rgba(0,170,255,.55)');
    grad.addColorStop(1, 'rgba(0,170,255,.05)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.d), Y(p.ele)) : ctx.moveTo(X(p.d), Y(p.ele))));
    ctx.strokeStyle = '#0ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#7fb3ba';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(realMax) + ' m', padL - 6, Y(realMax));
    ctx.fillText(Math.round(realMin) + ' m', padL - 6, Y(realMin));
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText('0 km', padL, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(C.formatKm(pts[pts.length - 1].d, 1) + ' km', w - padR, h - 6);
  }

  // ---------------------------------------------------------------- Splits
  function renderSplits(run) {
    const section = $('splits-section'), body = $('splits-body');
    const rows = (run.splits || []).map((s) => ({ label: String(s.km), dist: 1000, ms: s.ms, gain: s.gain }));
    if (run.partial && run.partial.distance > 0) {
      rows.push({ label: (run.partial.distance / 1000).toFixed(2), dist: run.partial.distance, ms: run.partial.ms, gain: run.partial.gain, partial: true });
    }
    if (!rows.length) { section.hidden = true; return; }
    section.hidden = false;

    const paces = rows.map((r) => (r.ms / 1000) / (r.dist / 1000)); // s/km
    const full = rows.map((r, i) => (r.partial ? Infinity : paces[i]));
    const best = Math.min(...full);
    const fastestSpeed = 1 / Math.min(...paces);
    body.innerHTML = rows.map((r, i) => {
      const width = Math.max(4, Math.round((1 / paces[i]) / fastestSpeed * 100));
      const cls = r.partial ? 'partial' : (paces[i] === best && rows.length > 1 ? 'fast' : '');
      return `<tr class="${cls}"><td class="num">${r.label}</td><td class="num">${C.formatPace(paces[i])}</td>` +
        `<td class="barcell"><div class="bar" style="width:${width}%"></div></td>` +
        `<td class="num">${Number.isFinite(r.gain) ? r.gain + ' m' : '—'}</td></tr>`;
    }).join('');
  }

  load();
  C.requestPersistentStorage();
})();
