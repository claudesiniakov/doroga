import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { spline, loft } from './car';
import { clamp, mulberry32 } from './noise';
import { makePlateTexture } from './textures';

/** Ключи материалов: детали модели склеиваются по ним — несколько draw call на машину. */
type MatKey = 'paint' | 'paint2' | 'glass' | 'black' | 'chrome' | 'grey' | 'head' | 'plate' | 'logo' | 'chevron' | 'rubber' | 'rim';
const TEXTURED: MatKey[] = ['plate', 'logo', 'chevron'];

class Builder {
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
function axleGeometry(R: number, rimR: number, W: number, halfTrack: number, dual: boolean) {
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
  for (const side of [-1, 1]) {
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
    let y = this.base(z);
    for (const az of this.d.axles) {
      const dz = z - az;
      if (Math.abs(dz) < this.d.archR) y = Math.max(y, this.d.wheelR + Math.sqrt(this.d.archR ** 2 - dz * dz));
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
    for (let r = 0; r < N; r++) {
      const u = -1 + (2 * r) / (N - 1);
      const z = this.d.halfLen * Math.sin((u * Math.PI) / 2) * 0.9995;
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

export type TrafficKind = 'sedan' | 'truck';

export interface TrafficTemplate {
  kind: TrafficKind;
  length: number;
  width: number;
  parts: Map<MatKey, THREE.BufferGeometry>;
  tail: THREE.BufferGeometry;         // задние фонари (меняют материал при торможении)
  blinkL: THREE.BufferGeometry;
  blinkR: THREE.BufferGeometry;
  axles: { z: number; y: number; rubber: THREE.BufferGeometry; rim: THREE.BufferGeometry }[];
  wheelR: number;
}

function buildSedan(): TrafficTemplate {
  const sh = new Shape({
    halfLen: 2.3,
    top: [[-2.3, 0.72], [-2.26, 0.9], [-2.05, 0.985], [-1.5, 1.0], [-1.0, 0.985], [0, 0.94], [0.9, 0.905], [1.4, 0.865], [1.95, 0.79], [2.2, 0.69], [2.3, 0.5]],
    bottom: [[-2.3, 0.44], [-2.15, 0.31], [-1.8, 0.22], [1.8, 0.21], [2.15, 0.25], [2.3, 0.34]],
    width: [[-2.3, 0.82], [-1.9, 0.885], [-1.3, 0.9], [0, 0.9], [1.4, 0.9], [1.9, 0.87], [2.3, 0.78]],
    planFront: 5, planRear: 10, axles: [1.4, -1.38], wheelR: 0.31, archR: 0.355,
  });
  const b = new Builder();
  const body = loft(sh.body(84, 22), (p) => {
    const ax = Math.abs(p.x), bot = sh.bottom(p.z);
    if (p.z > 2.0 && p.y > 0.3 && p.y < 0.5 && ax < 0.55) return 1;
    if (p.z < -2.15 && p.y < 0.38) return 1;
    if (p.y < bot + 0.07 && ax > 0.55) return 1;
    return 0;
  }, true, true);
  b.addGroups(body, ['paint', 'black']);

  // «аквариум» седана: лобовое, крыша, задняя стойка, багажник отдельно
  const zA = 1.0, zC = -1.42;
  const roof = spline([[zC, sh.top(zC)], [-1.05, 1.24], [-0.6, 1.42], [0.25, 1.44], [0.65, 1.26], [zA, sh.top(zA)]]);
  const GR = 36, GK = 22, sOf: number[] = [];
  for (let k = 0; k <= GK; k++) sOf.push(Math.sin((Math.PI * k) / GK));
  const gRows: THREE.Vector3[][] = [];
  for (let r = 0; r < GR; r++) {
    const z = zC + ((zA - zC) * r) / (GR - 1);
    const yb = sh.top(z) - 0.012, H = Math.max(0, roof(z) - yb);
    const wb = sh.xAt(z, yb) - 0.03, wr = Math.min(wb, 0.7);
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k <= GK; k++) {
      const phi = Math.PI - (Math.PI * k) / GK;
      const s = Math.sin(phi), c = Math.cos(phi);
      const a = wb + (wr - wb) * Math.min(1, s * 1.1);
      ring.push(new THREE.Vector3(Math.sign(c) * a * Math.pow(Math.abs(c), 2 / 2.4), yb + H * Math.pow(s, 2 / 3.4), z));
    }
    gRows.push(ring);
  }
  const gh = loft(gRows, (p, _r, c) => {
    const s = (sOf[c] + sOf[c + 1]) / 2, z = p.z;
    if (s < 0.07) return 2;
    if (z > 0.45) return s > 0.6 && s < 0.74 ? 0 : 1;
    if (z > -0.8) { if (s > 0.78) return 0; if (Math.abs(z + 0.15) < 0.04) return 2; return 1; }
    if (s > 0.4 && s < 0.86) return 0;
    return 1;
  }, false, false);
  b.addGroups(gh, ['paint', 'glass', 'black']);
  b.box(1.16, 0.44, 3.5, 'black', { x: 0, y: 0.47, z: 0 });

  // фары и решётка
  for (const side of [-1, 1]) {
    const y = 0.66, x = 0.6;
    const z = sh.surfaceZ(x, y, 1);
    b.box(0.34, 0.11, 0.12, 'glass', { x: side * x, y, z: z - 0.03 }, 0.03, new THREE.Euler(0, side * -0.35, 0));
    b.box(0.2, 0.03, 0.06, 'head', { x: side * (x - 0.02), y: y + 0.015, z: z + 0.0 }, 0.012, new THREE.Euler(0, side * -0.35, 0));
    // зеркала
    const mz = 0.82, my = sh.top(mz) + 0.08, mx = sh.xAt(mz, sh.top(mz) - 0.05) + 0.05;
    b.box(0.12, 0.09, 0.06, 'paint', { x: side * mx, y: my, z: mz }, 0.02);
    b.box(0.09, 0.07, 0.01, 'chrome', { x: side * mx, y: my, z: mz - 0.035 });
  }
  b.box(0.95, 0.03, 0.04, 'chrome', { x: 0, y: 0.47, z: sh.surfaceZ(0.45, 0.47, 1) + 0.01 });
  // задние фонари: красный блок + поворотник — отдельные меши (меняют материал)
  const tail = new Builder(), bl = new Builder(), br = new Builder();
  for (const side of [-1, 1]) {
    const y = 0.86, x = 0.6, z = sh.surfaceZ(x, y, -1);
    b.box(0.42, 0.14, 0.08, 'glass', { x: side * x, y, z: z + 0.02 }, 0.02);
    tail.box(0.3, 0.07, 0.04, 'head', { x: side * (x - 0.03), y: y + 0.01, z: z - 0.012 }, 0.01);
    (side < 0 ? bl : br).box(0.09, 0.05, 0.04, 'head', { x: side * (x + 0.15), y: y - 0.02, z: z - 0.01 }, 0.01);
  }
  // номер и бампер
  const pz = sh.surfaceZ(0.27, 0.55, -1);
  b.box(0.52, 0.112, 0.012, 'plate', { x: 0, y: 0.55, z: pz - 0.008 }, 0, new THREE.Euler(0, Math.PI, 0));
  const axles = [1.4, -1.38].map((z) => ({ z, y: 0.31, ...axleGeometry(0.31, 0.2, 0.22, 0.76, false) }));
  return {
    kind: 'sedan', length: 4.6, width: 1.8, parts: b.build(), wheelR: 0.31, axles,
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
    (side < 0 ? bl : br).box(0.12, 0.1, 0.03, 'head', { x: side * 1.1, y: 0.86, z: boxZ0 - 0.05 }, 0.01);
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
const CAB_COLORS: [string, number][] = [['#f0f0ee', 3], ['#b3171c', 2], ['#1f4f9c', 2], ['#e07a12', 1], ['#2b2e33', 1]];
const BRANDS: [string, string][] = [['ТРАНЗИТ-7', '#1f4f9c'], ['ВЕКТОР', '#c4101a'], ['СЕВЕРНЫЙ ПУТЬ', '#16723a'], ['', '#888']];

export class TrafficAssets {
  readonly sedan = buildSedan();
  readonly truck = buildTruck();
  private paints = new Map<string, THREE.MeshPhysicalMaterial>();
  readonly mats: Record<Exclude<MatKey, 'paint' | 'paint2' | 'logo' | 'plate'>, THREE.Material>;
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

  /** Новый экземпляр машины трафика. */
  create(kind: TrafficKind): TrafficVisual {
    const t = kind === 'sedan' ? this.sedan : this.truck;
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const paint = this.paint(this.pick(kind === 'sedan' ? SEDAN_COLORS : CAB_COLORS));
    const paint2 = this.paint(this.rnd() < 0.75 ? '#eef0f0' : this.pick([['#b8bcc2', 1], ['#2b4f8a', 1], ['#c9b89a', 1]]));
    const logo = this.logos[Math.floor(this.rnd() * this.logos.length)];
    const plate = this.plates[Math.floor(this.rnd() * this.plates.length)];
    for (const [k, g] of t.parts) {
      const mat = k === 'paint' ? paint : k === 'paint2' ? paint2 : k === 'logo' ? logo : k === 'plate' ? plate : this.mats[k];
      const m = new THREE.Mesh(g, mat);
      m.castShadow = k !== 'logo' && k !== 'plate' && k !== 'head' && k !== 'chevron';
      m.receiveShadow = k === 'paint' || k === 'paint2';
      body.add(m);
    }
    const tail = new THREE.Mesh(t.tail, this.tailOff);
    const bl = new THREE.Mesh(t.blinkL, this.blinkOff);
    const br = new THREE.Mesh(t.blinkR, this.blinkOff);
    body.add(tail, bl, br);
    const axles = t.axles.map((a) => {
      const g = new THREE.Group();
      g.position.set(0, a.y, a.z);
      const r = new THREE.Mesh(a.rubber, this.mats.rubber);
      r.castShadow = true;
      g.add(r, new THREE.Mesh(a.rim, this.mats.rim));
      root.add(g);
      return g;
    });
    return { root, body, tail, blinkL: bl, blinkR: br, axles, template: t };
  }
}

export interface TrafficVisual {
  root: THREE.Group;
  body: THREE.Group;
  tail: THREE.Mesh;
  blinkL: THREE.Mesh;
  blinkR: THREE.Mesh;
  axles: THREE.Group[];
  template: TrafficTemplate;
}
