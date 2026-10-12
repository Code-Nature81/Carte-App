/*!
 * Application Course — noyau commun
 * Calculs (distance, allure, dénivelé, km-effort, splits), filtrage GPS,
 * stockage (IndexedDB + course en cours), export GPX.
 * Fonctionne dans le navigateur (window.Course) et dans Node (tests).
 */
(function (global) {
  'use strict';

  // =====================================================================
  // Configuration
  // =====================================================================
  const CONFIG = {
    MAPBOX_TOKEN: 'pk.eyJ1IjoiZ3ViaW5xIiwiYSI6ImNrbnlubnVwYjBsMjgyb3J4b3hqM2YwOGsifQ.KV-VZe4nIEMc7rhtHmM5BQ',
    DEFAULT_CENTER: [2.3522, 48.8566], // Paris
    DEFAULT_STYLE: 'mapbox/outdoors-v12',
    MIN_SAVE_DISTANCE: 50, // m — en dessous, on demande confirmation avant d'enregistrer
  };

  // =====================================================================
  // Géométrie
  // =====================================================================
  const EARTH_RADIUS = 6371008.8; // rayon terrestre moyen (m)
  const toRad = (d) => d * Math.PI / 180;

  /** Distance en mètres entre deux points {lat, lng} (formule de haversine). */
  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** Simplification Douglas-Peucker (tolérance en mètres), itérative. */
  function simplify(points, tolerance) {
    const n = points.length;
    if (n <= 2) return points.slice();
    const kx = Math.cos(toRad(points[0].lat)) * EARTH_RADIUS * Math.PI / 180;
    const ky = EARTH_RADIUS * Math.PI / 180;
    const xy = points.map((p) => [p.lng * kx, p.lat * ky]);
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const tol2 = tolerance * tolerance;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = first + 1; i < last; i++) {
        const d = segDist2(xy[i], xy[first], xy[last]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx !== -1 && maxD > tol2) {
        keep[idx] = 1;
        stack.push([first, idx], [idx, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  function segDist2(p, a, b) {
    let x = a[0], y = a[1];
    let dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  }

  /** Encodage « Google polyline » (utilisé par l'API Static Images de Mapbox). */
  function encodePolyline(points, precision = 5) {
    const f = 10 ** precision;
    let lastLat = 0, lastLng = 0, out = '';
    for (const p of points) {
      const lat = Math.round(p.lat * f), lng = Math.round(p.lng * f);
      out += encodeValue(lat - lastLat) + encodeValue(lng - lastLng);
      lastLat = lat; lastLng = lng;
    }
    return out;
  }
  function encodeValue(v) {
    v = v < 0 ? ~(v << 1) : (v << 1);
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  }

  // =====================================================================
  // Formats & métriques (une seule définition, utilisée partout)
  // =====================================================================
  const pad = (n) => String(n).padStart(2, '0');

  /** ms → "HH:MM:SS" (forceHours) ou "H:MM:SS" / "MM:SS". */
  function formatDuration(ms, forceHours = false) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (forceHours) return `${pad(h)}:${pad(m)}:${pad(s)}`;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  /** Vitesse (m/s) → allure (s/km). Null sous 1 km/h (pas d'allure significative). */
  function paceSecPerKm(speedMps) {
    return speedMps > 0.278 ? 1000 / speedMps : null;
  }

  /** s/km → "M:SS". "--:--" si invalide ou plus lent que 60 min/km. */
  function formatPace(sec) {
    if (!Number.isFinite(sec) || sec <= 0 || sec >= 3600) return '--:--';
    const t = Math.round(sec);
    return `${Math.floor(t / 60)}:${pad(t % 60)}`;
  }

  /** m → km tronqués (comme les montres : 4,999 km s'affiche 4.99, pas 5.00). */
  function formatKm(m, digits = 2) {
    const f = 10 ** digits;
    return (Math.floor(((m || 0) / 1000) * f + 1e-9) / f).toFixed(digits);
  }

  /** Vitesse moyenne en m/s. */
  function avgSpeed(distanceM, ms) {
    return ms > 0 ? distanceM / (ms / 1000) : 0;
  }

  /** Km-effort = km + D+ (m) / 100 (convention trail / ITRA). */
  function kmEffort(distanceM, gainM) {
    return (distanceM || 0) / 1000 + (gainM || 0) / 100;
  }

  /** Km-effort par heure. */
  function kmEffortPerHour(distanceM, gainM, ms) {
    const h = (ms || 0) / 3600000;
    return h > 0 ? kmEffort(distanceM, gainM) / h : 0;
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleString('fr-FR', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function fileStamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
  }

  // =====================================================================
  // Filtre de Kalman 1D sur lat/lng (bruit exprimé en mètres)
  // =====================================================================
  class KalmanLatLng {
    constructor(qMetresPerSecond) {
      this.q = qMetresPerSecond;
      this.variance = -1;
    }
    process(lat, lng, accuracy, tMs) {
      const acc = Math.max(1, accuracy);
      if (this.variance < 0) {
        this.lat = lat; this.lng = lng; this.t = tMs; this.variance = acc * acc;
      } else {
        const dt = tMs - this.t;
        if (dt > 0) { this.variance += dt * this.q * this.q / 1000; this.t = tMs; }
        const k = this.variance / (this.variance + acc * acc);
        this.lat += k * (lat - this.lat);
        this.lng += k * (lng - this.lng);
        this.variance *= (1 - k);
      }
      return { lat: this.lat, lng: this.lng };
    }
  }

  // =====================================================================
  // Moteur de suivi de course
  // =====================================================================
  const DEFAULTS = {
    maxAccuracy: 30,        // m — fix ignoré si moins précis
    maxSpeed: 12,           // m/s (~43 km/h) — au-delà (hors marge de précision) = saut GPS
    maxJumpRejects: 5,      // sauts consécutifs avant de considérer que c'est la référence qui était fausse
    kalmanQ: 3,             // m/s — agilité du filtre de Kalman
    minStep: 5,             // m — déplacement mini entre deux points retenus
    maxStep: 15,            // m — plafond du seuil adaptatif
    accuracyStepFactor: 1.5, // seuil = précision × facteur (borné entre minStep et maxStep)
    stillSpeed: 0.3,        // m/s — sous cette vitesse Doppler, on est considéré immobile
    stillWindow: 20000,     // ms — fenêtre de détection d'arrêt (dérive lente du GPS)
    stillAvgSpeed: 0.8,     // m/s — déplacement net moyen sur la fenêtre en dessous duquel on est à l'arrêt
    speedWindow: 30000,     // ms — fenêtre de l'allure instantanée (si pas de vitesse Doppler)
    dopplerTau: 6000,       // ms — constante de lissage de la vitesse Doppler
    eleSmoothing: 5,        // points — moyenne glissante de l'altitude
    eleThreshold: { dem: 2, gps: 5 }, // m — hystérésis du dénivelé selon la source
    maxAltAccuracy: 20,     // m — altitude GPS ignorée au-delà
    demWaitPoints: 10,      // points retenus à attendre le relief Mapbox avant de se rabattre sur le GPS
  };

  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const packPoint = (p) => [r6(p.lat), r6(p.lng), r1(p.ele), p.t, Number.isFinite(p.a) ? Math.round(p.a) : null, r1(p.d)];
  const unpackPoint = (a) => ({ lat: a[0], lng: a[1], ele: a[2], t: a[3], a: a[4], d: a[5] });

  class RunTracker {
    constructor(opts = {}) {
      this.opts = Object.assign({}, DEFAULTS, opts, {
        eleThreshold: Object.assign({}, DEFAULTS.eleThreshold, opts.eleThreshold || {}),
      });
      this.reset();
    }

    reset() {
      this.status = 'idle';          // idle | running | paused | stopped
      this.startedAt = null;
      this.endedAt = null;
      this.activeMs = 0;             // temps actif cumulé avant la portion en cours
      this.resumedAt = null;
      this.segments = [];            // une portion par démarrage/reprise : [[{lat,lng,ele,t,a,d}]]
      this.distance = 0;             // m
      this.gain = 0;                 // D+ (m)
      this.loss = 0;                 // D- (m)
      this.eleSource = null;         // 'dem' (relief Mapbox) | 'gps'
      this.splits = [];              // [{km, ms, gain}]
      this._splitStartA = 0;
      this._splitStartGain = 0;
      this.stats = { accepted: 0, rejectedAccuracy: 0, rejectedJump: 0, rejectedStill: 0 };
      this._resetFilters();
    }

    _resetFilters() {
      this._kalman = null;
      this._lastRaw = null;
      this._jumpRejects = 0;
      this._hist = [];
      this._doppler = null; // {v, t} vitesse Doppler lissée
      this._eleBuf = [];
      this._eleRef = null;
    }

    _newSegment() {
      const last = this.segments[this.segments.length - 1];
      if (!last || last.length > 0) this.segments.push([]);
      this._resetFilters();
    }

    /** Temps actif (pauses exclues) à l'instant `now`. */
    activeTime(now) {
      return this.activeMs + (this.status === 'running' ? Math.max(0, now - this.resumedAt) : 0);
    }

    start(now) {
      if (this.status !== 'idle') return;
      this.status = 'running';
      this.startedAt = now;
      this.resumedAt = now;
      this._newSegment();
    }

    pause(now) {
      if (this.status !== 'running') return;
      this.activeMs += Math.max(0, now - this.resumedAt);
      this.resumedAt = null;
      this.status = 'paused';
    }

    resume(now) {
      if (this.status !== 'paused') return;
      this.status = 'running';
      this.resumedAt = now;
      this._newSegment(); // pas de distance comptée entre l'endroit de la pause et celui de la reprise
    }

    stop(now) {
      if (this.status === 'running') this.pause(now);
      if (this.status !== 'paused') return;
      this.status = 'stopped';
      this.endedAt = now;
    }

    /**
     * Ajoute un fix GPS. fix = {lat, lng, accuracy, alt, altAccuracy, speed, dem, t}
     * Retourne le point retenu, ou null s'il a été filtré.
     */
    addPosition(fix) {
      if (this.status !== 'running' || !fix) return null;
      const o = this.opts;
      if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) || !Number.isFinite(fix.t)) return null;
      if (!(fix.accuracy <= o.maxAccuracy)) { this.stats.rejectedAccuracy++; return null; }
      if (fix.t < this.resumedAt) return null; // fix antérieur au démarrage / à la reprise
      const lastRaw = this._lastRaw;
      if (lastRaw && fix.t <= lastRaw.t) return null; // doublon

      // Vitesse Doppler (fournie par la puce GPS, bien plus fiable que les positions pour l'allure)
      if (Number.isFinite(fix.speed) && fix.speed >= 0 && fix.speed < 15) {
        const d = this._doppler;
        if (!d || fix.t - d.t > 10000) this._doppler = { v: fix.speed, t: fix.t };
        else {
          const k = 1 - Math.exp(-(fix.t - d.t) / o.dopplerTau);
          this._doppler = { v: d.v + k * (fix.speed - d.v), t: fix.t };
        }
      }

      // 1) Rejet des sauts GPS (vitesse impossible, au-delà de la marge de précision)
      if (lastRaw) {
        const margin = (lastRaw.acc + fix.accuracy) / 2;
        const v = Math.max(0, haversine(lastRaw, fix) - margin) / ((fix.t - lastRaw.t) / 1000);
        if (v > o.maxSpeed) {
          this.stats.rejectedJump++;
          if (++this._jumpRejects < o.maxJumpRejects) return null;
          // Plusieurs rejets d'affilée : la référence était fausse. On repart d'ici sans compter de distance.
          this._newSegment();
        }
      }
      this._jumpRejects = 0;
      this._lastRaw = { lat: fix.lat, lng: fix.lng, t: fix.t, acc: fix.accuracy };

      // 2) Lissage de Kalman
      if (!this._kalman) this._kalman = new KalmanLatLng(o.kalmanQ);
      const f = this._kalman.process(fix.lat, fix.lng, fix.accuracy, fix.t);

      // Historique filtré : hist[0] = position d'il y a ~stillWindow
      const hist = this._hist;
      hist.push({ lat: f.lat, lng: f.lng, t: fix.t });
      while (hist.length > 2 && fix.t - hist[1].t >= o.stillWindow) hist.shift();

      // 3) Anti « distance fantôme » à l'arrêt
      const seg = this.segments[this.segments.length - 1];
      const last = seg[seg.length - 1];
      let step = 0;
      if (last) {
        step = haversine(last, f);
        const minStep = Math.min(o.maxStep, Math.max(o.minStep, fix.accuracy * o.accuracyStepFactor));
        const dopplerStill = Number.isFinite(fix.speed) && fix.speed >= 0 && fix.speed < o.stillSpeed;
        const span = (fix.t - hist[0].t) / 1000;
        const driftStill = span >= 5 && haversine(hist[0], f) / span < o.stillAvgSpeed;
        if (step < minStep || dopplerStill || driftStill) {
          this.stats.rejectedStill++;
          return null;
        }
      }

      // 4) Point retenu
      const a = Math.max(this.activeTime(fix.t), last ? last.a : 0);
      const ele = this._elevation(fix);
      const p = { lat: f.lat, lng: f.lng, ele, t: fix.t, a, d: this.distance + step };
      if (last) this._splits(last, p, step);
      this.distance += step;
      seg.push(p);
      this.stats.accepted++;
      return p;
    }

    _elevation(fix) {
      const o = this.opts;
      const dem = Number.isFinite(fix.dem) ? fix.dem : null;
      const gpsOk = Number.isFinite(fix.alt) &&
        (!Number.isFinite(fix.altAccuracy) || fix.altAccuracy <= o.maxAltAccuracy);
      const gps = gpsOk ? fix.alt : null;

      // Une seule source par course : relief Mapbox et altitude GPS n'ont pas la même référence.
      if (!this.eleSource) {
        if (dem !== null) this.eleSource = 'dem';
        else if (gps !== null && this.stats.accepted >= o.demWaitPoints) this.eleSource = 'gps';
      }
      const raw = this.eleSource === 'dem' ? dem : this.eleSource === 'gps' ? gps : null;
      if (raw === null) return null;

      const buf = this._eleBuf;
      buf.push(raw);
      if (buf.length > o.eleSmoothing) buf.shift();
      const sm = buf.reduce((s, v) => s + v, 0) / buf.length;

      if (this._eleRef === null) {
        this._eleRef = sm;
      } else {
        const th = o.eleThreshold[this.eleSource];
        const diff = sm - this._eleRef;
        if (diff >= th) { this.gain += diff; this._eleRef = sm; }
        else if (diff <= -th) { this.loss -= diff; this._eleRef = sm; }
      }
      return Math.round(sm * 10) / 10;
    }

    _splits(prev, p, step) {
      let next = (this.splits.length + 1) * 1000;
      while (this.distance + step >= next) {
        const frac = (next - this.distance) / step;
        const aCross = prev.a + frac * (p.a - prev.a);
        this.splits.push({
          km: this.splits.length + 1,
          ms: Math.round(aCross - this._splitStartA),
          gain: Math.round(this.gain - this._splitStartGain),
        });
        this._splitStartA = aCross;
        this._splitStartGain = this.gain;
        next += 1000;
      }
    }

    /** Vitesse instantanée (m/s) lissée sur la fenêtre ; 0 à l'arrêt, null si pas assez de données. */
    currentSpeed(now) {
      if (this.status !== 'running') return 0;
      if (this._doppler && now - this._doppler.t <= 5000) return this._doppler.v;
      const seg = this.segments[this.segments.length - 1];
      if (!seg || seg.length < 2) return null;
      const last = seg[seg.length - 1];
      const w = this.opts.speedWindow;
      if (now - last.t > w) return 0;
      const end = now - last.t <= 5000 ? last.t : now; // décroît vers 0 si plus aucun point n'arrive
      let i = seg.length - 1;
      while (i > 0 && seg[i].t > end - w) i--;
      const span = (end - seg[i].t) / 1000;
      if (span < 4) return null;
      return (last.d - seg[i].d) / span;
    }

    /** Enregistrement final pour l'historique. */
    toRecord() {
      const duration = this.status === 'running' ? this.activeTime(Date.now()) : this.activeMs;
      const partialDist = this.distance - this.splits.length * 1000;
      return {
        id: this.startedAt,
        v: 2,
        startedAt: this.startedAt,
        endedAt: this.endedAt || Date.now(),
        duration: Math.round(duration),
        distance: Math.round(this.distance * 10) / 10,
        gain: Math.round(this.gain),
        loss: Math.round(this.loss),
        eleSource: this.eleSource,
        splits: this.splits.slice(),
        partial: partialDist >= 10 ? {
          distance: Math.round(partialDist),
          ms: Math.round(duration - this._splitStartA),
          gain: Math.round(this.gain - this._splitStartGain),
        } : null,
        segments: this.segments.filter((s) => s.length).map((s) => s.map(packPoint)),
      };
    }

    /** État complet de la course en cours (sauvegarde anti-crash). */
    toState(now) {
      return {
        v: 2,
        status: this.status,
        savedAt: now,
        startedAt: this.startedAt,
        activeMs: this.activeTime(now),
        distance: this.distance,
        gain: this.gain,
        loss: this.loss,
        eleSource: this.eleSource,
        splits: this.splits,
        splitStartA: this._splitStartA,
        splitStartGain: this._splitStartGain,
        stats: this.stats,
        segments: this.segments.map((s) => s.map(packPoint)),
      };
    }

    /** Restaure une course en cours, toujours en pause (le temps écoulé hors de l'appli n'est pas compté). */
    static fromState(s, opts) {
      if (!s || !Array.isArray(s.segments) || !Number.isFinite(s.startedAt)) throw new Error('État invalide');
      const t = new RunTracker(opts);
      t.status = 'paused';
      t.startedAt = s.startedAt;
      t.activeMs = s.activeMs || 0;
      t.distance = s.distance || 0;
      t.gain = s.gain || 0;
      t.loss = s.loss || 0;
      t.eleSource = s.eleSource || null;
      t.splits = Array.isArray(s.splits) ? s.splits : [];
      t._splitStartA = s.splitStartA || 0;
      t._splitStartGain = s.splitStartGain || 0;
      t.stats = Object.assign(t.stats, s.stats || {});
      t.segments = s.segments.map((seg) => seg.map(unpackPoint));
      return t;
    }
  }

  /** Segments d'un enregistrement, en objets {lat,lng,ele,t,a,d}. */
  function segmentsOf(run) {
    return (run && Array.isArray(run.segments) ? run.segments : []).map((seg) => seg.map(unpackPoint));
  }

  // =====================================================================
  // Export GPX
  // =====================================================================
  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  }

  function toGPX(run) {
    const iso = (t) => new Date(t).toISOString();
    const name = escapeXml('Course du ' + formatDate(run.startedAt));
    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Application Course" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${name}</name><time>${iso(run.startedAt)}</time></metadata>`,
      `  <trk><name>${name}</name><type>running</type>`,
    ];
    for (const seg of segmentsOf(run)) {
      if (!seg.length) continue;
      out.push('    <trkseg>');
      for (const p of seg) {
        out.push(`      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">` +
          (Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : '') +
          (Number.isFinite(p.t) ? `<time>${iso(p.t)}</time>` : '') + '</trkpt>');
      }
      out.push('    </trkseg>');
    }
    out.push('  </trk>', '</gpx>', '');
    return out.join('\n');
  }

  // =====================================================================
  // Stockage
  // =====================================================================
  /** Historique dans IndexedDB (pas de limite de 5 Mo comme localStorage). */
  const DB = {
    _p: null,
    open() {
      if (this._p) return this._p;
      this._p = new Promise((resolve, reject) => {
        const req = indexedDB.open('application-course', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('runs')) req.result.createObjectStore('runs', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { this._p = null; reject(req.error); };
      });
      return this._p;
    },
    async _tx(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('runs', mode);
        const req = fn(tx.objectStore('runs'));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction annulée'));
      });
    },
    getAll() { return this._tx('readonly', (s) => s.getAll()); },
    get(id) { return this._tx('readonly', (s) => s.get(id)); },
    put(run) { return this._tx('readwrite', (s) => s.put(run)); },
    delete(id) { return this._tx('readwrite', (s) => s.delete(id)); },
  };

  /** Course en cours, sauvegardée en continu pour survivre à un rechargement / crash. */
  const IN_PROGRESS_KEY = 'course_en_cours';
  const InProgress = {
    save(state) {
      try { localStorage.setItem(IN_PROGRESS_KEY, JSON.stringify(state)); return true; } catch (e) { return false; }
    },
    load() {
      try { const s = localStorage.getItem(IN_PROGRESS_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
    },
    clear() {
      try { localStorage.removeItem(IN_PROGRESS_KEY); } catch (e) { /* rien */ }
    },
  };

  const Prefs = {
    get(k, def) {
      try { const v = localStorage.getItem('pref_' + k); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem('pref_' + k, JSON.stringify(v)); } catch (e) { /* rien */ }
    },
  };

  /** Reprend les courses de l'ancienne version (localStorage "courses") dans IndexedDB. */
  async function migrateLegacy() {
    let old;
    try { old = JSON.parse(localStorage.getItem('courses') || 'null'); } catch (e) { old = null; }
    if (!Array.isArray(old) || !old.length) return 0;
    let n = 0;
    for (const c of old) {
      const id = Number(c && c.id);
      if (!Number.isFinite(id)) continue;
      const pts = Array.isArray(c.path) ? c.path.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) : [];
      let d = 0;
      const seg = pts.map((p, i) => {
        if (i) d += haversine(pts[i - 1], p);
        return [r6(p.lat), r6(p.lng), null, null, null, r1(d)];
      });
      const duration = Number(c.duration) || 0;
      await DB.put({
        id, v: 2, migrated: true, startedAt: id, endedAt: id + duration, duration,
        distance: Number(c.distance) || d, gain: Math.round(Number(c.elevationGain) || 0), loss: 0,
        eleSource: null, splits: [], partial: null, segments: seg.length ? [seg] : [],
      });
      n++;
    }
    localStorage.setItem('courses_ancien_format', JSON.stringify(old)); // sauvegarde de sécurité
    localStorage.removeItem('courses');
    return n;
  }

  async function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch (e) { /* facultatif */ }
  }

  const api = {
    CONFIG, DEFAULTS, haversine, simplify, encodePolyline,
    formatDuration, formatPace, formatKm, formatDate, fileStamp,
    paceSecPerKm, avgSpeed, kmEffort, kmEffortPerHour,
    KalmanLatLng, RunTracker, packPoint, unpackPoint, segmentsOf, toGPX,
    DB, InProgress, Prefs, migrateLegacy, requestPersistentStorage,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Course = api;
})(typeof window !== 'undefined' ? window : globalThis);
