/* Application Course — écran de course */
(function () {
  'use strict';
  const C = window.Course;
  mapboxgl.accessToken = C.CONFIG.MAPBOX_TOKEN;

  // ---------------------------------------------------------------- DOM
  const $ = (id) => document.getElementById(id);
  const el = {
    gps: $('gps-badge'), geoloc: $('btn-geoloc'), sound: $('btn-sound'), styleSelect: $('style-select'),
    chrono: $('chrono'), dist: $('s-dist'), pace: $('s-pace'), avgPace: $('s-avgpace'),
    speed: $('s-speed'), gain: $('s-gain'), effort: $('s-effort'),
    start: $('btn-start'), pause: $('btn-pause'), stop: $('btn-stop'), history: $('btn-historique'),
    toast: $('toast'),
  };

  // ---------------------------------------------------------------- État
  let tracker = new C.RunTracker();
  let lastFix = null;
  let follow = true;
  let firstFix = true;
  let userMarker = null;
  let wakeLock = null;
  let lastSaveAt = 0;
  let hiddenAt = null;
  let announcedKm = 0;
  let soundOn = C.Prefs.get('son', true);

  // ---------------------------------------------------------------- Carte
  const styleValues = Array.from(el.styleSelect.options).map((o) => o.value);
  let currentStyle = C.Prefs.get('style', C.CONFIG.DEFAULT_STYLE);
  if (!styleValues.includes(currentStyle)) currentStyle = C.CONFIG.DEFAULT_STYLE;
  el.styleSelect.value = currentStyle;

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/' + currentStyle,
    center: C.CONFIG.DEFAULT_CENTER,
    zoom: 13,
  });

  // Recréé à chaque changement de fond (setStyle efface sources et calques)
  map.on('style.load', () => {
    if (!map.getSource('mapbox-dem')) {
      map.addSource('mapbox-dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
    }
    map.setTerrain({ source: 'mapbox-dem', exaggeration: 1 }); // sert au calcul du dénivelé
    if (!map.getSource('trace')) map.addSource('trace', { type: 'geojson', data: traceGeoJSON() });
    if (!map.getLayer('trace')) {
      map.addLayer({
        id: 'trace', type: 'line', source: 'trace',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#00aaff', 'line-width': 5, 'line-opacity': 0.9 },
      });
    }
  });
  map.on('dragstart', () => setFollow(false));
  map.on('error', (e) => console.warn('Mapbox :', e && e.error ? e.error.message : e));

  function traceGeoJSON() {
    return {
      type: 'Feature', properties: {},
      geometry: {
        type: 'MultiLineString',
        coordinates: tracker.segments.filter((s) => s.length > 1).map((s) => s.map((p) => [p.lng, p.lat])),
      },
    };
  }
  function refreshTrace() {
    const src = map.getSource('trace');
    if (src) src.setData(traceGeoJSON());
  }

  /** Altitude du relief Mapbox (m), ou null si la tuile n'est pas chargée. */
  function demAt(fix) {
    try {
      const e = map.queryTerrainElevation([fix.lng, fix.lat], { exaggerated: false });
      return Number.isFinite(e) ? e : null;
    } catch (e) { return null; }
  }

  function updateMarker(fix) {
    const ll = [fix.lng, fix.lat];
    if (!userMarker) {
      const dot = document.createElement('div');
      dot.className = 'user-dot';
      userMarker = new mapboxgl.Marker({ element: dot }).setLngLat(ll).addTo(map);
    } else {
      userMarker.setLngLat(ll);
    }
  }

  function setFollow(v) {
    follow = v;
    el.geoloc.classList.toggle('active', v);
  }

  el.geoloc.addEventListener('click', () => {
    setFollow(true);
    if (lastFix) map.flyTo({ center: [lastFix.lng, lastFix.lat], zoom: Math.max(map.getZoom(), 15) });
    else toast('Recherche du signal GPS…');
  });

  el.styleSelect.addEventListener('change', () => {
    currentStyle = el.styleSelect.value;
    C.Prefs.set('style', currentStyle);
    map.setStyle('mapbox://styles/' + currentStyle, { diff: false }); // force « style.load »
  });

  // ---------------------------------------------------------------- GPS
  function startWatch() {
    if (!('geolocation' in navigator)) {
      setGps('bad', 'GPS indisponible');
      toast("La géolocalisation n'est pas supportée par ce navigateur.", 6000);
      return;
    }
    if (!window.isSecureContext) toast('La géolocalisation exige une page en HTTPS.', 6000);
    navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
    });
  }

  function onPosition(pos) {
    const c = pos.coords;
    const now = Date.now();
    let t = pos.timestamp;
    if (!Number.isFinite(t) || Math.abs(t - now) > 10000) t = now; // horloge GPS incohérente → heure locale
    const fix = {
      lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
      alt: c.altitude, altAccuracy: c.altitudeAccuracy, speed: c.speed, t,
    };
    lastFix = fix;
    updateGpsBadge(c.accuracy);
    updateMarker(fix);

    if (firstFix) {
      firstFix = false;
      map.flyTo({ center: [fix.lng, fix.lat], zoom: 16, duration: 1200 });
    } else if (follow) {
      map.easeTo({ center: [fix.lng, fix.lat], duration: 800 });
    }

    if (tracker.status === 'running') {
      fix.dem = demAt(fix);
      const p = tracker.addPosition(fix);
      if (p) {
        refreshTrace();
        if (now - lastSaveAt > 5000) saveNow();
        announceSplits();
      }
    }
  }

  function onGeoError(err) {
    if (err.code === 1) {
      setGps('bad', 'GPS refusé');
      toast('Autorise la localisation pour cette page dans les réglages du navigateur.', 7000);
    } else if (err.code === 3) {
      setGps('bad', 'GPS : recherche…');
    } else {
      setGps('bad', 'GPS indisponible');
    }
  }

  function setGps(level, text) {
    el.gps.dataset.level = level;
    el.gps.textContent = text;
  }
  function updateGpsBadge(acc) {
    const level = acc <= 10 ? 'good' : acc <= tracker.opts.maxAccuracy ? 'mid' : 'bad';
    setGps(level, `GPS ±${Math.round(acc)} m`);
  }

  // ---------------------------------------------------------------- Affichage
  function render() {
    const now = Date.now();
    const ms = tracker.activeTime(now);
    el.chrono.textContent = C.formatDuration(ms, true);
    el.dist.textContent = C.formatKm(tracker.distance);

    const cur = tracker.currentSpeed(now);
    el.pace.textContent = cur == null ? '--:--' : C.formatPace(C.paceSecPerKm(cur));

    const avg = C.avgSpeed(tracker.distance, ms);
    el.avgPace.textContent = tracker.distance >= 50 ? C.formatPace(C.paceSecPerKm(avg)) : '--:--';
    el.speed.textContent = (avg * 3.6).toFixed(1);
    el.gain.textContent = Math.round(tracker.gain);
    el.effort.textContent = C.kmEffortPerHour(tracker.distance, tracker.gain, ms).toFixed(2);
  }

  function applyState() {
    document.body.dataset.state = tracker.status;
    el.pause.textContent = tracker.status === 'paused' ? 'Reprendre' : 'Pause';
    el.stop.textContent = tracker.status === 'paused' ? 'Terminer' : 'Stop';
    render();
    requestAnimationFrame(() => map.resize()); // la carte change de hauteur quand les stats apparaissent
  }

  let toastTimer = null;
  function toast(msg, ms = 3500) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------------- Annonces vocales
  function speak(text) {
    if (!soundOn || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* facultatif */ }
  }
  function durationToSpeech(ms) {
    const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const parts = [];
    if (h) parts.push(`${h} heure${h > 1 ? 's' : ''}`);
    if (m) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
    if (s || !parts.length) parts.push(`${s} seconde${s > 1 ? 's' : ''}`);
    return parts.join(' ');
  }
  function paceToSpeech(sec) {
    const t = Math.round(sec), m = Math.floor(t / 60), s = t % 60;
    return `${m} minute${m > 1 ? 's' : ''}${s ? ' ' + s : ''}`;
  }
  function announceSplits() {
    while (announcedKm < tracker.splits.length) {
      const s = tracker.splits[announcedKm++];
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      toast(`Km ${s.km} — ${C.formatPace(s.ms / 1000)} /km`);
      speak(`Kilomètre ${s.km}. Temps ${durationToSpeech(tracker.activeTime(Date.now()))}. ` +
        `Allure ${paceToSpeech(s.ms / 1000)} au kilomètre.`);
    }
  }
  function renderSound() {
    el.sound.textContent = soundOn ? '🔊' : '🔇';
    el.sound.setAttribute('aria-pressed', String(soundOn));
  }
  el.sound.addEventListener('click', () => {
    soundOn = !soundOn;
    C.Prefs.set('son', soundOn);
    renderSound();
    speak('Annonces vocales activées');
  });

  // ---------------------------------------------------------------- Écran allumé
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* refusé (batterie faible…) */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  // ---------------------------------------------------------------- Sauvegarde continue
  function saveNow() {
    if (tracker.status !== 'running' && tracker.status !== 'paused') return;
    const now = Date.now();
    if (!C.InProgress.save(tracker.toState(now))) console.warn('Sauvegarde de la course en cours impossible');
    lastSaveAt = now;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveNow();
      hiddenAt = Date.now();
    } else {
      if (tracker.status === 'running') {
        requestWakeLock();
        if (hiddenAt && Date.now() - hiddenAt > 15000) {
          toast("Le GPS a pu être coupé pendant que l'écran était éteint : garde l'appli à l'écran pendant la course.", 7000);
        }
      }
      hiddenAt = null;
    }
  });
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', (e) => {
    if (tracker.status === 'running' || tracker.status === 'paused') {
      saveNow();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function restoreIfNeeded() {
    const s = C.InProgress.load();
    if (!s) return;
    let t;
    try { t = C.RunTracker.fromState(s); } catch (e) { C.InProgress.clear(); return; }
    const desc = `${C.formatKm(t.distance)} km en ${C.formatDuration(t.activeMs)}`;
    if (confirm(`Une course non terminée a été retrouvée (${desc}).\n\nLa reprendre ?`)) {
      tracker = t;
      announcedKm = t.splits.length;
      refreshTrace();
      applyState();
      toast('Course restaurée en pause. Appuie sur « Reprendre ».', 5000);
    } else if (confirm("L'enregistrer dans l'historique ?")) {
      t.stop(s.savedAt);
      C.DB.put(t.toRecord())
        .then(() => { C.InProgress.clear(); toast('Course enregistrée dans l’historique.'); })
        .catch((e) => toast("Échec de l'enregistrement : " + e.message, 6000));
    } else {
      C.InProgress.clear();
    }
  }

  // ---------------------------------------------------------------- Boutons
  el.start.addEventListener('click', () => {
    if (tracker.status !== 'idle') return;
    tracker.start(Date.now());
    announcedKm = 0;
    setFollow(true);
    applyState();
    requestWakeLock();
    speak('Course démarrée'); // débloque aussi la synthèse vocale sur mobile (geste utilisateur)
    if (!lastFix || lastFix.accuracy > tracker.opts.maxAccuracy) {
      toast("Signal GPS encore imprécis : la distance démarrera dès qu'il sera bon.", 5000);
    }
    saveNow();
  });

  el.pause.addEventListener('click', () => {
    const now = Date.now();
    if (tracker.status === 'running') {
      tracker.pause(now);
      speak('Pause');
    } else if (tracker.status === 'paused') {
      tracker.resume(now);
      requestWakeLock();
      speak('Reprise');
    }
    applyState();
    saveNow();
  });

  el.stop.addEventListener('click', async () => {
    if (!confirm('Terminer la course ?')) return;
    tracker.stop(Date.now());
    const rec = tracker.toRecord();

    if (rec.distance < C.CONFIG.MIN_SAVE_DISTANCE &&
        !confirm(`Course très courte (${Math.round(rec.distance)} m). L'enregistrer quand même ?`)) {
      C.InProgress.clear();
      releaseWakeLock();
      tracker = new C.RunTracker();
      refreshTrace();
      applyState();
      return;
    }

    try {
      await C.DB.put(rec);
    } catch (e) {
      // On ne perd rien : la course repasse en pause et reste sauvegardée.
      tracker.status = 'paused';
      tracker.endedAt = null;
      applyState();
      saveNow();
      alert("Impossible d'enregistrer la course (" + e.message + '). Elle est conservée, réessaie.');
      return;
    }
    C.InProgress.clear();
    releaseWakeLock();
    location.href = 'historique.html#' + rec.id;
  });

  el.history.addEventListener('click', () => { location.href = 'historique.html'; });

  // ---------------------------------------------------------------- Démarrage
  renderSound();
  applyState();
  restoreIfNeeded();
  startWatch();
  setInterval(render, 500); // l'affichage est recalculé depuis l'horloge : aucune dérive du chrono
  C.requestPersistentStorage();
})();
