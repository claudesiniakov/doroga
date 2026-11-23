import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { spline, loft, bodyStations, type CarConfig, type CarModel } from './car';
import { clamp, mulberry32, smoothstep } from './noise';
import { makePlateTexture } from './textures';
import { buildKedr } from './car-kedr';
import cars from './cars.json';
import { VAN, vanShape, vanGreenhouse, vanBodyClassify } from './van-shape';
import { applyInsuranceStripes, brandTextures } from './brand/insurance-livery';

// Оси моделей трафика: +Z — вперёд, +Y — вверх, +X — ЛЕВЫЙ борт (базис «вверх × вперёд»).
/** Ключи материалов: детали модели склеиваются по ним — несколько draw call на машину. */
export type MatKey = 'paint' | 'paint2' | 'glass' | 'black' | 'chrome' | 'grey' | 'head' | 'beacon' | 'plate' | 'logo' | 'chevron' | 'rubber' | 'rim' | 'wood';
const TEXTURED: MatKey[] = ['plate', 'logo', 'chevron'];

export class Builder {
  private parts = new Map<MatKey, THREE.BufferGeometry[]>();
  add(geo: THREE.BufferGeometry, key: MatKey, pos?: THREE.Vector3Like, rot?: THREE.Euler, scale?: THREE.Vector3Like) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (!TEXTURED.includes(key)) g.deleteAttribute('uv');
    else if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    g.clearGroups();
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0),
      new THREE.Quaternion().setFromEuler(rot ?? new THREE.Euler()),
      new THREE.Vector3(scale?.x ?? 1, scale?.y ?? 1, scale?.z ?? 1));
    g.applyMatrix4(m);
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key)!.push(g);
    return this;
  }
  box(w: number, h: number, d: number, key: MatKey, pos: THREE.Vector3Like, r = 0, rot?: THREE.Euler) {
    const g = r > 0 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d);
    return this.add(g, key, pos, rot);
  }
  /** Разбить сетку с группами (результат loft) по материалам. */
  addGroups(geo: THREE.BufferGeometry, keys: MatKey[]) {
    const idx = geo.index!.array;
    for (const gr of geo.groups) {
      const sub = new THREE.BufferGeometry();
      sub.setAttribute('position', geo.getAttribute('position'));
      sub.setAttribute('normal', geo.getAttribute('normal'));
      sub.setIndex(Array.from(idx.slice(gr.start, gr.start + gr.count)));
      this.add(sub, keys[gr.materialIndex ?? 0]);
    }
    return this;
  }
  build(): Map<MatKey, THREE.BufferGeometry> {
    const out = new Map<MatKey, THREE.BufferGeometry>();
    for (const [k, list] of this.parts) {
      const g = mergeGeometries(list, false);
      if (g) { g.computeBoundingSphere(); out.set(k, g); }
    }
    return out;
  }
}

// ——— колёса: ось целиком (оба колеса одним мешем) вращается вокруг X ———
export function axleGeometry(R: number, rimR: number, W: number, halfTrack: number, dual: boolean, sides = [-1, 1]) {
  const prof: THREE.Vector2[] = [];
  const sh = Math.min(0.05, R * 0.12);
  prof.push(new THREE.Vector2(rimR, -W / 2 + 0.01), new THREE.Vector2(R - sh * 1.6, -W / 2));
  for (let i = 0; i <= 4; i++) { const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2); prof.push(new THREE.Vector2(R - sh + Math.cos(a) * sh, -W / 2 + sh + Math.sin(a) * sh)); }
  for (let i = 0; i <= 4; i++) { const a = (i / 4) * (Math.PI / 2); prof.push(new THREE.Vector2(R - sh + Math.cos(a) * sh, W / 2 - sh + Math.sin(a) * sh)); }
  prof.push(new THREE.Vector2(R - sh * 1.6, W / 2), new THREE.Vector2(rimR, W / 2 - 0.01));
  const tire = new THREE.LatheGeometry(prof, 32);
  tire.rotateZ(Math.PI / 2);
  const rubber = new Builder(), rim = new Builder();
  const xs = dual ? [halfTrack - W * 0.52, halfTrack + W * 0.52] : [halfTrack];
  for (const side of sides) {
    for (const x of xs) {
      rubber.add(tire, 'rubber', { x: side * x, y: 0, z: 0 });
      const face = new THREE.CylinderGeometry(rimR, rimR, 0.02, 24);
      face.rotateZ(Math.PI / 2);
      rim.add(face, 'rim', { x: side * (x + W * 0.35 * (x === xs[xs.length - 1] ? 1 : -1)), y: 0, z: 0 });
      // спицы/вырезы: тёмные пластины на диске
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const hole = new THREE.BoxGeometry(0.03, rimR * 0.38, rimR * 0.22);
        rubber.add(hole, 'rubber', { x: side * (x + W * 0.36), y: Math.cos(a) * rimR * 0.58, z: Math.sin(a) * rimR * 0.58 }, new THREE.Euler(a, 0, 0));
      }
      const hub = new THREE.CylinderGeometry(rimR * 0.28, rimR * 0.3, 0.06, 16);
      hub.rotateZ(Math.PI / 2);
      rim.add(hub, 'rim', { x: side * (x + W * 0.38), y: 0, z: 0 });
    }
  }
  return { rubber: rubber.build().get('rubber')!, rim: rim.build().get('rim')! };
}

// ——— параметрический кузов по сечениям (как у машины игрока) ———
export interface ShapeDef {
  halfLen: number;
  top: [number, number][];
  bottom: [number, number][];
  width: [number, number][];
  planFront: number; planRear: number;
  axles: number[]; wheelR: number; archR: number;
  archBlend?: number;
  /** Показатели суперэллипса сечения (низ/верх) и завал боковин к крыше. */
  seLow?: number; seHigh?: number; tumble?: number;
}

export class Shape {
  top: (z: number) => number;
  base: (z: number) => number;
  wraw: (z: number) => number;
  constructor(readonly d: ShapeDef) {
    this.top = spline(d.top);
    this.base = spline(d.bottom);
    this.wraw = spline(d.width);
  }
  bottom(z: number) {
    const base = this.base(z);
    let y = base;
    for (const az of this.d.axles) {
      const dz = Math.abs(z - az);
      const edge = this.d.archR - dz;
      if (edge <= 0) continue;
      const arch = this.d.wheelR + Math.sqrt(this.d.archR ** 2 - dz * dz);
      const t = this.d.archBlend ? Math.min(1, edge / this.d.archBlend) : 1;
      y = Math.max(y, base + (arch - base) * t * t * (3 - 2 * t));
    }
    return y;
  }
  halfW(z: number) {
    const u = z / this.d.halfLen;
    const p = u > 0 ? this.d.planFront : this.d.planRear;
    return this.wraw(z) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), p)), 1 / p);
  }
  private se(s: number) { return s < 0 ? (this.d.seLow ?? 7) : (this.d.seHigh ?? 3.2); }
  point(z: number, s: number, side: number) {
    const top = this.top(z), bot = Math.min(this.bottom(z), top - 0.05);
    const cy = (top + bot) / 2, hy = (top - bot) / 2;
    const e = this.se(s);
    const c = Math.sqrt(Math.max(0, 1 - s * s));
    let x = this.halfW(z) * Math.pow(c, 2 / e);
    x *= 1 - (this.d.tumble ?? 0.1) * Math.pow(Math.max(s, 0), 2);
    return new THREE.Vector3(side * x, cy + hy * Math.sign(s) * Math.pow(Math.abs(s), 2 / e), z);
  }
  xAt(z: number, y: number) {
    const top = this.top(z), bot = Math.min(this.bottom(z), top - 0.05);
    const cy = (top + bot) / 2, hy = (top - bot) / 2;
    const q = clamp((y - cy) / hy, -1, 1);
    const e = this.se(q);
    const s = Math.sign(q) * Math.pow(Math.abs(q), e / 2);
    const c = Math.sqrt(Math.max(0, 1 - s * s));
    return this.halfW(z) * Math.pow(c, 2 / e) * (1 - (this.d.tumble ?? 0.1) * Math.pow(Math.max(s, 0), 2));
  }
  surfaceZ(x: number, y: number, end: 1 | -1) {
    for (let m = this.d.halfLen; m > this.d.halfLen * 0.6; m -= 0.002) {
      if (this.xAt(end * m, y) >= Math.abs(x)) return end * m;
    }
    return end * this.d.halfLen * 0.6;
  }
  body(N: number, M: number) {
    const rows: THREE.Vector3[][] = [];
    for (const z of bodyStations(this.d.halfLen, N, this.d.axles, this.d.archR)) {
      const ring: THREE.Vector3[] = [];
      for (let k = 0; k < M; k++) ring.push(this.point(z, -1 + (2 * k) / (M - 1), 1));
      for (let k = M - 2; k > 0; k--) ring.push(this.point(z, -1 + (2 * k) / (M - 1), -1));
      rows.push(ring);
    }
    const cap = (ring: THREE.Vector3[]) => {
      const c = ring.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
      return [0.55, 0].map((k) => ring.map((p) => p.clone().sub(c).multiplyScalar(k).add(c)));
    };
    const [r1, r0] = cap(rows[0]);
    const [f1, f0] = cap(rows[rows.length - 1]);
    rows.unshift(r0, r1);
    rows.push(f1, f0);
    return rows;
  }
}

export type TrafficKind = 'sedan' | 'truck' | 'van' | 'tow' | 'limo' | 'classic' | 'kedr';

export interface TrafficTemplate<K extends string = TrafficKind> {
  kind: K;
  length: number;
  width: number;
  parts: Map<MatKey, THREE.BufferGeometry>;
  details?: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  tail: THREE.BufferGeometry;         // задние фонари (меняют материал при торможении)
  blinkL: THREE.BufferGeometry;
  blinkR: THREE.BufferGeometry;
  axles: { z: number; y: number; rubber: THREE.BufferGeometry; rim: THREE.BufferGeometry }[];
  wheelR: number;
}

function buildSedan(variant: 'sedan' | 'police' | 'limo' | 'classic' = 'sedan'): TrafficTemplate {
  const police = variant === 'police';
  const limo = variant === 'limo';
  const classic = variant === 'classic';
  const cabinShift = classic ? 0.17 : 0;
  const rearDoor = -0.98, middleDoor = -0.20, frontDoor = 0.63;
  const sh = new Shape(classic ? {
    halfLen: 2.075,
    top: [[-2.075, 0.925], [-2.02, 0.98], [-1.24, 0.99], [-0.45, 1.01], [0.75, 1.01], [1.13, 0.955], [1.78, 0.94], [2.02, 0.927], [2.075, 0.87]],
    bottom: [[-2.075, 0.43], [-1.88, 0.35], [-1.5, 0.26], [1.44, 0.26], [1.89, 0.32], [2.075, 0.42]],
    width: [[-2.075, 0.77], [-1.75, 0.80], [-0.5, 0.81], [0.85, 0.81], [1.75, 0.79], [2.075, 0.75]],
    planFront: 44, planRear: 40, axles: [1.410, -1.014], wheelR: 0.30, archR: 0.345, archBlend: 0.043,
    seLow: 10, seHigh: 14, tumble: 0.028,
  } : {
    halfLen: 2.3,
    top: [[-2.3, 0.72], [-2.26, 0.9], [-2.05, 0.985], [-1.5, 1.0], [-1.0, 0.985], [0, 0.94], [0.9, 0.905], [1.4, 0.865], [1.95, 0.79], [2.2, 0.69], [2.3, 0.5]],
    bottom: [[-2.3, 0.44], [-2.15, 0.31], [-1.8, 0.22], [1.8, 0.21], [2.15, 0.25], [2.3, 0.34]],
    width: [[-2.3, 0.82], [-1.9, 0.885], [-1.3, 0.9], [0, 0.9], [1.4, 0.9], [1.9, 0.87], [2.3, 0.78]],
    planFront: 5, planRear: 10, axles: [1.4, -1.38], wheelR: 0.31, archR: 0.355, archBlend: police ? 0.04 : undefined,
  });
  const b = new Builder();
  const bodyRows = sh.body(84, 22);
  if (classic) {
    for (const row of bodyRows) for (const point of row) {
      const alongHood = smoothstep(1.01, 1.48, point.z) * (1 - smoothstep(2.00, 2.075, point.z));
      const crest = 1 - smoothstep(0.22, 0.37, Math.abs(point.x));
      point.y += 0.041 * alongHood * crest * smoothstep(sh.top(point.z) - 0.09, sh.top(point.z), point.y);
    }
  }
  const body = loft(bodyRows, () => 0, true, true);
  b.add(body, 'paint');

  // «аквариум» седана: лобовое, крыша, задняя стойка, багажник отдельно
  const zA = classic ? 0.89 + cabinShift : 1.0, zC = classic ? -1.33 + cabinShift : -1.42;
  const roof = classic
    ? spline([[zC, sh.top(zC)], [-0.87 + cabinShift, 1.42], [-0.76 + cabinShift, 1.45], [0.28 + cabinShift, 1.45], [0.38 + cabinShift, 1.42], [zA, sh.top(zA)]])
    : spline([[zC, sh.top(zC)], [-1.05, 1.24], [-0.6, 1.42], [0.25, 1.44], [0.65, 1.26], [zA, sh.top(zA)]]);
  const GR = 36, GK = 22;
  const angles = Array.from({ length: GK + 1 }, (_, k) => Math.PI * k / GK);
  if (classic) {
    angles.splice(angles.length - 1, 0, Math.PI - 0.001);
    angles.splice(1, 0, 0.001);
  }
  const sOf = angles.map((angle) => Math.sin(angle));
  const gRows: THREE.Vector3[][] = [];
  const cabinStations = Array.from({ length: GR }, (_, r) => zC + ((zA - zC) * r) / (GR - 1));
  if (classic) cabinStations.push(...[rearDoor, middleDoor - 0.026, middleDoor + 0.026, frontDoor].map((z) => z + cabinShift));
  cabinStations.sort((a, b) => a - b);
  for (const z of cabinStations) {
    // Ниже линия стыка с кузовом шире, а профиль крыши остаётся прежним.
    const yb = sh.top(z) - (police || classic ? 0.06 : 0.03), H = Math.max(0, roof(z) - yb);
    const wb = sh.xAt(z, yb) - 0.03;
    const wr = classic ? wb * 0.92 : Math.min(wb, 0.7);
    const ring: THREE.Vector3[] = [];
    for (const angle of angles) {
      const phi = Math.PI - angle;
      const s = Math.sin(phi), c = Math.cos(phi);
      const height = Math.pow(s, classic ? 0.28 : 2 / 3.4);
      const a = wb + (wr - wb) * Math.min(1, (classic ? height : s) * 1.1);
      ring.push(new THREE.Vector3(Math.sign(c) * a * Math.pow(Math.abs(c), classic ? 0.28 : 2 / 2.4), yb + H * height, z));
    }
    gRows.push(ring);
  }
  const gh = loft(gRows, (p, _r, c) => {
    const s = (sOf[c] + sOf[c + 1]) / 2, z = p.z - cabinShift;
    if (classic) {
      if (s < 0.001) return 0;
      if ((z > 0.38 && s > 0.58) || (z < -0.90 && s > 0.67)) return 1;
      const height = clamp((p.y - 1.02) / 0.40, 0, 1);
      if (s > 0.79 || z < rearDoor + 0.12 * height || z > frontDoor - 0.24 * height) return 0;
      return Math.abs(z - middleDoor) < 0.026 ? 2 : 1;
    }
    if (s < 0.07) return 2;
    if (z > 0.45) return s > 0.6 && s < 0.74 ? 0 : 1;
    if (z > -0.8) {
      if (s > 0.78) return 0;
      if (Math.abs(z + 0.15) < 0.04 || (limo && Math.abs(z + 0.53) < 0.035)) return 2;
      return 1;
    }
    if (s > 0.4 && s < 0.86) return 0;
    return 1;
  }, false, false);
  b.addGroups(gh, ['paint', 'glass', 'black']);
  b.box(1.16, 0.44, 3.5, 'black', { x: 0, y: 0.47, z: 0 });

  // Накладки повторяют поверхность кузова, включая закругления к крыльям.
  const projectionMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const shell = new THREE.Mesh(body, projectionMaterial);
  const ray = new THREE.Raycaster();
  const panel = (w: number, h: number, x: number, y: number, end: 1 | -1, offset: number) => {
    const geometry = new THREE.PlaneGeometry(w, h, Math.ceil(w / 0.02), Math.ceil(h / 0.02));
    if (end < 0) geometry.rotateY(Math.PI);
    const points = geometry.getAttribute('position');
    ray.ray.direction.set(0, 0, -end);
    for (let i = 0; i < points.count; i++) {
      const px = x + points.getX(i), py = y + points.getY(i);
      ray.ray.origin.set(px, py, end * 3);
      const hit = ray.intersectObject(shell, false)[0];
      const z = hit?.point.z ?? sh.surfaceZ(px, py, end);
      points.setXYZ(i, px, py, z + end * offset);
    }
    geometry.computeVertexNormals();
    return geometry;
  };

  const tail = new Builder(), bl = new Builder(), br = new Builder();
  if (classic) {
    b.add(panel(0.68, 0.298, 0, 0.771, 1, 0.025), 'chrome');
    b.add(panel(0.625, 0.247, 0, 0.771, 1, 0.035), 'black');
    for (const y of [0.669, 0.706, 0.743, 0.780, 0.817, 0.854]) {
      b.add(panel(0.59, 0.010, 0, y, 1, 0.042), 'chrome');
    }
    b.add(panel(0.49, 0.15, 0, 0.673, -1, 0.012), 'black');

    for (const end of [-1, 1] as const) {
      b.add(panel(1.50, 0.11, 0, 0.475, end, 0.021), 'black');
      b.add(panel(1.38, 0.023, 0, 0.515, end, 0.031), 'chrome');
    }
    for (const side of [-1, 1]) {
      b.add(panel(0.34, 0.21, side * 0.51, 0.738, 1, 0.018), 'black');
      b.add(panel(0.227, 0.161, side * 0.478, 0.744, 1, 0.028), 'head');
      for (const x of [0.425, 0.478, 0.531]) {
        b.add(panel(0.004, 0.151, side * x, 0.744, 1, 0.033), 'chrome');
      }
      b.add(panel(0.048, 0.166, side * 0.637, 0.744, 1, 0.028), 'beacon');
      b.add(panel(0.37, 0.16, side * 0.51, 0.72, -1, 0.018), 'black');
      tail.add(panel(0.30, 0.055, side * 0.51, 0.757, -1, 0.026), 'head');
      (side > 0 ? bl : br).add(panel(0.13, 0.043, side * 0.59, 0.69, -1, 0.026), 'head');
      b.add(panel(0.12, 0.043, side * 0.445, 0.69, -1, 0.026), 'chrome');
      const sidePoint = (y: number, z: number, lift: number) => {
        ray.ray.origin.set(side * 2, y, z);
        ray.ray.direction.set(-side, 0, 0);
        const x = ray.intersectObject(shell, false)[0]?.point.x ?? side * sh.xAt(z, y);
        return new THREE.Vector3(x + side * lift, y, z);
      };
      const trim = Array.from({ length: 19 }, (_, i) => sidePoint(0.735, -1.74 + i * 3.48 / 18, 0.008));
      b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trim), 36, 0.008, 6, false), 'black');
      const rearDoorBottom = -0.80;
      const sill = sh.base(0) + 0.028;
      const addDoorSeam = (points: THREE.Vector3[]) => {
        b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, 0.0035, 5, false), 'black');
      };
      for (const [topZ, bottomZ] of [[rearDoor, rearDoorBottom], [middleDoor, middleDoor], [frontDoor, frontDoor]]) {
        const belt = sh.top(topZ + cabinShift) - 0.049;
        const points = Array.from({ length: 17 }, (_, i) => {
          const y = sill + (belt - sill) * i / 16;
          const z = topZ + (bottomZ - topZ) * (1 - smoothstep(0.48, 0.73, y));
          return sidePoint(y, z + cabinShift, 0.004);
        });
        addDoorSeam(points);
      }
      addDoorSeam(Array.from({ length: 17 }, (_, i) => sidePoint(sill, cabinShift + rearDoorBottom + (frontDoor - rearDoorBottom) * i / 16, 0.004)));
      b.add(new DecalGeometry(shell, new THREE.Vector3(side * 0.81, 0.565, 0.215 + cabinShift),
        new THREE.Euler(0, side * Math.PI / 2, 0), new THREE.Vector3(0.31, 0.31, 0.18)), 'logo');
      b.box(0.025, 0.032, 0.067, 'beacon', sidePoint(0.825, 1.01 + cabinShift, 0.006), 0.006);
      for (const z of [-0.72 + cabinShift, 0.05 + cabinShift]) {
        const y = sh.top(z) - 0.15, x = side * (sh.xAt(z, y) + 0.005);
        b.box(0.028, 0.023, 0.095, 'chrome', { x, y, z }, 0.008);
      }
      const y = 1.04, z = 0.6 + cabinShift;
      b.box(0.16, 0.09, 0.075, 'black', { x: side * 0.82, y, z }, 0.018);
      b.box(0.13, 0.068, 0.009, 'chrome', { x: side * 0.82, y, z: z - 0.04 });
    }
    b.add(panel(0.39, 0.10, 0, 0.675, -1, 0.022), 'plate');
  } else {
    b.add(panel(0.98, 0.10, 0, 0.43, 1, 0.014), 'black');
    b.add(panel(0.82, 0.018, 0, 0.448, 1, 0.024), 'chrome');
    for (const side of [-1, 1]) {
      b.add(panel(0.30, 0.085, side * 0.56, 0.64, 1, 0.014), 'black');
      b.add(panel(0.22, 0.025, side * 0.56, 0.644, 1, 0.024), 'head');

      b.add(panel(0.30, 0.09, side * 0.55, 0.81, -1, 0.014), 'black');
      tail.add(panel(0.18, 0.038, side * 0.515, 0.812, -1, 0.024), 'head');
      (side > 0 ? bl : br).add(panel(0.05, 0.038, side * 0.66, 0.812, -1, 0.024), 'head');

      if (limo) {
        for (const z of [-0.73, -0.34, 0.13]) {
          const y = sh.top(z) - 0.16;
          const x = side * (sh.xAt(z, y) + 0.009);
          b.box(0.027, 0.026, 0.083, 'chrome', { x, y, z }, 0.008);
        }
      }

      const mz = 0.82, my = sh.top(mz) + 0.08, mx = sh.xAt(mz, sh.top(mz) - 0.05) + 0.05;
      b.box(0.12, 0.09, 0.06, 'paint', { x: side * mx, y: my, z: mz }, 0.02);
      b.box(0.09, 0.07, 0.01, 'chrome', { x: side * mx, y: my, z: mz - 0.035 });
    }
    b.add(panel(0.52, 0.112, 0, 0.55, -1, 0.016), 'plate');
  }
  if (police) {
    // Полоса повторяет изгиб бортов и остаётся на кузове у колёсных арок.
    for (const side of [-1, 1]) {
      const stripe = new DecalGeometry(
        shell,
        new THREE.Vector3(side * 0.55, 0.75, 0.05),
        new THREE.Euler(0, side * Math.PI / 2, 0),
        new THREE.Vector3(3.24, 0.14, 0.95),
      );
      b.add(stripe, 'logo');
    }
  }
  projectionMaterial.dispose();
  const wheelR = sh.d.wheelR;
  const axles = sh.d.axles.map((z) => ({ z, y: wheelR, ...axleGeometry(wheelR, classic ? 0.19 : 0.2, classic ? 0.18 : 0.22, classic ? 0.68 : 0.76, false) }));
  const parts = b.build(), tailGeo = tail.build().get('head')!;
  const blinkL = bl.build().get('head')!, blinkR = br.build().get('head')!;
  if (limo) {
    // Удлиняем салон на два метра, сохраняя пропорции торцов и колёс.
    const stretch = (z: number) => clamp((z + 1.08) / 1.73, 0, 1);
    const stretchedZ = (z: number, t: number) => z + 2 * t * t * (3 - 2 * t) - 1;
    const normal = new THREE.Vector3();
    for (const geometry of [...parts.values(), tailGeo, blinkL, blinkR]) {
      const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
      for (let i = 0; i < positions.count; i++) {
        const z = positions.getZ(i), t = stretch(z);
        positions.setZ(i, stretchedZ(z, t));
        normal.fromBufferAttribute(normals, i);
        normal.z /= 1 + 12 * t * (1 - t) / 1.73;
        normal.normalize();
        normals.setXYZ(i, normal.x, normal.y, normal.z);
      }
      geometry.computeBoundingSphere();
    }
    for (const axle of axles) axle.z = stretchedZ(axle.z, stretch(axle.z));
  }
  return {
    kind: police ? 'sedan' : variant, length: limo ? 6.6 : sh.d.halfLen * 2, width: classic ? 1.65 : 1.8,
    parts, wheelR, axles, tail: tailGeo, blinkL, blinkR,
  };
}

function buildKedrTraffic(): TrafficTemplate {
  const config = (cars as CarConfig[]).find((car) => car.id === 'kedr')!;
  const car = buildKedr(config);
  const body = new Map<THREE.Material, Builder>();
  car.root.updateMatrixWorld(true);
  car.body.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry.clone() as THREE.BufferGeometry;
    geometry.applyMatrix4(object.matrixWorld);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const add = (part: THREE.BufferGeometry, material: THREE.Material) => {
      let builder = body.get(material);
      if (!builder) { builder = new Builder(); body.set(material, builder); }
      builder.add(part, 'plate');
    };
    if (!Array.isArray(object.material)) add(geometry, materials[0]);
    else {
      for (const group of geometry.groups) {
        const part = geometry.clone();
        part.setIndex(Array.from(geometry.index!.array.slice(group.start, group.start + group.count)));
        add(part, materials[group.materialIndex ?? 0]);
      }
    }
  });
  const details = [...body].filter(([material]) => material !== car.tailMat).map(([material, builder]) => ({
    material, geometry: builder.build().get('plate')!,
  }));
  const tail = body.get(car.tailMat)!.build().get('plate')!;
  const noBlink = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  const axles = car.wheels.filter((wheel) => wheel.steer.position.x > 0).map(({ steer }) => ({
    z: steer.position.z, y: steer.position.y,
    ...axleGeometry(car.wheelR, 0.21, 0.19, steer.position.x, false),
  }));
  return {
    kind: 'kedr', length: car.length, width: car.width, wheelR: car.wheelR, axles,
    parts: new Map(), details, tail, blinkL: noBlink, blinkR: noBlink,
  };
}

/** Минивэн в трафике: та же форма, что у «Простора 7», но проще — без рейлингов и спойлера, фонари горизонтальные. */
function buildVanTraffic(): TrafficTemplate {
  const sh = vanShape();
  const b = new Builder();
  b.addGroups(loft(sh.body(84, 22), vanBodyClassify(sh), true, true), ['paint', 'black']);
  const gh = vanGreenhouse(sh, 60, 22);
  b.addGroups(loft(gh.rows, gh.classify, false, false), ['paint', 'glass', 'black']);
  b.box(1.38, 0.48, 3.9, 'black', { x: 0, y: 0.5, z: -0.05 });
  for (const side of [-1, 1]) {
    // фары: блок со стеклом и светящейся полосой
    const y = 0.78, x = 0.66, z = sh.surfaceZ(x, y, 1);
    b.box(0.36, 0.12, 0.12, 'glass', { x: side * x, y, z: z - 0.04 }, 0.035, new THREE.Euler(0, side * 0.4, 0));
    b.box(0.24, 0.03, 0.06, 'head', { x: side * (x - 0.02), y: y + 0.02, z: z - 0.005 }, 0.012, new THREE.Euler(0, side * 0.4, 0));
    // зеркала
    const mz = 1.18, my = sh.top(mz) + 0.07, mx = sh.xAt(mz, sh.top(mz) - 0.04) + 0.05;
    b.box(0.14, 0.1, 0.08, 'paint', { x: side * mx, y: my, z: mz }, 0.025);
    b.box(0.11, 0.08, 0.01, 'chrome', { x: side * mx, y: my, z: mz - 0.045 });
  }
  b.box(0.8, 0.03, 0.04, 'chrome', { x: 0, y: 0.7, z: sh.surfaceZ(0.4, 0.7, 1) + 0.01 });
  const tail = new Builder(), bl = new Builder(), br = new Builder();
  for (const side of [-1, 1]) {
    const y = 0.92, x = 0.62, z = sh.surfaceZ(x, y, -1);
    b.box(0.5, 0.13, 0.06, 'glass', { x: side * x, y, z: z + 0.015 }, 0.025);
    tail.box(0.34, 0.06, 0.04, 'head', { x: side * (x - 0.04), y: y + 0.015, z: z - 0.01 }, 0.012);
    (side > 0 ? bl : br).box(0.1, 0.05, 0.04, 'head', { x: side * (x + 0.17), y: y - 0.02, z: z - 0.008 }, 0.01);
  }
  const pz = sh.surfaceZ(0.27, 0.8, -1);
  b.box(0.52, 0.112, 0.012, 'plate', { x: 0, y: 0.8, z: pz - 0.008 }, 0, new THREE.Euler(0, Math.PI, 0));
  const axles = [VAN.axF, VAN.axR].map((z) => ({ z, y: VAN.R, ...axleGeometry(VAN.R, 0.22, 0.22, VAN.track, false) }));
  return {
    kind: 'van', length: 4.8, width: 1.9, parts: b.build(), wheelR: VAN.R, axles,
    tail: tail.build().get('head')!, blinkL: bl.build().get('head')!, blinkR: br.build().get('head')!,
  };
}

function buildTruck(): TrafficTemplate {
  const b = new Builder();
  const cabZ0 = 2.05, cabZ1 = 4.1, cabW = 2.36;
  const cz = (cabZ0 + cabZ1) / 2, cd = cabZ1 - cabZ0;
  // кабина
  b.box(cabW, 2.2, cd, 'paint', { x: 0, y: 2.12, z: cz }, 0.14);
  b.box(cabW - 0.04, 0.5, cd - 0.1, 'paint', { x: 0, y: 1.05, z: cz + 0.02 }, 0.06);
  // обтекатель над кабиной
  b.box(2.3, 0.55, 1.5, 'paint', { x: 0, y: 3.42, z: 2.95 }, 0.12, new THREE.Euler(0.32, 0, 0));
  // лобовое стекло и боковые окна
  b.box(2.08, 0.92, 0.04, 'glass', { x: 0, y: 2.62, z: cabZ1 + 0.005 }, 0.02);
  for (const side of [-1, 1]) {
    b.box(0.04, 0.78, 1.0, 'glass', { x: side * (cabW / 2 + 0.003), y: 2.58, z: 3.5 }, 0.01);
    b.box(0.03, 1.2, 0.02, 'black', { x: side * (cabW / 2 + 0.006), y: 1.75, z: 2.95 });  // зазор двери
    b.box(0.05, 0.04, 0.22, 'chrome', { x: side * (cabW / 2 + 0.02), y: 1.95, z: 2.75 });  // ручка
    // зеркала на кронштейнах
    b.box(0.32, 0.04, 0.04, 'black', { x: side * (cabW / 2 + 0.15), y: 2.75, z: 3.95 });
    b.box(0.08, 0.5, 0.18, 'black', { x: side * (cabW / 2 + 0.3), y: 2.6, z: 3.95 }, 0.03);
    b.box(0.06, 0.44, 0.01, 'chrome', { x: side * (cabW / 2 + 0.3), y: 2.6, z: 3.855 });
    // подножки и крылья передних колёс
    b.box(0.3, 0.05, 0.6, 'grey', { x: side * 1.05, y: 0.62, z: 2.6 });
    b.box(0.32, 0.06, 1.25, 'black', { x: side * 1.06, y: 1.07, z: 3.05 }, 0.03);
    // фары
    b.box(0.42, 0.24, 0.06, 'glass', { x: side * 0.86, y: 1.2, z: cabZ1 + 0.02 }, 0.04);
    b.box(0.3, 0.06, 0.04, 'head', { x: side * 0.86, y: 1.25, z: cabZ1 + 0.05 }, 0.02);
  }
  // решётка с хромовыми полосами и бампер
  b.box(1.5, 0.62, 0.04, 'black', { x: 0, y: 1.62, z: cabZ1 + 0.01 }, 0.02);
  for (let i = 0; i < 5; i++) b.box(1.42, 0.025, 0.03, 'chrome', { x: 0, y: 1.38 + i * 0.12, z: cabZ1 + 0.035 });
  b.box(2.42, 0.36, 0.28, 'grey', { x: 0, y: 0.82, z: cabZ1 - 0.02 }, 0.06);
  // рама, бак, ящики
  b.box(1.0, 0.28, 8.0, 'black', { x: 0, y: 0.72, z: 0 });
  const tank = new THREE.CylinderGeometry(0.3, 0.3, 1.1, 20);
  tank.rotateX(Math.PI / 2);
  b.add(tank, 'chrome', { x: 0.92, y: 0.8, z: 1.15 });
  b.box(0.5, 0.45, 0.8, 'black', { x: -0.95, y: 0.82, z: 1.2 }, 0.03);
  // фургон
  const boxZ0 = -4.1, boxZ1 = 1.88, boxW = 2.5, boxY0 = 1.08, boxH = 2.72;
  b.box(boxW, boxH, boxZ1 - boxZ0, 'paint2', { x: 0, y: boxY0 + boxH / 2, z: (boxZ0 + boxZ1) / 2 }, 0.05);
  b.box(boxW + 0.02, 0.12, boxZ1 - boxZ0 + 0.02, 'grey', { x: 0, y: boxY0 + 0.04, z: (boxZ0 + boxZ1) / 2 });
  b.box(boxW + 0.02, 0.06, boxZ1 - boxZ0 + 0.02, 'grey', { x: 0, y: boxY0 + boxH - 0.03, z: (boxZ0 + boxZ1) / 2 });
  // логотип перевозчика по бортам
  const logo = new THREE.PlaneGeometry(4.6, 1.15);
  b.add(logo, 'logo', { x: boxW / 2 + 0.004, y: 2.5, z: -1.2 }, new THREE.Euler(0, Math.PI / 2, 0));
  b.add(logo, 'logo', { x: -boxW / 2 - 0.004, y: 2.5, z: -1.2 }, new THREE.Euler(0, -Math.PI / 2, 0));
  // задние двери: две створки, запорные штанги, петли
  const rz = boxZ0 - 0.012;
  for (const side of [-1, 1]) {
    b.box(1.21, 2.56, 0.03, 'paint2', { x: side * 0.615, y: boxY0 + boxH / 2, z: rz });
    for (const x of [0.28, 0.98]) {
      const bar = new THREE.CylinderGeometry(0.018, 0.018, 2.5, 8);
      b.add(bar, 'chrome', { x: side * x, y: boxY0 + boxH / 2, z: rz - 0.04 });
      b.box(0.08, 0.05, 0.05, 'chrome', { x: side * x, y: boxY0 + 0.25, z: rz - 0.04 });
      b.box(0.08, 0.05, 0.05, 'chrome', { x: side * x, y: boxY0 + boxH - 0.25, z: rz - 0.04 });
    }
    for (const y of [0.5, 1.35, 2.2]) b.box(0.12, 0.08, 0.05, 'grey', { x: side * 1.2, y: boxY0 + y, z: rz - 0.02 });
    b.box(0.2, 0.05, 0.05, 'grey', { x: side * 0.4, y: boxY0 + 1.3, z: rz - 0.045 }); // ручки
  }
  b.box(0.015, 2.56, 0.035, 'black', { x: 0, y: boxY0 + boxH / 2, z: rz - 0.005 });
  // светоотражающая полоса и противоподкатный брус
  b.add(new THREE.PlaneGeometry(2.42, 0.1), 'chevron', { x: 0, y: boxY0 + 0.16, z: rz - 0.03 }, new THREE.Euler(0, Math.PI, 0));
  b.box(2.3, 0.14, 0.12, 'grey', { x: 0, y: 0.52, z: boxZ0 + 0.05 });
  b.add(new THREE.PlaneGeometry(2.28, 0.1), 'chevron', { x: 0, y: 0.52, z: boxZ0 - 0.012 }, new THREE.Euler(0, Math.PI, 0));
  for (const side of [-1, 1]) {
    b.box(0.6, 0.55, 0.02, 'black', { x: side * 0.98, y: 0.48, z: -3.1 });  // брызговики
    b.box(0.06, 0.6, 0.06, 'black', { x: side * 0.95, y: 0.8, z: boxZ0 + 0.1 }); // кронштейны фонарей
    b.box(0.5, 0.16, 0.08, 'black', { x: side * 0.95, y: 0.86, z: boxZ0 - 0.0 }, 0.02);
    b.box(0.32, 0.18, 0.4, 'black', { x: side * 1.05, y: 1.0, z: -2.3 }); // крылья задних колёс
  }
  b.box(0.52, 0.112, 0.012, 'plate', { x: 0, y: 0.82, z: boxZ0 - 0.03 }, 0, new THREE.Euler(0, Math.PI, 0));
  const tail = new Builder(), bl = new Builder(), br = new Builder();
  for (const side of [-1, 1]) {
    tail.box(0.18, 0.1, 0.03, 'head', { x: side * 0.86, y: 0.86, z: boxZ0 - 0.05 }, 0.01);
    (side > 0 ? bl : br).box(0.12, 0.1, 0.03, 'head', { x: side * 1.1, y: 0.86, z: boxZ0 - 0.05 }, 0.01);
    // габаритные огни по верхним углам фургона
    tail.box(0.1, 0.06, 0.03, 'head', { x: side * 1.12, y: boxY0 + boxH - 0.12, z: rz - 0.03 }, 0.01);
  }
  const axles = [
    { z: 3.05, y: 0.5, ...axleGeometry(0.5, 0.3, 0.3, 0.95, false) },
    { z: -2.3, y: 0.5, ...axleGeometry(0.5, 0.3, 0.27, 0.8, true) },
  ];
  return {
    kind: 'truck', length: 8.25, width: 2.5, parts: b.build(), wheelR: 0.5, axles,
    tail: tail.build().get('head')!, blinkL: bl.build().get('head')!, blinkR: br.build().get('head')!,
  };
}

/** Эвакуатор со сдвижной платформой, лебёдкой и жёлтым маячком. */
function buildTow(): TrafficTemplate {
  const b = new Builder();
  const cabZ = 2.03, cabFront = 2.95, rear = -3.2;
  b.box(1.0, 0.26, 5.9, 'black', { x: 0, y: 0.64, z: -0.1 });
  b.box(2.08, 1.56, 1.82, 'paint', { x: 0, y: 1.62, z: cabZ }, 0.13);
  b.box(1.83, 0.65, 0.04, 'glass', { x: 0, y: 1.91, z: cabFront }, 0.02);
  b.box(2.14, 0.24, 0.23, 'black', { x: 0, y: 0.86, z: cabFront - 0.01 }, 0.06);
  b.box(1.25, 0.23, 0.04, 'black', { x: 0, y: 1.17, z: cabFront + 0.012 }, 0.02);
  for (const y of [1.11, 1.18, 1.25]) {
    b.box(1.12, 0.018, 0.024, 'chrome', { x: 0, y, z: cabFront + 0.036 });
  }

  const deckY = 1.03, deckZ = -0.76;
  b.box(2.22, 0.16, 3.38, 'grey', { x: 0, y: deckY, z: deckZ }, 0.04);
  b.box(2.20, 0.14, 0.81, 'grey', { x: 0, y: 0.93, z: -2.84 }, 0.035, new THREE.Euler(-0.25, 0, 0));
  for (const side of [-1, 1]) {
    b.box(0.042, 0.52, 0.93, 'glass', { x: side * 1.035, y: 1.91, z: 2.38 }, 0.015);
    b.box(0.05, 0.04, 0.18, 'grey', { x: side * 1.043, y: 1.50, z: 1.98 }, 0.012);
    b.box(0.24, 0.04, 0.04, 'black', { x: side * 1.10, y: 1.95, z: 2.76 });
    b.box(0.09, 0.27, 0.16, 'black', { x: side * 1.24, y: 1.88, z: 2.76 }, 0.03);
    b.box(0.27, 0.12, 0.035, 'head', { x: side * 0.83, y: 1.17, z: cabFront + 0.02 }, 0.015);
    b.box(0.56, 0.033, 3.2, 'black', { x: side * 0.68, y: deckY + 0.09, z: deckZ });
    for (let i = 0; i < 10; i++) {
      b.box(0.53, 0.016, 0.035, 'grey', { x: side * 0.68, y: deckY + 0.106, z: 0.64 - i * 0.31 });
    }
    b.box(0.045, 0.08, 3.32, 'paint', { x: side * 1.105, y: deckY, z: deckZ });
    b.box(0.55, 0.33, 0.025, 'black', { x: side * 0.85, y: 0.54, z: -2.24 });
  }

  b.box(2.10, 0.47, 0.10, 'black', { x: 0, y: 1.29, z: 0.93 }, 0.045);
  b.add(new THREE.CylinderGeometry(0.09, 0.09, 0.33, 12).rotateZ(Math.PI / 2),
    'chrome', { x: 0, y: deckY + 0.19, z: 0.78 });
  b.box(0.87, 0.055, 0.22, 'black', { x: 0, y: 2.42, z: 1.93 }, 0.02);
  b.box(0.81, 0.11, 0.19, 'beacon', { x: 0, y: 2.49, z: 1.93 }, 0.045);

  b.box(2.12, 0.18, 0.13, 'black', { x: 0, y: 0.67, z: rear });
  b.add(new THREE.PlaneGeometry(2.04, 0.08), 'chevron', { x: 0, y: 0.84, z: rear - 0.056 }, new THREE.Euler(0, Math.PI, 0));
  b.box(0.52, 0.112, 0.012, 'plate', { x: 0, y: 0.66, z: rear - 0.071 }, 0, new THREE.Euler(0, Math.PI, 0));

  const tail = new Builder(), bl = new Builder(), br = new Builder();
  for (const side of [-1, 1]) {
    tail.box(0.22, 0.075, 0.025, 'head', { x: side * 0.79, y: 0.68, z: rear - 0.07 }, 0.01);
    (side > 0 ? bl : br).box(0.092, 0.075, 0.025, 'head', { x: side * 0.96, y: 0.68, z: rear - 0.07 }, 0.01);
  }
  const wheelR = 0.39;
  const axles = [
    { z: 1.82, y: wheelR, ...axleGeometry(wheelR, 0.23, 0.21, 0.87, false) },
    { z: -1.62, y: wheelR, ...axleGeometry(wheelR, 0.23, 0.19, 0.82, true) },
  ];
  return {
    kind: 'tow', length: 6.55, width: 2.3, parts: b.build(), wheelR, axles,
    tail: tail.build().get('head')!, blinkL: bl.build().get('head')!, blinkR: br.build().get('head')!,
  };
}

// ——— материалы (общие для всех машин) ———
function logoTexture(name: string, accent: string) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 1024, 256);
  g.fillStyle = accent;
  g.fillRect(0, 200, 1024, 22);
  g.fillRect(0, 232, 1024, 8);
  g.font = 'italic 800 132px "Arial Black", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillStyle = accent;
  g.fillText(name, 30, 100);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function chevronTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, 0, 512, 32);
  g.fillStyle = '#c4101a';
  for (let x = -32; x < 544; x += 48) {
    g.beginPath();
    g.moveTo(x, 32); g.lineTo(x + 24, 32); g.lineTo(x + 56, 0); g.lineTo(x + 32, 0);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SEDAN_COLORS: [string, number][] = [
  ['#e9e9e6', 4], ['#b8bcc2', 4], ['#1a1b1e', 3], ['#5a5f66', 3], ['#1d2c4a', 2], ['#7d1218', 1.5], ['#c9b89a', 1], ['#2f4a3a', 1], ['#d0d4d8', 2],
];
const CLASSIC_COLORS = SEDAN_COLORS.filter(([color]) => color !== '#e9e9e6');
const CAB_COLORS: [string, number][] = [['#f0f0ee', 3], ['#b3171c', 2], ['#1f4f9c', 2], ['#e07a12', 1], ['#2b2e33', 1]];
const BRANDS: [string, string][] = [['ТРАНЗИТ-7', '#1f4f9c'], ['ВЕКТОР', '#c4101a'], ['СЕВЕРНЫЙ ПУТЬ', '#16723a'], ['', '#888']];

let classicTemplate: TrafficTemplate | undefined;

export class TrafficAssets {
  private sedanTemplate?: TrafficTemplate;
  private policeSedan?: TrafficTemplate;
  private limoTemplate?: TrafficTemplate;
  private truckTemplate?: TrafficTemplate;
  private vanTemplate?: TrafficTemplate;
  private towTemplate?: TrafficTemplate;
  private kedrTemplate?: TrafficTemplate;
  get kedr() { return this.kedrTemplate ??= buildKedrTraffic(); }
  get sedan() { return this.sedanTemplate ??= buildSedan(); }
  get classic() { return classicTemplate ??= buildSedan('classic'); }
  get limo() { return this.limoTemplate ??= buildSedan('limo'); }
  get truck() { return this.truckTemplate ??= buildTruck(); }
  get van() { return this.vanTemplate ??= buildVanTraffic(); }
  get tow() { return this.towTemplate ??= buildTow(); }
  private paints = new Map<string, THREE.MeshPhysicalMaterial>();
  readonly mats: Record<Exclude<MatKey, 'paint' | 'paint2' | 'logo' | 'plate' | 'wood'>, THREE.Material>;
  readonly tailOff = new THREE.MeshStandardMaterial({ color: 0x3a0000, emissive: 0xff1a12, emissiveIntensity: 1.6, roughness: 0.3 });
  readonly tailOn = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff1a12, emissiveIntensity: 7, roughness: 0.3 });
  readonly blinkOff = new THREE.MeshStandardMaterial({ color: 0x4a2a00, emissive: 0xff8a00, emissiveIntensity: 0.05, roughness: 0.3 });
  readonly blinkOn = new THREE.MeshStandardMaterial({ color: 0x6a3a00, emissive: 0xff9a10, emissiveIntensity: 6, roughness: 0.3 });
  readonly logos: THREE.Material[];
  readonly plates: THREE.Material[];
  private rnd = mulberry32(99);

  constructor() {
    this.mats = {
      glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1218, roughness: 0.04, metalness: 0.1, clearcoat: 1, envMapIntensity: 1.4 }),
      black: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.6 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xdfe2e6, metalness: 1, roughness: 0.18 }),
      grey: new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.5, roughness: 0.5 }),
      beacon: new THREE.MeshStandardMaterial({ color: 0xff9c20, emissive: 0xff9a10, emissiveIntensity: 1.5, roughness: 0.28 }),
      head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf2f5ff, emissiveIntensity: 2.2, roughness: 0.2 }),
      chevron: new THREE.MeshStandardMaterial({ map: chevronTexture(), roughness: 0.35, emissive: 0xffffff, emissiveIntensity: 0.08 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.88 }),
      rim: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.9, roughness: 0.3 }),
    };
    (this.mats.chevron as THREE.MeshStandardMaterial).emissiveMap = (this.mats.chevron as THREE.MeshStandardMaterial).map;
    this.logos = BRANDS.map(([n, a]) => n
      ? new THREE.MeshStandardMaterial({ map: logoTexture(n, a), transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 })
      : new THREE.MeshStandardMaterial({ visible: false }));
    this.plates = ['ВРТ 214', 'КМН 508', 'СЕВ 731', 'ТРН 066', 'ОКА 390'].map((t) =>
      new THREE.MeshStandardMaterial({ map: makePlateTexture(t), roughness: 0.4 }));
  }

  private pick(list: [string, number][]) {
    const total = list.reduce((a, [, w]) => a + w, 0);
    let r = this.rnd() * total;
    for (const [c, w] of list) { r -= w; if (r <= 0) return c; }
    return list[0][0];
  }

  paint(color: string) {
    let m = this.paints.get(color);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), metalness: 0.4, roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.06 });
      this.paints.set(color, m);
    }
    return m;
  }

  /** Патрульная машина ДПС: седан в белой окраске, синяя полоса с надписью, мигалка; рядом инспектор. */
  createPolice() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#1f4fae'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff'; g.font = '900 48px "Arial Black", Arial'; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillText('ДПС', c.width / 2, c.height / 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    const stripe = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const vis = this.createVisual(this.policeSedan ??= buildSedan('police'), stripe);
    // мигалка: основание и два светящихся блока (красный/синий)
    const bar = new THREE.Mesh(new RoundedBoxGeometry(1.0, 0.08, 0.26, 2, 0.03), this.mats.black);
    bar.position.set(0, 1.48, -0.15);
    vis.body.add(bar);
    const red = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2010, emissiveIntensity: 0.2 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x000a40, emissive: 0x2050ff, emissiveIntensity: 0.2 });
    for (const [x, m] of [[-0.25, red], [0.25, blue]] as const) {
      const l = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.1, 0.22, 2, 0.04), m);
      l.position.set(x, 1.55, -0.15);
      vis.body.add(l);
    }
    // Инспектор находится за машиной, в пределах ширины обочины.
    const man = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2630, roughness: 0.8 });
    const vest = new THREE.MeshStandardMaterial({ color: 0xc8f03a, emissive: 0x4a6a00, emissiveIntensity: 0.4, roughness: 0.6 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a782, roughness: 0.7 });
    const part = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rz = 0) => {
      const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); mesh.rotation.z = rz; mesh.castShadow = true; man.add(mesh);
    };
    for (const x of [-0.1, 0.1]) part(new THREE.CapsuleGeometry(0.07, 0.75, 4, 8), dark, x, 0.45, 0);
    part(new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), vest, 0, 1.15, 0);
    part(new THREE.CapsuleGeometry(0.055, 0.5, 4, 8), dark, -0.27, 1.12, 0, 0.12);
    part(new THREE.CapsuleGeometry(0.055, 0.45, 4, 8), dark, 0.3, 1.3, 0.1, -1.2);       // поднятая рука с жезлом
    part(new THREE.CylinderGeometry(0.022, 0.022, 0.45, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x880000, emissiveIntensity: 0.6 }), 0.62, 1.5, 0.1, -0.9);
    part(new THREE.SphereGeometry(0.12, 14, 10), skin, 0, 1.58, 0);
    part(new THREE.CylinderGeometry(0.15, 0.13, 0.08, 16), dark, 0, 1.7, 0.02);       // фуражка
    man.position.set(0.28, 0, -3.5);
    man.rotation.y = -0.6;
    vis.root.add(man);
    return { vis, red, blue };
  }

  /** Новый экземпляр машины трафика. */
  create(kind: TrafficKind): TrafficVisual {
    return this.createVisual(this[kind]);
  }

  createClassicPlayer(config: CarConfig): CarModel {
    const paint = this.paint(config.color).clone();
    const setStripes = applyInsuranceStripes(paint);
    const plate = new THREE.MeshStandardMaterial({ map: makePlateTexture(config.plate), roughness: 0.4 });
    const livery = new THREE.MeshStandardMaterial({
      map: brandTextures().mark, transparent: true, depthWrite: false, roughness: 0.3,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, visible: false,
    });
    const { root, body, tail, template } = this.createVisual(this.classic, undefined, { paint, player: { plate, livery } });
    root.name = 'car';
    const { length, width, wheelR } = template;
    const wheels = [-1, 1].flatMap((side) => {
      const { rubber, rim } = axleGeometry(wheelR, 0.19, 0.18, 0, false, [side]);
      return template.axles.map(({ z, y }) => {
        const steer = new THREE.Group(), spin = new THREE.Group();
        steer.position.set(side * 0.68, y, z);
        const tire = new THREE.Mesh(rubber, this.mats.rubber);
        tire.castShadow = true;
        spin.add(tire, new THREE.Mesh(rim, this.mats.rim));
        steer.add(spin);
        root.add(steer);
        return { steer, spin, front: z > 0 };
      });
    });
    const tailMat = this.tailOff.clone();
    tail.material = tailMat;
    const headMat = (this.mats.head as THREE.MeshStandardMaterial).clone();
    for (const part of body.children) {
      if (part instanceof THREE.Mesh && part.material === this.mats.head) part.material = headMat;
    }
    return {
      root, body, wheels, paint, tailMat, headMat, length, width, wheelR,
      setBrake(on) { tailMat.emissiveIntensity = 1.6 + on * 5.4; },
      setHeadlights(on) { headMat.emissiveIntensity = 2.2 + on * 3; },
      setLivery(on) { setStripes(on); livery.visible = on; },
    };
  }

  createPrototype<K extends string>(template: TrafficTemplate<K>, colors: [string, number][], options: {
    secondary?: THREE.Material; wood?: THREE.Material; wheelsOnBody?: boolean;
  }) {
    return this.createVisual(template, undefined, { ...options, colors });
  }

  private createVisual<K extends string>(t: TrafficTemplate<K>, policeStripe?: THREE.Material, options?: {
    paint?: THREE.MeshPhysicalMaterial; colors?: [string, number][];
    secondary?: THREE.Material; wood?: THREE.Material; wheelsOnBody?: boolean;
    player?: { plate: THREE.Material; livery: THREE.Material };
  }): TrafficVisual<K> {
    const player = options?.player;
    const kind = t.kind;
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const palette = kind === 'classic' ? CLASSIC_COLORS : kind === 'sedan' || kind === 'van' ? SEDAN_COLORS : CAB_COLORS;
    const color = this.pick(options?.colors ?? palette);
    const paint = options?.paint ?? this.paint(policeStripe ? '#f2f3f1' : kind === 'tow' ? '#f0a51d' : kind === 'limo' ? '#181c24' : color);
    const paint2 = options?.secondary ?? this.paint(this.rnd() < 0.75 ? '#eef0f0' : this.pick([['#b8bcc2', 1], ['#2b4f8a', 1], ['#c9b89a', 1]]));
    const logo = player?.livery ?? this.logos[Math.floor(this.rnd() * this.logos.length)];
    const plate = player?.plate ?? this.plates[Math.floor(this.rnd() * this.plates.length)];
    for (const [k, g] of t.parts) {
      if (k === 'logo' && kind === 'classic' && !player) continue;
      const mat = k === 'paint' ? paint : k === 'paint2' ? paint2 : k === 'logo' ? (policeStripe ?? logo) : k === 'plate' ? plate : k === 'wood' ? options?.wood : this.mats[k];
      if (!mat) continue;
      const m = new THREE.Mesh(g, mat);
      m.castShadow = k !== 'logo' && k !== 'plate' && k !== 'head' && k !== 'beacon' && k !== 'chevron';
      m.receiveShadow = k === 'paint' || k === 'paint2';
      body.add(m);
    }
    for (const detail of t.details ?? []) {
      const mesh = new THREE.Mesh(detail.geometry, detail.material);
      mesh.castShadow = mesh.receiveShadow = true;
      body.add(mesh);
    }
    const tail = new THREE.Mesh(t.tail, this.tailOff);
    const bl = new THREE.Mesh(t.blinkL, this.blinkOff);
    const br = new THREE.Mesh(t.blinkR, this.blinkOff);
    body.add(tail, bl, br);
    const axles = player ? [] : t.axles.map((a) => {
      const g = new THREE.Group();
      g.position.set(0, a.y, a.z);
      const r = new THREE.Mesh(a.rubber, this.mats.rubber);
      r.castShadow = true;
      g.add(r, new THREE.Mesh(a.rim, this.mats.rim));
      (options?.wheelsOnBody ? body : root).add(g);
      return g;
    });
    return { root, body, tail, blinkL: bl, blinkR: br, axles, template: t };
  }
}

export interface TrafficVisual<K extends string = TrafficKind> {
  root: THREE.Group;
  body: THREE.Group;
  tail: THREE.Mesh;
  blinkL: THREE.Mesh;
  blinkR: THREE.Mesh;
  axles: THREE.Group[];
  template: TrafficTemplate<K>;
}
