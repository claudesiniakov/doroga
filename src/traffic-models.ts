import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { spline, loft, bodyStations } from './car';
import { clamp, mulberry32 } from './noise';
import { makePlateTexture } from './textures';
import { VAN, vanShape, vanGreenhouse, vanBodyClassify } from './van-shape';

// Оси моделей трафика: +Z — вперёд, +Y — вверх, +X — ЛЕВЫЙ борт (базис «вверх × вперёд»).
/** Ключи материалов: детали модели склеиваются по ним — несколько draw call на машину. */
type MatKey = 'paint' | 'paint2' | 'glass' | 'black' | 'chrome' | 'grey' | 'head' | 'plate' | 'logo' | 'chevron' | 'rubber' | 'rim' | 'wood';
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

export type TrafficKind = 'sedan' | 'truck' | 'moto' | 'van' | 'tiller';

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

function buildSedan(police = false): TrafficTemplate {
  const sh = new Shape({
    halfLen: 2.3,
    top: [[-2.3, 0.72], [-2.26, 0.9], [-2.05, 0.985], [-1.5, 1.0], [-1.0, 0.985], [0, 0.94], [0.9, 0.905], [1.4, 0.865], [1.95, 0.79], [2.2, 0.69], [2.3, 0.5]],
    bottom: [[-2.3, 0.44], [-2.15, 0.31], [-1.8, 0.22], [1.8, 0.21], [2.15, 0.25], [2.3, 0.34]],
    width: [[-2.3, 0.82], [-1.9, 0.885], [-1.3, 0.9], [0, 0.9], [1.4, 0.9], [1.9, 0.87], [2.3, 0.78]],
    planFront: 5, planRear: 10, axles: [1.4, -1.38], wheelR: 0.31, archR: 0.355, archBlend: police ? 0.04 : undefined,
  });
  const b = new Builder();
  const body = loft(sh.body(84, 22), () => 0, true, true);
  b.add(body, 'paint');

  // «аквариум» седана: лобовое, крыша, задняя стойка, багажник отдельно
  const zA = 1.0, zC = -1.42;
  const roof = spline([[zC, sh.top(zC)], [-1.05, 1.24], [-0.6, 1.42], [0.25, 1.44], [0.65, 1.26], [zA, sh.top(zA)]]);
  const GR = 36, GK = 22, sOf: number[] = [];
  for (let k = 0; k <= GK; k++) sOf.push(Math.sin((Math.PI * k) / GK));
  const gRows: THREE.Vector3[][] = [];
  for (let r = 0; r < GR; r++) {
    const z = zC + ((zA - zC) * r) / (GR - 1);
    // Ниже линия стыка с кузовом шире, а профиль крыши остаётся прежним.
    const yb = sh.top(z) - (police ? 0.06 : 0.03), H = Math.max(0, roof(z) - yb);
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

  b.add(panel(0.98, 0.10, 0, 0.43, 1, 0.014), 'black');
  b.add(panel(0.82, 0.018, 0, 0.448, 1, 0.024), 'chrome');
  const tail = new Builder(), bl = new Builder(), br = new Builder();
  for (const side of [-1, 1]) {
    b.add(panel(0.30, 0.085, side * 0.56, 0.64, 1, 0.014), 'black');
    b.add(panel(0.22, 0.025, side * 0.56, 0.644, 1, 0.024), 'head');

    b.add(panel(0.30, 0.09, side * 0.55, 0.81, -1, 0.014), 'black');
    tail.add(panel(0.18, 0.038, side * 0.515, 0.812, -1, 0.024), 'head');
    (side > 0 ? bl : br).add(panel(0.05, 0.038, side * 0.66, 0.812, -1, 0.024), 'head');

    const mz = 0.82, my = sh.top(mz) + 0.08, mx = sh.xAt(mz, sh.top(mz) - 0.05) + 0.05;
    b.box(0.12, 0.09, 0.06, 'paint', { x: side * mx, y: my, z: mz }, 0.02);
    b.box(0.09, 0.07, 0.01, 'chrome', { x: side * mx, y: my, z: mz - 0.035 });
  }
  b.add(panel(0.52, 0.112, 0, 0.55, -1, 0.016), 'plate');
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
  const axles = [1.4, -1.38].map((z) => ({ z, y: 0.31, ...axleGeometry(0.31, 0.2, 0.22, 0.76, false) }));
  return {
    kind: 'sedan', length: 4.6, width: 1.8, parts: b.build(), wheelR: 0.31, axles,
    tail: tail.build().get('head')!, blinkL: bl.build().get('head')!, blinkR: br.build().get('head')!,
  };
}

/** Спортбайк с мотоциклистом. Колёса — отдельные «оси» по центру (наклоняются вместе с кузовом). */
function buildMoto(): TrafficTemplate {
  const b = new Builder();
  const R = 0.31, zF = 0.72, zR = -0.7;
  const between = (a: THREE.Vector3, c: THREE.Vector3, r: number, key: MatKey) => {
    const len = a.distanceTo(c);
    const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 2 + r * 0.6), 4, 10);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize());
    g.applyQuaternion(q);
    const m = a.clone().add(c).multiplyScalar(0.5);
    return b.add(g, key, m);
  };
  const blob = (r: number, s: [number, number, number], pos: THREE.Vector3Like, key: MatKey, rx = 0) =>
    b.add(new THREE.SphereGeometry(r, 18, 12), key, pos, new THREE.Euler(rx, 0, 0), { x: s[0], y: s[1], z: s[2] });
  // мотоцикл
  b.box(0.3, 0.36, 0.5, 'grey', { x: 0, y: 0.47, z: -0.02 }, 0.05);                 // двигатель
  for (let k = 0; k < 4; k++) b.box(0.34, 0.015, 0.2, 'grey', { x: 0, y: 0.58 + k * 0.035, z: 0.12 }, 0);
  b.box(0.26, 0.16, 0.56, 'black', { x: 0, y: 0.34, z: 0.06 }, 0.06);                // брюхо
  blob(1, [0.2, 0.15, 0.32], { x: 0, y: 0.88, z: 0.1 }, 'paint');                    // бак
  blob(1, [0.19, 0.2, 0.3], { x: 0, y: 0.84, z: 0.47 }, 'paint', 0.35);             // обтекатель
  b.add(new THREE.PlaneGeometry(0.3, 0.26), 'glass', { x: 0, y: 1.1, z: 0.6 }, new THREE.Euler(-0.75, 0, 0));
  b.box(0.25, 0.08, 0.5, 'black', { x: 0, y: 0.87, z: -0.28 }, 0.035);               // седло
  blob(1, [0.13, 0.09, 0.34], { x: 0, y: 0.9, z: -0.6 }, 'paint', -0.18);           // хвост
  for (const side of [-1, 1]) {
    b.box(0.04, 0.06, 0.62, 'grey', { x: side * 0.1, y: 0.36, z: -0.38 }, 0, new THREE.Euler(0.08, 0, 0)); // маятник
    between(new THREE.Vector3(side * 0.085, R, zF), new THREE.Vector3(side * 0.085, 1.0, 0.5), 0.024, 'chrome'); // вилка
    b.box(0.06, 0.03, 0.06, 'black', { x: side * 0.29, y: 1.04, z: 0.4 }, 0.01);     // ручки
    b.box(0.03, 0.12, 0.03, 'black', { x: side * 0.22, y: 1.12, z: 0.47 });          // кронштейн зеркала
    b.box(0.1, 0.05, 0.02, 'chrome', { x: side * 0.25, y: 1.18, z: 0.47 }, 0.01);
  }
  const bar = new THREE.CylinderGeometry(0.015, 0.015, 0.58, 8).rotateZ(Math.PI / 2);
  b.add(bar, 'black', { x: 0, y: 1.03, z: 0.42 });
  const pipe = new THREE.CylinderGeometry(0.05, 0.06, 0.5, 14).rotateX(Math.PI / 2 - 0.25);
  b.add(pipe, 'chrome', { x: 0.15, y: 0.5, z: -0.55 });
  b.box(0.16, 0.05, 0.3, 'black', { x: 0, y: R + 0.27, z: zF + 0.02 }, 0.02, new THREE.Euler(0.15, 0, 0)); // крыло
  b.box(0.16, 0.07, 0.04, 'head', { x: 0, y: 0.84, z: 0.79 }, 0.02);                  // фара
  b.box(0.17, 0.12, 0.01, 'plate', { x: 0, y: 0.68, z: -0.86 }, 0, new THREE.Euler(0.3, Math.PI, 0));
  // мотоциклист: наклонён к рулю
  const hip = new THREE.Vector3(0, 0.98, -0.24), sh = new THREE.Vector3(0, 1.32, 0.08);
  between(hip, sh, 0.15, 'black');                                                    // куртка
  b.add(new THREE.SphereGeometry(0.125, 18, 12), 'paint2', { x: 0, y: 1.46, z: 0.19 }, undefined, { x: 1, y: 1, z: 1.12 });  // шлем
  b.add(new THREE.SphereGeometry(0.128, 16, 10, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.35, Math.PI * 0.25), 'glass', { x: 0, y: 1.46, z: 0.205 }, undefined, { x: 1, y: 1, z: 1.12 });
  for (const side of [-1, 1]) {
    const s = new THREE.Vector3(side * 0.17, 1.3, 0.06), el = new THREE.Vector3(side * 0.24, 1.12, 0.24), gr = new THREE.Vector3(side * 0.29, 1.04, 0.4);
    between(s, el, 0.055, 'black');
    between(el, gr, 0.048, 'black');
    const hp = new THREE.Vector3(side * 0.12, 0.95, -0.22), kn = new THREE.Vector3(side * 0.21, 0.83, 0.13), ft = new THREE.Vector3(side * 0.19, 0.5, -0.04);
    between(hp, kn, 0.075, 'grey');
    between(kn, ft, 0.06, 'grey');
    b.box(0.09, 0.08, 0.2, 'black', { x: side * 0.19, y: 0.47, z: 0.0 }, 0.02);         // ботинок
  }
  // колёса: шина + диск + тормозной диск, по центру
  const wheel = (z: number) => {
    const rub = new Builder(), rim = new Builder();
    const W = 0.13, rimR = 0.22;
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI;
      prof.push(new THREE.Vector2(rimR + (R - rimR) * (0.55 + 0.45 * Math.cos(a)), (W / 2) * Math.sin(a)));
    }
    const tire = new THREE.LatheGeometry(prof, 32).rotateZ(Math.PI / 2);
    rub.add(tire, 'rubber');
    rim.add(new THREE.CylinderGeometry(rimR, rimR, 0.05, 24).rotateZ(Math.PI / 2), 'rim');
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      rub.add(new THREE.BoxGeometry(0.06, rimR * 0.5, rimR * 0.18), 'rubber', { x: 0, y: Math.cos(a) * rimR * 0.55, z: Math.sin(a) * rimR * 0.55 }, new THREE.Euler(a, 0, 0));
    }
    rim.add(new THREE.CylinderGeometry(0.15, 0.15, 0.012, 24).rotateZ(Math.PI / 2), 'rim', { x: 0.045, y: 0, z: 0 });
    return { z, y: R, rubber: rub.build().get('rubber')!, rim: rim.build().get('rim')! };
  };
  const tail = new Builder(), bl = new Builder(), br = new Builder();
  tail.box(0.12, 0.05, 0.03, 'head', { x: 0, y: 0.92, z: -0.93 }, 0.012);
  bl.box(0.05, 0.035, 0.035, 'head', { x: 0.12, y: 0.82, z: -0.86 }, 0.01);
  br.box(0.05, 0.035, 0.035, 'head', { x: -0.12, y: 0.82, z: -0.86 }, 0.01);
  return {
    kind: 'moto', length: 2.15, width: 0.85, parts: b.build(), wheelR: R, axles: [wheel(zF), wheel(zR)],
    tail: tail.build().get('head')!, blinkL: bl.build().get('head')!, blinkR: br.build().get('head')!,
  };
}

/**
 * Мотоблок с повозкой: мотоблок впереди (две колёсные «грунтозацепы», мотор, длинные ручки),
 * за ним — дощатая тележка на одной оси, на передке сидит водитель и держит ручки.
 */
function buildTiller(): TrafficTemplate {
  const b = new Builder();
  const between = (a: THREE.Vector3, c: THREE.Vector3, r: number, key: MatKey) => {
    const len = a.distanceTo(c);
    const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 2 + r * 0.6), 4, 10);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize()));
    return b.add(g, key, a.clone().add(c).multiplyScalar(0.5));
  };
  const RT = 0.3, zT = 1.42;          // ось мотоблока
  const RC = 0.27, zC = -0.55;        // ось тележки
  // ——— мотоблок ———
  b.box(0.3, 0.2, 0.34, 'grey', { x: 0, y: RT + 0.02, z: zT }, 0.04);                       // редуктор
  b.box(0.12, 0.34, 0.14, 'grey', { x: 0, y: RT + 0.26, z: zT - 0.1 }, 0.03);               // колонна
  b.box(0.36, 0.26, 0.4, 'paint', { x: 0, y: 0.78, z: zT - 0.02 }, 0.05);                   // кожух двигателя
  b.box(0.3, 0.12, 0.26, 'paint', { x: 0.02, y: 0.97, z: zT + 0.04 }, 0.05);               // бак
  b.add(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 12), 'black', { x: 0.02, y: 1.05, z: zT + 0.04 }); // пробка
  b.add(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 16).rotateZ(Math.PI / 2), 'black', { x: -0.24, y: 0.82, z: zT + 0.02 }); // воздушный фильтр
  b.add(new THREE.CylinderGeometry(0.04, 0.045, 0.22, 12).rotateX(Math.PI / 2), 'chrome', { x: 0.2, y: 0.74, z: zT + 0.2 }); // глушитель
  for (let k = 0; k < 4; k++) b.box(0.38, 0.012, 0.03, 'black', { x: 0, y: 0.7 + k * 0.045, z: zT + 0.19 }); // решётка
  b.box(0.12, 0.07, 0.05, 'head', { x: 0, y: 0.62, z: zT + 0.23 }, 0.02);                  // фара
  b.box(0.7, 0.04, 0.24, 'black', { x: 0, y: RT * 2 + 0.06, z: zT }, 0.015);               // крылья над колёсами
  b.box(0.1, 0.06, 0.22, 'black', { x: 0, y: 0.26, z: zT - 0.32 }, 0.02);                  // сцепка
  b.box(0.08, 0.05, 0.5, 'grey', { x: 0, y: 0.28, z: zT - 0.62 }, 0.02);                   // дышло к тележке
  // Положение рукояток задаёт и точки хвата водителя.
  const grip = new THREE.Vector3(0.31, 1.30, zT - 0.83);
  for (const side of [-1, 1]) {
    const a = new THREE.Vector3(side * 0.12, 0.92, zT - 0.15);
    const m = new THREE.Vector3(side * 0.23, 1.20, zT - 0.54);
    const inner = new THREE.Vector3(side * (grip.x - 0.055), grip.y, grip.z + 0.02);
    const outer = new THREE.Vector3(side * (grip.x + 0.055), grip.y, grip.z - 0.02);
    between(a, m, 0.018, 'grey');
    between(m, inner, 0.018, 'grey');
    between(inner, outer, 0.024, 'black');
  }
  // ——— тележка: дощатый кузов на раме ———
  const bedF = 0.62, bedB = -1.25, bedW = 1.24, floorY = 0.58, sideH = 0.34;
  const bedL = bedF - bedB, bedZ = (bedF + bedB) / 2;
  b.box(0.08, 0.08, bedL + 0.1, 'grey', { x: 0.42, y: floorY - 0.08, z: bedZ });             // лонжероны
  b.box(0.08, 0.08, bedL + 0.1, 'grey', { x: -0.42, y: floorY - 0.08, z: bedZ });
  b.box(bedW, 0.04, bedL, 'wood', { x: 0, y: floorY, z: bedZ });                            // пол
  const planks = 3, ph = sideH / planks;
  for (let k = 0; k < planks; k++) {
    const y = floorY + 0.02 + ph * (k + 0.5);
    for (const side of [-1, 1]) b.box(0.035, ph - 0.012, bedL, 'wood', { x: side * (bedW / 2 - 0.018), y, z: bedZ });
    b.box(bedW, ph - 0.012, 0.035, 'wood', { x: 0, y, z: bedB + 0.018 });                    // задний борт
    b.box(bedW, ph - 0.012, 0.035, 'wood', { x: 0, y, z: bedF - 0.018 });                    // передний борт
  }
  for (const z of [bedF - 0.02, bedZ, bedB + 0.02]) for (const side of [-1, 1])
    b.box(0.05, sideH + 0.04, 0.05, 'grey', { x: side * (bedW / 2 + 0.005), y: floorY + sideH / 2 + 0.02, z });   // стойки
  // груз: мешки с картошкой и бидон
  for (const [x, z, r] of [[0.25, -0.3, 0.2], [-0.2, -0.45, 0.22], [0.05, -0.85, 0.21], [-0.3, -0.95, 0.19]] as const)
    b.add(new THREE.SphereGeometry(1, 14, 10), 'paint2', { x, y: floorY + 0.17, z }, new THREE.Euler(0, x * 3, 0.2), { x: r * 1.15, y: 0.17, z: r * 1.4 });
  b.add(new THREE.CylinderGeometry(0.13, 0.15, 0.42, 18), 'chrome', { x: 0.35, y: floorY + 0.23, z: 0.15 });
  b.add(new THREE.CylinderGeometry(0.07, 0.11, 0.1, 18), 'chrome', { x: 0.35, y: floorY + 0.49, z: 0.15 });
  // сиденье-доска на переднем борту и водитель
  b.box(0.7, 0.05, 0.3, 'wood', { x: 0, y: floorY + sideH + 0.04, z: bedF - 0.2 });
  const hip = new THREE.Vector3(0, floorY + sideH + 0.17, bedF - 0.22), sh = new THREE.Vector3(0, hip.y + 0.5, bedF - 0.12);
  between(hip, sh, 0.17, 'paint2');                                                         // ватник
  b.add(new THREE.SphereGeometry(0.11, 16, 12), 'wood', { x: 0, y: sh.y + 0.2, z: sh.z + 0.02 }, undefined, { x: 1, y: 1.08, z: 1 }); // голова
  b.add(new THREE.SphereGeometry(0.125, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), 'black', { x: 0, y: sh.y + 0.24, z: sh.z + 0.01 }); // кепка
  b.box(0.2, 0.025, 0.12, 'black', { x: 0, y: sh.y + 0.25, z: sh.z + 0.14 });             // козырёк
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(side * 0.16, sh.y - 0.04, sh.z);
    const elbow = new THREE.Vector3(side * 0.29, grip.y - 0.04, sh.z - 0.10);
    const hand = new THREE.Vector3(side * grip.x, grip.y, grip.z);
    between(shoulder, elbow, 0.055, 'paint2');
    between(elbow, hand, 0.045, 'paint2');
    b.add(new THREE.SphereGeometry(0.047, 12, 8), 'wood', hand);
    const hp = new THREE.Vector3(side * 0.12, hip.y, hip.z), kn = new THREE.Vector3(side * 0.17, hip.y + 0.04, hip.z + 0.42);
    between(hp, kn, 0.075, 'black');
    between(kn, new THREE.Vector3(side * 0.17, floorY + 0.12, bedF + 0.35), 0.065, 'black'); // ноги на дышле
    b.box(0.1, 0.08, 0.22, 'black', { x: side * 0.17, y: floorY + 0.06, z: bedF + 0.4 }, 0.02);
  }
  // колёса: мотоблок — «грунтозацепы» (ёлочка), тележка — обычные
  const tiller = axleGeometry(RT, 0.16, 0.17, 0.36, false);
  const lugs = new Builder();
  for (const side of [-1, 1]) for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    for (const h of [-1, 1])
      lugs.add(new THREE.BoxGeometry(0.075, 0.04, 0.05), 'rubber', { x: side * 0.36 + h * 0.04, y: Math.cos(a) * (RT + 0.01), z: Math.sin(a) * (RT + 0.01) }, new THREE.Euler(a, h * 0.5, 0));
  }
  const tillerRubber = mergeGeometries([tiller.rubber, lugs.build().get('rubber')!], false)!;
  const cart = axleGeometry(RC, 0.15, 0.13, 0.5, false);   // колёса под кузовом
  const tail = new Builder(), bl = new Builder(), br = new Builder();
  for (const side of [-1, 1]) tail.box(0.1, 0.06, 0.02, 'head', { x: side * 0.5, y: floorY + 0.14, z: bedB - 0.01 }, 0.01); // катафоты
  b.add(new THREE.CircleGeometry(0.16, 3).rotateY(Math.PI), 'chevron', { x: 0, y: floorY + 0.2, z: bedB - 0.02 });         // «тихоходный» знак
  bl.box(0.04, 0.03, 0.02, 'head', { x: 0.6, y: floorY + 0.3, z: bedB - 0.01 }, 0.008);
  br.box(0.04, 0.03, 0.02, 'head', { x: -0.6, y: floorY + 0.3, z: bedB - 0.01 }, 0.008);
  return {
    kind: 'tiller', length: zT + RT + 0.25 - bedB, width: 1.3, parts: b.build(), wheelR: 0.28,
    axles: [{ z: zT, y: RT, rubber: tillerRubber, rim: tiller.rim }, { z: zC, y: RC, rubber: cart.rubber, rim: cart.rim }],
    tail: tail.build().get('head')!, blinkL: bl.build().get('head')!, blinkR: br.build().get('head')!,
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
const MOTO_COLORS: [string, number][] = [['#c4101a', 3], ['#1f4f9c', 2], ['#111214', 3], ['#f2f2f0', 2], ['#f5c518', 1], ['#2e8b3e', 1], ['#e06a12', 1]];
const TILLER_COLORS: [string, number][] = [['#c4251c', 3], ['#e06a12', 2], ['#2e7d3a', 1], ['#1f4f9c', 1]];
const CAB_COLORS: [string, number][] = [['#f0f0ee', 3], ['#b3171c', 2], ['#1f4f9c', 2], ['#e07a12', 1], ['#2b2e33', 1]];
const BRANDS: [string, string][] = [['ТРАНЗИТ-7', '#1f4f9c'], ['ВЕКТОР', '#c4101a'], ['СЕВЕРНЫЙ ПУТЬ', '#16723a'], ['', '#888']];

export class TrafficAssets {
  readonly sedan = buildSedan();
  private policeSedan?: TrafficTemplate;
  readonly truck = buildTruck();
  readonly moto = buildMoto();
  readonly van = buildVanTraffic();
  readonly tiller = buildTiller();
  private paints = new Map<string, THREE.MeshPhysicalMaterial>();
  readonly mats: Record<Exclude<MatKey, 'paint' | 'paint2' | 'logo' | 'plate'>, THREE.Material>;
  readonly tailOff = new THREE.MeshStandardMaterial({ color: 0x3a0000, emissive: 0xff1a12, emissiveIntensity: 1.6, roughness: 0.3 });
  readonly tailOn = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff1a12, emissiveIntensity: 7, roughness: 0.3 });
  readonly blinkOff = new THREE.MeshStandardMaterial({ color: 0x4a2a00, emissive: 0xff8a00, emissiveIntensity: 0.05, roughness: 0.3 });
  readonly blinkOn = new THREE.MeshStandardMaterial({ color: 0x6a3a00, emissive: 0xff9a10, emissiveIntensity: 6, roughness: 0.3 });
  readonly logos: THREE.Material[];
  readonly plates: THREE.Material[];
  private rnd = mulberry32(99);
  /** Ткань (мешки, ватник) — матовая, без лака. */
  private cloth = new THREE.MeshStandardMaterial({ color: 0x5d5a4a, roughness: 0.95 });

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
      wood: new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.85 }),
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
    const vis = this.createVisual(this.policeSedan ??= buildSedan(true), stripe);
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
    // инспектор в светоотражающем жилете — сбоку от машины, со стороны дороги
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
    man.position.set(1.3, 0, 2.2);   // слева от машины (к дороге), у переднего колеса
    man.rotation.y = -0.6;
    vis.root.add(man);
    return { vis, red, blue };
  }

  /** Новый экземпляр машины трафика. */
  create(kind: TrafficKind): TrafficVisual {
    const t = kind === 'sedan' ? this.sedan : kind === 'moto' ? this.moto : kind === 'van' ? this.van : kind === 'tiller' ? this.tiller : this.truck;
    return this.createVisual(t);
  }

  private createVisual(t: TrafficTemplate, policeStripe?: THREE.Material): TrafficVisual {
    const kind = t.kind;
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const color = this.pick(kind === 'sedan' || kind === 'van' ? SEDAN_COLORS : kind === 'moto' ? MOTO_COLORS : kind === 'tiller' ? TILLER_COLORS : CAB_COLORS);
    const paint = this.paint(policeStripe ? '#f2f3f1' : color);
    const paint2 = kind === 'tiller' ? this.cloth : this.paint(this.rnd() < 0.75 ? '#eef0f0' : this.pick([['#b8bcc2', 1], ['#2b4f8a', 1], ['#c9b89a', 1]]));
    const logo = this.logos[Math.floor(this.rnd() * this.logos.length)];
    const plate = this.plates[Math.floor(this.rnd() * this.plates.length)];
    for (const [k, g] of t.parts) {
      const mat = k === 'paint' ? paint : k === 'paint2' ? paint2 : k === 'logo' ? (policeStripe ?? logo) : k === 'plate' ? plate : this.mats[k];
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
      (kind === 'moto' ? body : root).add(g);   // у мотоцикла колёса наклоняются вместе с ним
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
