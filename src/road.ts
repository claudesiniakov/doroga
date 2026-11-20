import * as THREE from 'three';
import { fbm1, fbm2, clamp, smoothstep } from './noise';
import { ROAD, RoadTextures } from './textures';

export const STEP = 2;            // шаг выборки центральной линии, м
export const CHUNK_STEPS = 48;    // 96 м на чанк (кратно периоду разметки 12 м)
export const CHUNK_LEN = STEP * CHUNK_STEPS;
const AHEAD = 1000;               // сколько дороги держать впереди, м
const BEHIND = 160;               // и позади
const GROUND_FAR = 260;           // ширина ленты рельефа от оси, м

/** Рельеф местности в мировых координатах. */
export function terrainHeight(x: number, z: number, seed: number): number {
  const big = (fbm2(x / 900, z / 900, 4, seed + 101) - 0.5) * 70;
  const mid = (fbm2(x / 220, z / 220, 4, seed + 202) - 0.5) * 18;
  const small = (fbm2(x / 45, z / 45, 3, seed + 303) - 0.5) * 2.2;
  return big + mid + small;
}

export interface RoadFrame {
  pos: THREE.Vector3;
  fwd: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  heading: number;
  curvature: number;
  bank: number;
}

/** Бесконечная центральная линия: точки через STEP метров, генерируются по мере надобности. */
export class RoadPath {
  readonly x: number[] = [0];
  readonly y: number[] = [0];
  readonly z: number[] = [0];
  readonly h: number[] = [0];
  readonly k: number[] = [0];
  readonly bank: number[] = [0];
  private slope = 0;
  private y0: number;

  constructor(readonly seed: number) {
    this.y0 = terrainHeight(0, 0, seed);
    this.y[0] = this.y0;
  }

  get length() { return (this.x.length - 1) * STEP; }

  ensure(s: number) {
    while (this.length < s + STEP * 2) this.grow();
  }

  private grow() {
    const i = this.x.length - 1;
    const s = i * STEP;
    const h = this.h[i];
    // плавный выход на трассу: первые ~150 м прямые и ровные
    const intro = smoothstep(120, 420, s);
    // кривизна: шум + «пружина» к общему направлению +Z; прямые участки там, где шум мал
    const n = fbm1(s / 640, 3, this.seed);
    const straight = smoothstep(0.08, 0.3, Math.abs(fbm1(s / 1500, 2, this.seed + 9)));
    let k = (0.0062 * n * straight - 0.0011 * h) * intro;
    k = clamp(k, -1 / 260, 1 / 260);
    if (h > 0.95 && k > 0) k *= -0.5;
    if (h < -0.95 && k < 0) k *= -0.5;
    const nh = h + k * STEP;
    const mh = (h + nh) / 2;
    const nx = this.x[i] + Math.sin(mh) * STEP;
    const nz = this.z[i] + Math.cos(mh) * STEP;
    // высота: дорога плавно следует сглаженному рельефу (уклон до 5 %)
    const t = terrainHeight(nx + Math.sin(nh) * 120, nz + Math.cos(nh) * 120, this.seed);
    const target = clamp((t - this.y[i]) / 160, -0.05, 0.05) * intro;
    this.slope += (target - this.slope) * 0.035;
    const ny = this.y[i] + this.slope * STEP;
    this.x.push(nx); this.y.push(ny); this.z.push(nz); this.h.push(nh); this.k.push(k);
    // вираж: внешний край выше, до ~3,5°
    this.bank.push(clamp(k * 900, -0.06, 0.06));
  }

  /** Плавная (сглаженная) характеристика по индексу с дробной частью. */
  private lerpArr(a: number[], f: number) {
    const i = Math.floor(f);
    const t = f - i;
    return a[i] + (a[i + 1] - a[i]) * t;
  }

  frame(s: number, out?: RoadFrame): RoadFrame {
    this.ensure(s + STEP);
    const f = Math.max(0, s / STEP);
    const fr = out ?? {
      pos: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(),
      heading: 0, curvature: 0, bank: 0,
    };
    const heading = this.lerpArr(this.h, f);
    const bank = this.lerpArr(this.bank, f);
    const i = Math.floor(f);
    const slope = (this.y[i + 1] - this.y[i]) / STEP;
    fr.pos.set(this.lerpArr(this.x, f), this.lerpArr(this.y, f), this.lerpArr(this.z, f));
    const cp = 1 / Math.sqrt(1 + slope * slope);
    fr.fwd.set(Math.sin(heading) * cp, slope * cp, Math.cos(heading) * cp);
    const rx = -Math.cos(heading), rz = Math.sin(heading);
    const cb = Math.cos(bank), sb = Math.sin(bank);
    fr.right.set(rx * cb, sb, rz * cb).normalize();
    fr.up.crossVectors(fr.right, fr.fwd).normalize();
    fr.heading = heading;
    fr.curvature = this.lerpArr(this.k, f);
    fr.bank = bank;
    return fr;
  }

  /** Точка поперечного сечения: смещение o вправо от оси (с учётом виража), подъём dy. */
  point(i: number, o: number, dy: number, out: THREE.Vector3) {
    this.ensure(i * STEP + STEP);
    const h = this.h[i], b = this.bank[i];
    const rx = -Math.cos(h), rz = Math.sin(h);
    const cb = Math.cos(b), sb = Math.sin(b);
    return out.set(this.x[i] + rx * cb * o, this.y[i] + sb * o + dy, this.z[i] + rz * cb * o);
  }

  /** Ближайший индекс по z (z монотонно растёт, т.к. |курс| < ~70°). */
  indexAtZ(z: number): number {
    let lo = 0, hi = this.z.length - 1;
    if (z <= this.z[0]) return 0;
    if (z >= this.z[hi]) return hi;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.z[m] < z) lo = m; else hi = m;
    }
    return lo;
  }
}

// ——— построение лент (сетки вдоль дороги) с бесшовными нормалями ———

type PosFn = (i: number, j: number, out: THREE.Vector3) => THREE.Vector3;
type UvFn = (i: number, j: number) => [number, number];
type ColFn = (i: number, j: number, p: THREE.Vector3) => [number, number, number];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _n = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();

function ribbon(i0: number, i1: number, cols: number, origin: THREE.Vector3, pos: PosFn, uv: UvFn, col?: ColFn, flip = false) {
  const rows = i1 - i0 + 1;
  const P = new Float32Array(rows * cols * 3);
  const N = new Float32Array(rows * cols * 3);
  const U = new Float32Array(rows * cols * 2);
  const C = col ? new Float32Array(rows * cols * 3) : null;
  for (let r = 0; r < rows; r++) {
    const i = i0 + r;
    for (let j = 0; j < cols; j++) {
      const k = r * cols + j;
      pos(i, j, _a);
      P[k * 3] = _a.x - origin.x; P[k * 3 + 1] = _a.y - origin.y; P[k * 3 + 2] = _a.z - origin.z;
      // центральные разности: соседние ряды берутся и за пределами чанка → швов нет
      pos(i + 1, j, _b); pos(Math.max(0, i - 1), j, _c);
      _t1.subVectors(_b, _c);
      pos(i, Math.min(cols - 1, j + 1), _b); pos(i, Math.max(0, j - 1), _d);
      _t2.subVectors(_b, _d);
      _n.crossVectors(_t2, _t1).normalize();
      if (flip) _n.negate();
      N[k * 3] = _n.x; N[k * 3 + 1] = _n.y; N[k * 3 + 2] = _n.z;
      const [u, v] = uv(i, j);
      U[k * 2] = u; U[k * 2 + 1] = v;
      if (C && col) {
        const [cr, cg, cb] = col(i, j, _a);
        C[k * 3] = cr; C[k * 3 + 1] = cg; C[k * 3 + 2] = cb;
      }
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = r * cols + j, b = a + 1, c = a + cols, d = c + 1;
      if (flip) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  if (C) g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export interface RoadMaterials {
  road: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
  post: THREE.MeshStandardMaterial;
}

export function makeRoadMaterials(tex: RoadTextures, ground: { map: THREE.Texture; normalMap: THREE.Texture },
  gravel: { map: THREE.Texture; normalMap: THREE.Texture }, anisotropy: number): RoadMaterials {
  for (const t of [tex.map, tex.normalMap, tex.roughnessMap, ground.map, ground.normalMap, gravel.map, gravel.normalMap]) {
    t.anisotropy = anisotropy;
  }
  const road = new THREE.MeshStandardMaterial({
    map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap,
    roughness: 1, metalness: 0, normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 0.55,
  });
  // крупная «грязь» на весь чанк поверх мелкой текстуры
  road.onBeforeCompile = (sh) => {
    sh.uniforms.grimeMap = { value: tex.grimeMap };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D grimeMap;')
      .replace('#include <map_fragment>',
        '#include <map_fragment>\n diffuseColor.rgb *= texture2D(grimeMap, vMapUv * vec2(1.0, 0.125)).rgb * 1.28;');
  };
  road.customProgramCacheKey = () => 'road-grime';

  const gravelM = new THREE.MeshStandardMaterial({ map: gravel.map, normalMap: gravel.normalMap, roughness: 0.95 });
  const groundM = new THREE.MeshStandardMaterial({
    map: ground.map, normalMap: ground.normalMap, roughness: 0.97, vertexColors: true,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });
  const rail = new THREE.MeshStandardMaterial({ color: 0xb4b9bc, metalness: 0.85, roughness: 0.36, side: THREE.DoubleSide });
  const post = new THREE.MeshStandardMaterial({ color: 0x8d9295, metalness: 0.7, roughness: 0.55 });
  return { road, gravel: gravelM, ground: groundM, rail, post };
}

// поперечный профиль W-образного отбойника: (вбок от дороги, вверх), м
const RAIL_PROFILE: [number, number][] = [
  [0.0, 0.50], [0.05, 0.53], [0.075, 0.57], [0.075, 0.59], [0.035, 0.625], [0.035, 0.655],
  [0.075, 0.69], [0.075, 0.71], [0.05, 0.75], [0.0, 0.78],
];

class Chunk {
  readonly group = new THREE.Group();
  constructor(readonly index: number) {}
  dispose() {
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.group.removeFromParent();
  }
}

export class RoadWorld {
  readonly path: RoadPath;
  readonly group = new THREE.Group();
  private chunks = new Map<number, Chunk>();
  private postGeo: THREE.BufferGeometry;
  private far: FarTerrain;

  constructor(seed: number, readonly mats: RoadMaterials) {
    this.path = new RoadPath(seed);
    this.group.name = 'road-world';
    // стойка отбойника: швеллер + проставка
    const post = new THREE.BoxGeometry(0.1, 0.95, 0.08);
    post.translate(0, 0.33, 0);
    const spacer = new THREE.BoxGeometry(0.16, 0.2, 0.06);
    spacer.translate(-0.08, 0.64, 0);
    this.postGeo = mergeSimple([post, spacer]);
    this.far = new FarTerrain(this.path, mats.ground);
    this.group.add(this.far.mesh);
  }

  /** Подгрузка/выгрузка чанков вокруг позиции s. */
  update(s: number, carPos: THREE.Vector3) {
    this.path.ensure(s + AHEAD + CHUNK_LEN * 2);
    const first = Math.max(0, Math.floor((s - BEHIND) / CHUNK_LEN));
    const last = Math.floor((s + AHEAD) / CHUNK_LEN);
    for (const [k, c] of this.chunks) {
      if (k < first || k > last) { c.dispose(); this.chunks.delete(k); }
    }
    // не больше двух новых чанков за кадр — без рывков
    let built = 0;
    for (let k = first; k <= last && built < 2; k++) {
      if (!this.chunks.has(k)) { this.chunks.set(k, this.buildChunk(k)); built++; }
    }
    this.far.update(carPos);
  }

  /** Сразу построить всё (для старта). */
  prime(s: number, carPos: THREE.Vector3) {
    for (let n = 0; n < 40; n++) this.update(s, carPos);
  }

  private buildChunk(k: number): Chunk {
    const p = this.path;
    const i0 = k * CHUNK_STEPS, i1 = i0 + CHUNK_STEPS;
    p.ensure((i1 + 2) * STEP);
    const c = new Chunk(k);
    const origin = new THREE.Vector3(p.x[i0], p.y[i0], p.z[i0]);
    c.group.position.copy(origin);
    const half = ROAD.half;
    const vOf = (i: number, period: number) => ((i - i0) * STEP) / period;
    const seed = p.seed;

    // 1) асфальт: 12 колонок, поперечный уклон от оси (двускатный профиль)
    const RC = 12;
    const roadOff = (j: number) => -half + (2 * half * j) / (RC - 1);
    const crown = (o: number) => 0.07 * (1 - (o / half) ** 2);
    const road = ribbon(i0, i1, RC, origin,
      (i, j, out) => p.point(i, roadOff(j), crown(roadOff(j)), out),
      (i, j) => [j / (RC - 1), vOf(i, ROAD.period)]);
    const roadMesh = new THREE.Mesh(road, this.mats.road);
    roadMesh.receiveShadow = true;
    c.group.add(roadMesh);

    // 2) щебёночные полосы и кюветы, 3) рельеф — на каждую сторону
    for (const side of [-1, 1]) {
      const gOff = [half, half + 0.5, half + 1.3];
      const gravel = ribbon(i0, i1, 3, origin,
        (i, j, out) => {
          const o = gOff[side < 0 ? 2 - j : j];
          const drop = o <= half ? 0 : -0.05 - (o - half - 0.5) * 0.12;
          return p.point(i, side * o, drop, out);
        },
        (i, j) => [gOff[side < 0 ? 2 - j : j] / 1.5, vOf(i, 2)]);
      const gm = new THREE.Mesh(gravel, this.mats.gravel);
      gm.receiveShadow = true;
      c.group.add(gm);

      // лента рельефа: кювет у дороги → плавный переход к естественному рельефу
      const offs = [half + 1.3, half + 2.4, half + 3.6, half + 5, half + 7, half + 10, half + 15, 30, 45, 65, 90, 125, 170, 215, GROUND_FAR];
      const NC = offs.length;
      const oAt = (j: number) => offs[side < 0 ? NC - 1 - j : j];
      const tmp = new THREE.Vector3();
      const groundPos: PosFn = (i, j, out) => {
        const o = oAt(j);
        p.point(i, side * o, 0, tmp);
        const roadLevel = tmp.y - 0.15;
        const ditch = -0.9 * Math.exp(-(((o - (half + 3.6)) / 1.6) ** 2));
        const t = terrainHeight(tmp.x, tmp.z, seed);
        const blend = smoothstep(half + 6, 80, o);
        return out.set(tmp.x, roadLevel + (t - roadLevel) * blend + ditch * (1 - blend), tmp.z);
      };
      const ground = ribbon(i0, i1, NC, origin, groundPos,
        (i, j) => [oAt(j) / 6, vOf(i, 6)],
        (_i, j, pt) => groundColor(pt.x, pt.z, oAt(j), seed));
      const grm = new THREE.Mesh(ground, this.mats.ground);
      grm.receiveShadow = true;
      c.group.add(grm);

      // 4) отбойник (на обеих сторонах, непрерывный)
      const railO = half + 0.55;
      const NP = RAIL_PROFILE.length;
      const rail = ribbon(i0, i1, NP, origin,
        (i, j, out) => {
          const [lat, up] = RAIL_PROFILE[j];
          return p.point(i, side * (railO - lat), up - 0.05, out);
        },
        (i, j) => [j / (NP - 1), vOf(i, 4)], undefined, side < 0);
      const rm = new THREE.Mesh(rail, this.mats.rail);
      rm.castShadow = true;
      rm.receiveShadow = true;
      c.group.add(rm);

      // стойки каждые 4 м
      const count = CHUNK_STEPS / 2;
      const posts = new THREE.InstancedMesh(this.postGeo, this.mats.post, count);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
      const pt = new THREE.Vector3();
      for (let n = 0; n < count; n++) {
        const i = i0 + n * 2;
        p.point(i, side * (railO + 0.12), -0.1, pt);
        // проставка смотрит к дороге: справа разворот на 180°
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.h[i] + (side > 0 ? Math.PI : 0));
        m.compose(pt.sub(origin), q, sc);
        posts.setMatrixAt(n, m);
      }
      posts.castShadow = true;
      posts.receiveShadow = true;
      posts.computeBoundingSphere();
      c.group.add(posts);
    }

    this.group.add(c.group);
    return c;
  }
}

function groundColor(x: number, z: number, o: number, seed: number): [number, number, number] {
  const dry = fbm2(x / 70, z / 70, 3, seed + 7);
  const lush = fbm2(x / 23, z / 23, 3, seed + 8);
  // у дороги пыльно и выгоревше
  const dust = 1 - smoothstep(ROAD.half + 1, ROAD.half + 9, o);
  let r = 0.95 + dry * 0.25 + dust * 0.15;
  let g = 0.95 + lush * 0.1 - dry * 0.05;
  let b = 0.9 + dust * 0.1;
  const v = 0.85 + lush * 0.25;
  r *= v; g *= v; b *= v;
  return [r, g, b];
}

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  let base = 0;
  for (const g of geos) {
    const gi = g.index ? g.toNonIndexed() : g;
    const p = gi.getAttribute('position'), n = gi.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      idx.push(base + i);
    }
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

/**
 * Дальний рельеф: сетка вокруг машины. В коридоре дороги опущена вниз (её закрывают ленты чанков),
 * дальше — тот же рельеф, что и у лент, поэтому стык не виден.
 */
class FarTerrain {
  readonly mesh: THREE.Mesh;
  private geo: THREE.PlaneGeometry;
  private center = new THREE.Vector2(Infinity, Infinity);
  private readonly size = 2400;
  private readonly segs = 160;

  constructor(private path: RoadPath, mat: THREE.MeshStandardMaterial) {
    this.geo = new THREE.PlaneGeometry(this.size, this.size, this.segs, this.segs);
    this.geo.rotateX(-Math.PI / 2);
    const n = this.geo.getAttribute('position').count;
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
  }

  update(car: THREE.Vector3) {
    const snap = 120;
    const cx = Math.round(car.x / snap) * snap, cz = Math.round(car.z / snap) * snap;
    if (cx === this.center.x && cz === this.center.y) return;
    this.center.set(cx, cz);
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.geo.getAttribute('color') as THREE.BufferAttribute;
    const uv = this.geo.getAttribute('uv') as THREE.BufferAttribute;
    const half = this.size / 2;
    const step = this.size / this.segs;
    const p = this.path;
    for (let r = 0; r <= this.segs; r++) {
      for (let c = 0; c <= this.segs; c++) {
        const k = r * (this.segs + 1) + c;
        const lx = -half + c * step, lz = -half + r * step;
        const wx = cx + lx, wz = cz + lz;
        let y = terrainHeight(wx, wz, p.seed);
        const i = p.indexAtZ(wz);
        const d = Math.abs(wx - p.x[i]) * Math.cos(p.h[i]);
        if (wz >= p.z[0] - 50 && wz <= p.z[p.z.length - 1]) {
          if (d < GROUND_FAR - 30) y = Math.min(y, p.y[i]) - 25;
          else y -= 1.2 * (1 - smoothstep(GROUND_FAR, GROUND_FAR + 120, d));
        }
        pos.setXYZ(k, lx, y, lz);
        uv.setXY(k, wx / 6, wz / 6);
        const [cr, cg, cb] = groundColor(wx, wz, 1000, p.seed);
        col.setXYZ(k, cr, cg, cb);
      }
    }
    pos.needsUpdate = true; col.needsUpdate = true; uv.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.mesh.position.set(cx, 0, cz);
  }
}
