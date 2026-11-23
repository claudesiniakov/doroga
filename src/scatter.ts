import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RoadWorld } from './road';
import { EXIT_W } from './road';
import { ROAD } from './textures';
import { BiomeId } from './biomes';
import { PropId, BuildingParts, house, tower, exitStation, repairShop, withColor } from './props';
import { mulberry32, fbm1, smoothstep, vnoise2 } from './noise';

const STEP = 2;

type ForestSpecies = 'pine' | 'spruce' | 'birch' | 'oak';

/** Правила растительности: плотность — штук на 100 м², полоса смещений, масштаб, где у моря. */
interface Rule {
  id: PropId; d: number; o: [number, number]; s: [number, number];
  sea?: 'land' | 'beach';
  species?: ForestSpecies;
}
const forestTrees: ForestSpecies[] = ['pine', 'spruce', 'birch', 'oak'];
const RULES: Record<BiomeId, Rule[]> = {
  forest: [
    ...forestTrees.flatMap((species): Rule[] => [
      { id: species, species, d: 0.64, o: [10, 68], s: [0.68, 1.35] },
      { id: `${species}Lo`, species, d: 0.34, o: [68, 245], s: [0.85, 1.5] },
    ]),
    { id: 'bush', d: 0.19, o: [7, 47], s: [0.65, 1.5] },
    { id: 'rock', d: 0.015, o: [9, 90], s: [0.5, 1.6] },
  ],
  suburb: [
    { id: 'oak', d: 0.06, o: [10, 80], s: [0.8, 1.3] },
    { id: 'oakLo', d: 0.05, o: [80, 245], s: [0.9, 1.4] },
    { id: 'birch', d: 0.04, o: [10, 70], s: [0.8, 1.2] },
    { id: 'pineLo', d: 0.03, o: [90, 245], s: [0.9, 1.4] },
    { id: 'bush', d: 0.09, o: [8, 60], s: [0.7, 1.3] },
  ],
  city: [
    { id: 'oak', d: 0.025, o: [9, 20], s: [0.7, 1.0] },
    { id: 'bush', d: 0.05, o: [8, 20], s: [0.6, 1.0] },
  ],
  desert: [
    { id: 'cactus', d: 0.03, o: [8, 90], s: [0.6, 1.4] },
    { id: 'cactusLo', d: 0.018, o: [90, 245], s: [0.8, 1.5] },
    { id: 'dryBush', d: 0.09, o: [7, 130], s: [0.5, 1.2] },
    { id: 'rock', d: 0.03, o: [9, 160], s: [0.5, 2.0] },
    { id: 'redRock', d: 0.006, o: [40, 245], s: [3, 9] },
  ],
  coast: [
    { id: 'pine', d: 0.19, o: [12, 65], s: [0.65, 1.2], sea: 'land' },
    { id: 'birch', d: 0.075, o: [10, 55], s: [0.65, 1.05], sea: 'land' },
    { id: 'pineLo', d: 0.14, o: [65, 220], s: [0.8, 1.4], sea: 'land' },
    { id: 'bush', d: 0.12, o: [8, 60], s: [0.6, 1.2], sea: 'land' },
    { id: 'dryBush', d: 0.08, o: [9, 17], s: [0.48, 0.85], sea: 'beach' },
    { id: 'rock', d: 0.022, o: [11, 23], s: [0.4, 1.25], sea: 'beach' },
    { id: 'rock', d: 0.012, o: [9, 40], s: [0.4, 1.4], sea: 'land' },
  ],
};
const NO_SHADOW = new Set<PropId>(['pineLo', 'spruceLo', 'oakLo', 'birchLo', 'cactusLo', 'rockLo', 'delineator', 'dryBush', 'festiveLights']);
const TREES = new Set<PropId>([...forestTrees, 'pineLo', 'spruceLo', 'oakLo', 'birchLo', 'bush', 'dryBush', 'cactus', 'cactusLo']);

function forestShare(species: ForestSpecies, s: number, offset: number, seed: number) {
  // Состав леса меняется по обе стороны дороги и в глубину плавно, независимо от границ чанков.
  const deciduous = smoothstep(0.34, 0.67, vnoise2(s / 360, offset / 155, seed + 41));
  const light = smoothstep(0.33, 0.67, vnoise2(s / 285, offset / 130, seed + 67));
  const cover = 0.22 + 0.78 * smoothstep(0.24, 0.57, vnoise2(s / 115, offset / 70, seed + 91));
  if (species === 'birch') return cover * deciduous * light;
  if (species === 'oak') return cover * deciduous * (1 - light);
  if (species === 'pine') return cover * (1 - deciduous) * light;
  return cover * (1 - deciduous) * (1 - light);
}

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _z = new THREE.Vector3();
const _pos = new THREE.Vector3(), _sc = new THREE.Vector3(), _basis = new THREE.Matrix4();

function quatZ(z: THREE.Vector3, out = _q) {
  _z.copy(z).setY(0).normalize();
  _x.crossVectors(UP, _z).normalize();
  _basis.makeBasis(_x, UP, _z);
  return out.setFromRotationMatrix(_basis);
}

export function scatterChunk(world: RoadWorld, k: number, i0: number, i1: number, origin: THREE.Vector3, group: THREE.Group) {
  const p = world.path, kit = world.kit, half = ROAD.half;
  const rnd = mulberry32((p.seed * 9301 + k * 49297 + 7) >>> 0);
  const inst = new Map<PropId, { m: THREE.Matrix4[]; c: THREE.Color[] }>();
  const parts: BuildingParts = { wall: [], glass: [], solid: [] };
  const foot: { side: number; s0: number; s1: number; o0: number; o1: number }[] = [];
  const wires: THREE.BufferGeometry[] = [];
  const s0c = i0 * STEP, s1c = i1 * STEP;

  const fwd = (i: number, out = new THREE.Vector3()) => out.set(Math.sin(p.h[i]), 0, Math.cos(p.h[i]));
  const right = (i: number, out = new THREE.Vector3()) => out.set(-Math.cos(p.h[i]), 0, Math.sin(p.h[i]));
  const ground = (i: number, so: number, out: THREE.Vector3, sink = 0) => {
    p.point(i, so, 0, out);
    out.y = world.groundAt(i, so) - sink;
    return out;
  };
  const seaSideAt = (i: number) => {
    const seg = p.biomes.coastNear(i * STEP);
    return seg && !Number.isNaN(p.sea[i]) ? seg.seaSide : 0;
  };
  const put = (id: PropId, pos: THREE.Vector3, q: THREE.Quaternion, scale: number, color?: THREE.Color) => {
    let e = inst.get(id);
    if (!e) { e = { m: [], c: [] }; inst.set(id, e); }
    e.m.push(new THREE.Matrix4().compose(_pos.copy(pos).sub(origin), q, _sc.set(scale, scale, scale)));
    e.c.push(color ?? new THREE.Color(1, 1, 1));
  };
  const blocked = (side: number, s: number, o: number, margin: number) =>
    foot.some((f) => f.side === side && s > f.s0 - margin && s < f.s1 + margin && o > f.o0 - margin && o < f.o1 + margin);
  const solidAt = (g: THREE.BufferGeometry, color: number, pos: THREE.Vector3, q: THREE.Quaternion) => {
    _m.compose(_pos.copy(pos).sub(origin), q, _sc.set(1, 1, 1));
    parts.solid.push(withColor(g, color, false).applyMatrix4(_m));
  };
  const tmp = new THREE.Vector3(), f = new THREE.Vector3(), r = new THREE.Vector3();
  /** Сдвиг правой обочины на ширину полосы съезда. */
  const ex = (i: number, side: number) => (side > 0 ? p.extraAt(i * STEP) : 0);

  // ——— пояс у дороги ———
  for (let i = i0; i < i1; i++) {
    const s = i * STEP;
    const w = p.weightsAt(i);
    const city = w.city, wires_ = w.suburb + w.desert;
    fwd(i, f); right(i, r);
    // сигнальные столбики каждые 50 м
    if (i % 25 === 0) {
      for (const side of [-1, 1]) if (side < 0 || p.stationFlat(s) < 0.02) put('delineator', ground(i, side * (half + 1.15 + ex(i, side)), tmp, 0.05), quatZ(f.clone().negate()), 1);
    }
    // фонари в городе: в шахматном порядке, вынос к дороге
    if (i % 18 === 0 && city > 0.35) {
      const side = i % 36 === 0 ? -1 : 1;
      const xDir = r.clone().multiplyScalar(-side);          // вынос (локальный +X) — к дороге
      put('lamp', ground(i, side * (half + 1.9 + ex(i, side)), tmp, 0.1), quatZ(new THREE.Vector3().crossVectors(xDir, UP)), 1);
    }
    // ЛЭП справа в пригороде и пустыне: опоры через 50 м, провода к следующей
    if (i % 25 === 12 && wires_ > 0.45) {
      const so = half + 8.5 + ex(i, 1);
      const base = ground(i, so, new THREE.Vector3(), 0.2);
      put('powerPole', base, quatZ(f), 1);
      const j = i + 25;
      p.ensure(j * STEP + STEP * 2);
      const wj = p.weightsAt(j);
      if (wj.suburb + wj.desert > 0.45) {
        const baseJ = ground(j, half + 8.5 + ex(j, 1), new THREE.Vector3(), 0.2);
        const fj = fwd(j);
        for (const zo of [-1, 0, 1]) {
          const a = base.clone().addScaledVector(f, zo).setY(base.y + 9.62);
          const b = baseJ.clone().addScaledVector(fj, zo).setY(baseJ.y + 9.62);
          const pts: THREE.Vector3[] = [];
          for (let t = 0; t <= 10; t++) {
            const u = t / 10;
            pts.push(a.clone().lerp(b, u).setY(a.y + (b.y - a.y) * u - 1.1 * 4 * u * (1 - u)).sub(origin));
          }
          wires.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.016, 3, false));
        }
      }
    }
    // заборы участков в пригороде
    if (i % 4 === 0 && w.suburb > 0.5 && fbm1(s / 260, 2, p.seed + 3) > -0.05) {
      for (const side of [-1, 1]) {
        if (fbm1(s / 140 + side * 7, 2, p.seed + 4) > 0.15) continue;
        if (p.stationFlat(s) > 0 && side > 0) continue;
        put('fence', ground(i, side * (12.5 + ex(i, side)), tmp, 0.05), quatZ(f), 1);
        foot.push({ side, s0: s - 1, s1: s + 9, o0: 12, o1: 13 });
      }
    }
    // вышки спасателей на пляже
    const ss = seaSideAt(i);
    if (ss && i % 60 === 30 && w.coast > 0.6 && rnd() < 0.7) {
      const o = 24 + rnd() * 5;
      const g = ground(i, ss * o, tmp, 0.3);
      if (g.y > p.sea[i] + 0.4) put('lifeguard', g, quatZ(r.clone().multiplyScalar(ss)), 1);
    }
  }

  // ——— знаки ———
  const sign = (s: number, key: string, w: number, h: number, height: number) => {
    const i = Math.round(s / STEP);
    if (i < i0 || i >= i1) return;
    fwd(i, f);
    const base = ground(i, half + 2.4 + ex(i, 1), new THREE.Vector3(), 0.1);
    const q = quatZ(f.clone().negate()).clone();
    solidAt(new THREE.CylinderGeometry(0.05, 0.05, height, 8).translate(0, height / 2, 0), 0x9aa0a6, base, q);
    solidAt(new THREE.BoxGeometry(w + 0.04, h + 0.04, 0.04).translate(0, height + h / 2 - 0.1, 0.03), 0x8a8f94, base, q);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), kit.sign(key));
    board.position.copy(base).sub(origin).add(new THREE.Vector3(0, height + h / 2 - 0.1, 0)).addScaledVector(f, -0.06);
    board.quaternion.copy(q);
    group.add(board);
    foot.push({ side: 1, s0: s - 3, s1: s + 3, o0: half + 1, o1: half + 4 });
  };
  for (let s = Math.ceil(s0c / 50) * 50; s < s1c; s += 50) {
    const seg = p.biomes.segmentAt(s);
    // въезд в населённый пункт — у начала района
    if (Math.abs(s - seg.start - 50) < 25 && seg.id !== 'desert' && seg.id !== 'forest') sign(s, `town:${seg.town}`, 2.2, 0.82, 1.8);
    if (s % 2000 === 400) sign(s, 'speed:90', 0.9, 0.9, 2.0);
    if (s % 3000 === 1600) {
      const next = p.biomes.segmentAt(seg.end + 1);
      sign(s, `dir:${next.town}|${Math.max(1, Math.round((next.start - s) / 1000))} км`, 2.6, 0.95, 1.9);
    }
  }

  // ——— заправка у съезда и знаки перед ней ———
  {
    const e = p.exitNear(s0c, 0) ?? p.exitNear(s1c - 1, 0) ?? p.exitNear(s0c, 800);
    if (e) {
      const title = e.kind === 'fuel' ? 'ТОПЛИВО 24' : 'АВТОСЕРВИС';
      sign(e.s0 - 500, `dir:${title}|500 м`, 2.6, 0.95, 1.9);
      sign(e.s0 - 30, `dir:${title}|↘`, 2.4, 0.95, 1.9);
      foot.push({ side: 1, s0: e.s0, s1: e.sEnd, o0: 0, o1: half + EXIT_W + 3.5 });
      if (e.sStop >= s0c && e.sStop < s1c) {
        const i = Math.round(e.sStop / STEP);
        fwd(i, f); right(i, r);
        const c = p.point(i, half + EXIT_W / 2, 0, new THREE.Vector3());
        _basis.makeBasis(f, UP, r);
        _q.setFromRotationMatrix(_basis);
        _m.compose(_pos.copy(c).sub(origin), _q, _sc.set(1, 1, 1));
        if (e.kind === 'fuel') exitStation(parts, _m);
        else {
          repairShop(parts, _m);
          // вывеска над воротами
          const sb = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), kit.sign('service'));
          sb.position.copy(c).sub(origin).addScaledVector(r, 11.3).add(new THREE.Vector3(0, 5.35, 0));
          sb.quaternion.copy(quatZ(r.clone().negate()));
          group.add(sb);
        }
        foot.push({ side: 1, s0: e.sStop - 45, s1: e.sStop + 45, o0: 0, o1: half + 40 });
        // стела с вывеской
        const ps = ground(i - 22, half + EXIT_W + 4, new THREE.Vector3(), 0.1);
        const q = quatZ(fwd(i - 22).negate()).clone();
        solidAt(new THREE.BoxGeometry(0.5, 7, 0.5).translate(0, 3.5, 0), 0xdedede, ps, q);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), kit.sign(e.kind === 'fuel' ? 'fuel' : 'service'));
        board.position.copy(ps).sub(origin).add(new THREE.Vector3(0, 6.4, 0)).addScaledVector(fwd(i - 22), -0.27);
        board.quaternion.copy(q);
        group.add(board);
      }
    }
  }

  // ——— здания рядами ———
  for (const side of [-1, 1]) {
    const rows: { kind: 'tower' | 'house'; o: [number, number]; prob: (w: Record<BiomeId, number>, sea: boolean) => number; hMax: number }[] = [
      { kind: 'tower', o: [26, 34], prob: (w) => w.city * 0.95, hMax: 46 },
      { kind: 'tower', o: [66, 86], prob: (w) => w.city * 0.85, hMax: 85 },
      { kind: 'tower', o: [125, 165], prob: (w) => w.city * 0.7, hMax: 125 },
      { kind: 'house', o: [16, 22], prob: (w, sea) => w.suburb * 0.85 + (sea ? 0 : w.coast * 0.22) + w.desert * 0.05 + w.city * 0.1, hMax: 0 },
      { kind: 'house', o: [44, 58], prob: (w, sea) => w.suburb * 0.55 + (sea ? 0 : w.coast * 0.12), hMax: 0 },
    ];
    for (const row of rows) {
      let s = s0c + rnd() * 6;
      while (true) {
        const tw = row.kind === 'tower';
        const along = tw ? 16 + rnd() * 14 : 8 + rnd() * 5;
        const depth = tw ? 16 + rnd() * 12 : 7 + rnd() * 3;
        if (s + along > s1c) break;
        const sc = s + along / 2;
        const i = Math.round(sc / STEP);
        const sea = seaSideAt(i) === side;
        const w = p.weightsAt(i);
        const setback = row.o[0] + rnd() * (row.o[1] - row.o[0]);
        const o = setback + depth / 2;
        if (rnd() < row.prob(w, sea) && !blocked(side, sc, o, 2)) {
          right(i, r);
          const c = ground(i, side * o, new THREE.Vector3(), tw ? 0.3 : 0.5);
          if (Number.isNaN(p.sea[i]) || c.y > p.sea[i] + 0.8) {
            _m.compose(_pos.copy(c).sub(origin), quatZ(r.clone().multiplyScalar(-side)), _sc.set(1, 1, 1));
            if (tw) tower(parts, _m, rnd, row.hMax * (0.55 + 0.45 * w.city), along, depth);
            else house(parts, _m, rnd, along, depth);
            foot.push({ side, s0: s, s1: s + along, o0: setback - 1, o1: setback + depth + 1 });
          }
        }
        s += along + (tw ? 5 + rnd() * 12 : 7 + rnd() * 16);
      }
    }
  }

  // ——— рекламный щит ———
  {
    const i = i0 + 8 + Math.floor(rnd() * (i1 - i0 - 16));
    const w = p.weightsAt(i);
    if (rnd() < (w.city + w.suburb + w.desert * 0.6) * 0.45) {
      const side = rnd() < 0.5 ? -1 : 1;
      const o = 20 + rnd() * 10;
      if (!blocked(side, i * STEP, o, 4) && seaSideAt(i) !== side) {
        fwd(i, f); right(i, r);
        const base = ground(i, side * o, new THREE.Vector3(), 0.2);
        const dir = f.clone().negate().multiplyScalar(Math.cos(0.5)).addScaledVector(r, -side * Math.sin(0.5)).normalize();
        const q = quatZ(dir).clone();
        for (const x of [-2.6, 2.6]) solidAt(new THREE.BoxGeometry(0.3, 5.2, 0.3).translate(x, 2.6, -0.2), 0x6b6f74, base, q);
        solidAt(new THREE.BoxGeometry(8.4, 3.4, 0.25).translate(0, 6.5, -0.15), 0x2a2d31, base, q);
        solidAt(new THREE.BoxGeometry(8.0, 0.12, 0.6).translate(0, 4.75, 0.15), 0x55595e, base, q);
        const ad = new THREE.Mesh(new THREE.PlaneGeometry(8.0, 3.0), kit.ads[Math.floor(rnd() * kit.ads.length)]);
        ad.position.copy(base).sub(origin).add(new THREE.Vector3(0, 6.5, 0)).addScaledVector(dir, 0.0);
        ad.quaternion.copy(q);
        ad.castShadow = true;
        group.add(ad);
        foot.push({ side, s0: i * STEP - 5, s1: i * STEP + 5, o0: o - 3, o1: o + 3 });
      }
    }
  }

  if (world.snow) {
    // Одна подходящая площадка на группу чанков. Посев не зависит от порядка их загрузки.
    const blockSize = 20;
    const block = Math.floor(k / blockSize);
    const holidayRnd = mulberry32(p.seed * 743 + block * 1999 + 77);
    const treeChunk = block * blockSize + 4 + Math.floor(holidayRnd() * 12);
    if (k === treeChunk) {
      const i = Math.floor((i0 + i1) / 2), s = i * STEP;
      const offset = half + 6 + holidayRnd() * 3;
      const preferred = holidayRnd() < 0.5 ? -1 : 1;
      for (const side of [preferred, -preferred]) {
        if (seaSideAt(i) === side || blocked(side, s, offset, 3)) continue;
        const at = ground(i, side * offset, tmp, 0.15);
        if (!Number.isNaN(p.sea[i]) && at.y < p.sea[i] + 0.35) continue;
        const scale = 0.56 + holidayRnd() * 0.13;
        const rotation = new THREE.Quaternion().setFromAxisAngle(UP, holidayRnd() * Math.PI * 2);
        put('spruce', at, rotation, scale);
        put('festiveLights', at, rotation, scale);
        foot.push({ side, s0: s - 2, s1: s + 2, o0: offset - 2, o1: offset + 2 });
        break;
      }
    }
  }

  // ——— растительность по правилам районов ———
  const len = s1c - s0c;
  const col = new THREE.Color();
  for (const side of [-1, 1]) {
    for (const biome of Object.keys(RULES) as BiomeId[]) {
      // быстрый отсев: район вообще присутствует в чанке?
      const wa = p.weightsAt(i0)[biome], wb = p.weightsAt(i1 - 1)[biome], wm = p.weightsAt((i0 + i1) >> 1)[biome];
      if (wa + wb + wm < 0.01) continue;
      for (const rule of RULES[biome]) {
        const n = Math.round((len * (rule.o[1] - rule.o[0]) * rule.d) / 100);
        for (let a = 0; a < n; a++) {
          const i = i0 + Math.floor(rnd() * (i1 - i0));
          const o = rule.o[0] + rnd() * (rule.o[1] - rule.o[0]);
          const wgt = p.weightsAt(i)[biome];
          const share = rule.species ? forestShare(rule.species, i * STEP, side * o, p.seed) : 1;
          if (rnd() >= wgt * share) continue;
          const seaHere = seaSideAt(i) === side;
          if (rule.sea === 'beach' && !seaHere) continue;
          if (seaHere && (rule.sea === 'land' || (!rule.sea && o > 12))) continue;
          if (blocked(side, i * STEP, o, TREES.has(rule.id) ? 1.5 : 0.5)) continue;
          const sc = rule.s[0] + rnd() * (rule.s[1] - rule.s[0]);
          const g = ground(i, side * o, tmp, rule.id.startsWith('rock') || rule.id === 'redRock' ? 0.3 * sc : 0.15);
          if (!Number.isNaN(p.sea[i]) && g.y < p.sea[i] + 0.35) continue;
          const ang = rnd() * Math.PI * 2;
          const q = quatZ(_z.set(Math.sin(ang), 0, Math.cos(ang)).clone());
          const v = 0.85 + rnd() * 0.3;
          col.setRGB(v * (0.95 + rnd() * 0.1), v * (0.95 + rnd() * 0.1), v * (0.92 + rnd() * 0.1));
          put(rule.id, g, q, sc, col.clone());
        }
      }
    }
  }

  // ——— сборка мешей ———
  for (const [id, e] of inst) {
    const material = id === 'festiveLights' ? kit.festiveMat : kit.mat;
    const im = new THREE.InstancedMesh(kit.geo[id], material, e.m.length);
    for (let n = 0; n < e.m.length; n++) { im.setMatrixAt(n, e.m[n]); im.setColorAt(n, e.c[n]); }
    im.userData.sharedGeo = true;
    im.castShadow = !NO_SHADOW.has(id);
    im.receiveShadow = !TREES.has(id);
    im.computeBoundingSphere();
    group.add(im);
  }
  const addMerged = (list: THREE.BufferGeometry[], mat: THREE.Material, shadow = true) => {
    if (!list.length) return;
    const g = mergeGeometries(list, false);
    if (!g) return;
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = shadow;
    m.receiveShadow = true;
    group.add(m);
  };
  addMerged(parts.wall, kit.houseMat);
  addMerged(parts.glass, kit.towerMat);
  addMerged(parts.solid, kit.solidMat);
  addMerged(wires, kit.wireMat, false);
}
