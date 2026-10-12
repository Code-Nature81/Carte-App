/* Tests du moteur de calcul — lancer avec : node tests/test-calculs.js */
'use strict';
const C = require('../js/common.js');
const OPTS = process.env.TRACKER_OPTS ? JSON.parse(process.env.TRACKER_OPTS) : {};

let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✓ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- Générateurs de bruit reproductibles ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeGauss(seed) {
  const r = mulberry32(seed);
  return () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}
/** Bruit GPS : composante corrélée (comme un vrai GPS) + composante blanche. */
function makeNoise(seed, sigmaCorr, sigmaWhite, rho = 0.9) {
  const g = makeGauss(seed);
  let n = 0, e = 0;
  const k = Math.sqrt(1 - rho * rho);
  return () => {
    n = rho * n + k * sigmaCorr * g();
    e = rho * e + k * sigmaCorr * g();
    return { n: n + sigmaWhite * g(), e: e + sigmaWhite * g() };
  };
}

const BASE = { lat: 45.0, lng: 5.0 };
const M_LAT = Math.PI / 180 * 6371008.8;
const offset = (n, e) => ({ lat: BASE.lat + n / M_LAT, lng: BASE.lng + e / (M_LAT * Math.cos(BASE.lat * Math.PI / 180)) });
const T0 = 1_760_000_000_000;

/**
 * Simule une course. path(s) → {n, e, ele} position vraie en mètres à la seconde s.
 * Retourne le tracker et la distance vraie.
 */
function simulate({ path, seconds, noise, accuracy = 8, eleNoise = null, eleSource = 'gps', tracker, t0 = T0, startAt = 0, speedFn = null }) {
  const tr = tracker || new C.RunTracker(OPTS);
  if (tr.status === 'idle') tr.start(t0 + startAt * 1000);
  let trueDist = 0, prev = null;
  for (let s = startAt + 1; s <= startAt + seconds; s++) {
    const tp = path(s);
    if (prev) trueDist += Math.hypot(tp.n - prev.n, tp.e - prev.e);
    prev = tp;
    const nz = noise();
    const pos = offset(tp.n + nz.n, tp.e + nz.e);
    const ele = Number.isFinite(tp.ele) ? tp.ele + (eleNoise ? eleNoise() : 0) : null;
    tr.addPosition({
      lat: pos.lat, lng: pos.lng, accuracy, t: t0 + s * 1000,
      alt: eleSource === 'gps' ? ele : null, altAccuracy: 10,
      dem: eleSource === 'dem' ? ele : null,
      speed: speedFn ? speedFn(s) : null,
    });
  }
  return { tr, trueDist };
}

// =====================================================================
console.log('\nGéométrie');
{
  const d = C.haversine({ lat: 45, lng: 5 }, { lat: 46, lng: 5 });
  check('1° de latitude = 111,195 km', near(d, 111195, 1), d.toFixed(1) + ' m');
  const pl = C.haversine({ lat: 48.8566, lng: 2.3522 }, { lat: 45.764, lng: 4.8357 });
  check('Paris → Lyon ≈ 391,5 km', near(pl, 391500, 1500), (pl / 1000).toFixed(1) + ' km');
  const enc = C.encodePolyline([{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
  check('Encodage polyline (exemple officiel Google)', enc === '_p~iF~ps|U_ulLnnqC_mqNvxq`@', enc);
  const line = Array.from({ length: 101 }, (_, i) => offset(i * 10, 0));
  check('Douglas-Peucker réduit une ligne droite à 2 points', C.simplify(line, 1).length === 2);
}

console.log('\nFormats');
{
  check('Allure 333,3 s → 5:33', C.formatPace(333.3) === '5:33');
  check('Allure 359,6 s → 6:00 (pas 5:60)', C.formatPace(359.6) === '6:00', C.formatPace(359.6));
  check('Allure invalide → --:--', C.formatPace(null) === '--:--' && C.formatPace(Infinity) === '--:--');
  check('4 999,9 m → 4.99 km (tronqué)', C.formatKm(4999.9) === '4.99');
  check('5 000 m → 5.00 km', C.formatKm(5000) === '5.00');
  check('Durée 3 723 s → 01:02:03', C.formatDuration(3723000, true) === '01:02:03');
  check('Km-effort : 10 km + 500 m D+ = 15', C.kmEffort(10000, 500) === 15);
  check('Km-effort/h : 15 en 1h30 = 10/h', near(C.kmEffortPerHour(10000, 500, 5400000), 10, 1e-9));
  check('Vitesse 3 m/s → allure 5:33', C.formatPace(C.paceSecPerKm(3)) === '5:33');
}

console.log('\nDistance (bruit GPS réaliste, précision 8 m)');
{
  const { tr, trueDist } = simulate({ path: (s) => ({ n: s * 3, e: 0 }), seconds: 1667, noise: makeNoise(1, 4, 1.5) });
  const err = (tr.distance - trueDist) / trueDist * 100;
  check('5 km en ligne droite : erreur < 2 %', Math.abs(err) < 2, `${tr.distance.toFixed(0)} m / ${trueDist.toFixed(0)} m, ${err.toFixed(2)} %`);
}
{
  // Piste de 400 m (rayon 63,66 m), 10 tours à 3,5 m/s
  const R = 400 / (2 * Math.PI), v = 3.5;
  const { tr, trueDist } = simulate({
    path: (s) => ({ n: R * Math.sin(v * s / R), e: R - R * Math.cos(v * s / R) }),
    seconds: Math.round(4000 / v), noise: makeNoise(2, 4, 1.5),
  });
  const err = (tr.distance - trueDist) / trueDist * 100;
  check('10 tours de piste (virages serrés) : erreur < 3 %', Math.abs(err) < 3, `${tr.distance.toFixed(0)} m / ${trueDist.toFixed(0)} m, ${err.toFixed(2)} %`);
}
{
  // Parcours urbain avec virages à 90° tous les 200 m
  const v = 3;
  const path = (s) => {
    const d = s * v, leg = Math.floor(d / 200), r = d % 200;
    let n = 0, e = 0;
    for (let i = 0; i < leg; i++) { if (i % 2 === 0) n += 200; else e += 200; }
    if (leg % 2 === 0) n += r; else e += r;
    return { n, e };
  };
  const { tr, trueDist } = simulate({ path, seconds: 2000, noise: makeNoise(3, 4, 1.5) });
  const err = (tr.distance - trueDist) / trueDist * 100;
  check('6 km en ville (virages à 90°) : erreur < 2 %', Math.abs(err) < 2, `${tr.distance.toFixed(0)} m / ${trueDist.toFixed(0)} m, ${err.toFixed(2)} %`);
}
{
  // Cas extrême : bruit 100 % blanc (pire cas, rare sur un vrai téléphone)
  const g = makeGauss(4);
  const { tr, trueDist } = simulate({ path: (s) => ({ n: s * 3, e: 0 }), seconds: 1667, noise: () => ({ n: 4 * g(), e: 4 * g() }) });
  const err = (tr.distance - trueDist) / trueDist * 100;
  check('Pire cas (bruit blanc σ = 4 m) : erreur < 4 %', Math.abs(err) < 4, `${err.toFixed(2)} %`);
}

console.log('\nArrêt (feu rouge, pause non déclenchée)');
{
  const { tr } = simulate({ path: () => ({ n: 0, e: 0 }), seconds: 600, noise: makeNoise(5, 4, 1.5) });
  check('10 min immobile (GPS qui dérive) : distance fantôme < 10 m', tr.distance < 10, tr.distance.toFixed(1) + ' m');
  check('10 min immobile : allure instantanée nulle ou indéfinie', !tr.currentSpeed(T0 + 600000) || tr.currentSpeed(T0 + 600000) < 0.3);
}
{
  const { tr } = simulate({ path: () => ({ n: 0, e: 0 }), seconds: 600, noise: makeNoise(6, 4, 1.5), speedFn: () => 0 });
  check('10 min immobile avec vitesse Doppler : distance < 5 m', tr.distance < 5, tr.distance.toFixed(1) + ' m');
}

console.log('\nSauts GPS');
{
  const tr = new C.RunTracker();
  tr.start(T0);
  for (let s = 1; s <= 300; s++) {
    const jump = s === 150 ? 500 : 0; // un fix aberrant à 500 m
    const p = offset(s * 3 + jump, 0);
    tr.addPosition({ ...p, accuracy: 8, t: T0 + s * 1000 });
  }
  check('Un fix à 500 m est ignoré', near(tr.distance, 897, 15), tr.distance.toFixed(0) + ' m');
  check('… et compté comme saut', tr.stats.rejectedJump === 1);
}
{
  const tr = new C.RunTracker();
  tr.start(T0);
  let n = 0;
  for (let s = 1; s <= 200; s++) {
    tr.addPosition({ ...offset(s * 3, 0), accuracy: 50, t: T0 + s * 1000 });
    n++;
  }
  check('Fixes à ±50 m ignorés (distance 0)', tr.distance === 0);
}

console.log('\nPause / reprise');
{
  const tr = new C.RunTracker();
  simulate({ tracker: tr, path: (s) => ({ n: s * 3, e: 0 }), seconds: 333, noise: makeNoise(7, 4, 1.5) });
  const d1 = tr.distance;
  tr.pause(T0 + 333000);
  // 5 min de pause pendant lesquelles on se déplace de 300 m (non comptés)
  tr.resume(T0 + 633000);
  simulate({ tracker: tr, path: (s) => ({ n: 999 + 300 + (s - 633) * 3, e: 0 }), seconds: 333, startAt: 633, noise: makeNoise(8, 4, 1.5) });
  const t = tr.activeTime(T0 + 966000);
  check('Temps actif exclut la pause', t === 666000, C.formatDuration(t));
  check('Distance après pause ≈ 2 km ±3 % (déplacement pendant la pause ignoré)', near(tr.distance, 1998, 60), tr.distance.toFixed(0) + ' m');
  check('2 segments distincts', tr.segments.length === 2);
  const lastSplit = tr.splits[tr.splits.length - 1];
  check('Le km franchi autour de la pause n\'inclut pas les 5 min de pause', lastSplit && lastSplit.ms < 400000, lastSplit && C.formatPace(lastSplit.ms / 1000) + ' /km');
  check('Distance avant pause ≈ 1 km ±3 %', near(d1, 999, 30), d1.toFixed(0) + ' m');
}

console.log('\nTemps au kilomètre');
{
  const { tr } = simulate({ path: (s) => ({ n: s * 3, e: 0 }), seconds: 1001, noise: makeNoise(9, 4, 1.5) });
  const ok = tr.splits.length === 3 && tr.splits.every((s) => near(s.ms / 1000, 333.3, 7));
  check('3 km à 3 m/s → 3 splits de 5:33 ±2 %', ok, tr.splits.map((s) => C.formatPace(s.ms / 1000)).join(' / '));
  tr.stop(T0 + 1001000);
  const rec = tr.toRecord();
  const sum = rec.splits.reduce((a, s) => a + s.ms, 0) + (rec.partial ? rec.partial.ms : 0);
  check('Somme des splits = durée totale', near(sum, rec.duration, 2), `${sum} / ${rec.duration}`);
}

console.log('\nAllure instantanée');
{
  // 3 m/s pendant 300 s puis accélération à 4 m/s
  const path = (s) => ({ n: s <= 300 ? s * 3 : 900 + (s - 300) * 4, e: 0 });
  const { tr } = simulate({ path, seconds: 300, noise: makeNoise(10, 4, 1.5) });
  const v1 = tr.currentSpeed(T0 + 300000);
  check('Sans Doppler : allure à 3 m/s ≈ 5:33 (±25 s)', v1 && near(C.paceSecPerKm(v1), 333, 25), v1 && C.formatPace(C.paceSecPerKm(v1)));
  simulate({ tracker: tr, path, seconds: 60, startAt: 300, noise: makeNoise(20, 4, 1.5) });
  const v2 = tr.currentSpeed(T0 + 360000);
  check('Sans Doppler : passe à ~4:10 en moins d\'une minute (±25 s)', v2 && near(C.paceSecPerKm(v2), 250, 25), v2 && C.formatPace(C.paceSecPerKm(v2)));
  check('Sans Doppler : allure retombe à 0 après un arrêt', tr.currentSpeed(T0 + 395000) === 0);
}
{
  const g = makeGauss(21);
  const path = (s) => ({ n: s <= 300 ? s * 3 : 900 + (s - 300) * 4, e: 0 });
  const speedFn = (s) => Math.max(0, (s <= 300 ? 3 : 4) + 0.25 * g());
  const { tr } = simulate({ path, seconds: 360, noise: makeNoise(22, 4, 1.5), speedFn });
  const v = tr.currentSpeed(T0 + 360000);
  check('Avec Doppler : allure à 4 m/s ≈ 4:10 (±8 s)', near(C.paceSecPerKm(v), 250, 8), C.formatPace(C.paceSecPerKm(v)));
}

console.log('\nDénivelé');
{
  // Montée de 100 m sur 2 km puis descente de 100 m, altitude GPS bruitée (σ = 3 m)
  const g = makeGauss(11);
  const { tr } = simulate({
    path: (s) => { const d = s * 3; return { n: d, e: 0, ele: 200 + (d <= 2000 ? d / 20 : 100 - (d - 2000) / 20) }; },
    seconds: 1333, noise: makeNoise(12, 4, 1.5), eleNoise: () => 3 * g(), eleSource: 'gps',
  });
  check('Altitude GPS : D+ ≈ 100 m (±12)', near(tr.gain, 100, 12), Math.round(tr.gain) + ' m');
  check('Altitude GPS : D- ≈ 100 m (±12)', near(tr.loss, 100, 12), Math.round(tr.loss) + ' m');
}
{
  const g = makeGauss(13);
  const { tr } = simulate({ path: (s) => ({ n: s * 3, e: 0, ele: 150 }), seconds: 1000, noise: makeNoise(14, 4, 1.5), eleNoise: () => 3 * g(), eleSource: 'gps' });
  check('Terrain plat, altitude GPS bruitée : D+ < 10 m', tr.gain < 10, Math.round(tr.gain) + ' m');
}
{
  const g = makeGauss(15);
  const { tr } = simulate({
    path: (s) => ({ n: s * 3, e: 0, ele: 300 + 30 * Math.sin(s * 3 / 300) }),
    seconds: 1500, noise: makeNoise(16, 4, 1.5), eleNoise: () => 0.4 * g(), eleSource: 'dem',
  });
  // Vrai D+ de la sinusoïde sur 4,5 km
  let trueGain = 0;
  for (let s = 1; s <= 1500; s++) { const a = 30 * Math.sin(s * 3 / 300), b = 30 * Math.sin((s - 1) * 3 / 300); if (a > b) trueGain += a - b; }
  check('Relief Mapbox (vallonné) : D+ à ±8 %', Math.abs(tr.gain - trueGain) / trueGain < 0.08, `${Math.round(tr.gain)} m / ${Math.round(trueGain)} m`);
  check('Source d\'altitude = relief Mapbox', tr.eleSource === 'dem');
}

console.log('\nSauvegarde / restauration');
{
  const { tr } = simulate({ path: (s) => ({ n: s * 3, e: 0 }), seconds: 500, noise: makeNoise(17, 4, 1.5) });
  const now = T0 + 500000;
  const json = JSON.parse(JSON.stringify(tr.toState(now)));
  const back = C.RunTracker.fromState(json);
  check('Distance restaurée identique', back.distance === tr.distance);
  check('Temps actif restauré identique', back.activeTime(now + 99999) === tr.activeTime(now), 'restaurée en pause');
  check('Course restaurée en pause', back.status === 'paused');
  back.resume(now + 60000);
  simulate({ tracker: back, path: (s) => ({ n: 1500 + (s - 560) * 3, e: 0 }), seconds: 200, startAt: 560, noise: makeNoise(18, 4, 1.5) });
  check('La course continue après restauration', near(back.distance, 2100, 40), back.distance.toFixed(0) + ' m');
}

console.log('\nExport GPX');
{
  const { tr } = simulate({ path: (s) => ({ n: s * 3, e: 0, ele: 100 }), seconds: 200, noise: makeNoise(19, 4, 1.5), eleSource: 'dem' });
  tr.stop(T0 + 200000);
  const gpx = C.toGPX(tr.toRecord());
  const nPts = (gpx.match(/<trkpt /g) || []).length;
  check('Tous les points exportés', nPts === tr.stats.accepted, nPts + ' points');
  check('Altitude et heure présentes', /<ele>[\d.]+<\/ele><time>\d{4}-\d\d-\d\dT/.test(gpx));
  check('XML bien formé (balises équilibrées)', (gpx.match(/<trkseg>/g) || []).length === (gpx.match(/<\/trkseg>/g) || []).length);
}

console.log(`\n${passed} réussis, ${failed} échoués\n`);
process.exit(failed ? 1 : 0);
