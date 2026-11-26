import * as THREE from 'three';
import { fbm1, fbm2, clamp, smoothstep, lerp, mulberry32 } from './noise';
import { ROAD, RoadTextures } from './textures';
import { BiomeMap, Weights } from './biomes';
import { PropKit, type TreeSeason } from './props';
import { scatterChunk } from './scatter';
import { addSnowCover } from './snow';

export const STEP = 2;            // шаг выборки центральной линии, м
export const CHUNK_STEPS = 48;    // 96 м на чанк (кратно периоду разметки 12 м)
export const CHUNK_LEN = STEP * CHUNK_STEPS;
const AHEAD = 1000;               // сколько дороги держать впереди, м
const BEHIND = 160;               // и позади
const GROUND_FAR = 260;           // ширина ленты рельефа от оси, м
/** Колонки ленты рельефа (смещение от оси, м). */
const GROUND_OFFS = [ROAD.half + 1.3, ROAD.half + 2.4, ROAD.half + 3.6, ROAD.half + 5, ROAD.half + 7, ROAD.half + 10,
  ROAD.half + 15, 30, 45, 65, 90, 125, 170, 215, GROUND_FAR];

/** Рельеф местности в мировых координатах. */
export function terrainHeight(x: number, z: number, seed: number): number {
  const big = (fbm2(x / 900, z / 900, 4, seed + 101) - 0.5) * 70;
  const mid = (fbm2(x / 220, z / 220, 4, seed + 202) - 0.5) * 18;
  const small = (fbm2(x / 45, z / 45, 3, seed + 303) - 0.5) * 2.2;
  return big + mid + small;
}

/** Съезд на заправку: полоса открывается с s0, колонка у sStop, полоса сливается к sEnd. */
export type ExitKind = 'fuel' | 'repair';
export interface Exit { index: number; kind: ExitKind; s0: number; sStop: number; sEnd: number; }
export const EXIT_W = 3.5;
const EXIT_TAPER = 80;

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
  /** Уровень моря у точки (NaN — моря рядом нет). */
  readonly sea: number[] = [NaN];
  readonly biomes: BiomeMap;
  private coastBase = new Map<number, number>();
  private slope = 0;
  private y0: number;
  private wTmp: Weights = { coast: 0, city: 0, suburb: 0, desert: 0, forest: 0 };
  readonly exits: Exit[] = [];
  private exitRnd: () => number;

  constructor(readonly seed: number) {
    this.biomes = new BiomeMap(seed);
    this.exitRnd = mulberry32(seed * 13 + 1);
    this.y0 = terrainHeight(0, 0, seed);
    this.y[0] = this.y0;
    const c0 = this.biomes.coastNear(0, 1500, 300);
    if (c0) { this.coastBase.set(c0.index, this.y0); this.sea[0] = this.y0 - 3.2; }
  }

  private ensureExits(s: number) {
    while (!this.exits.length || this.exits[this.exits.length - 1].sEnd < s + 3000) {
      const last = this.exits[this.exits.length - 1];
      // Съезды чаще: первый на 1,4 км, дальше каждые 1,5–3,6 км.
      const s0 = last ? last.sEnd + 1500 + this.exitRnd() * 2100 : 1400;
      const index = this.exits.length;
      // Через раз: заправка и автосервис.
      this.exits.push({ index, kind: index % 2 === 1 ? 'repair' : 'fuel', s0, sStop: s0 + 300, sEnd: s0 + 420 });
    }
  }

  /** Съезд, к которому относится точка s (с запасом до 700 м перед ним), или null. */
  exitNear(s: number, before = 700): Exit | null {
    this.ensureExits(s);
    for (const e of this.exits) {
      if (s >= e.s0 - before && s <= e.sEnd) return e;
      if (e.s0 - before > s) break;
    }
    return null;
  }

  /** Следующий съезд впереди (начало полосы дальше s). */
  nextExit(s: number, kind?: ExitKind): Exit {
    this.ensureExits(s + 20000);
    return this.exits.find((e) => e.sStop > s && (!kind || e.kind === kind))!;
  }

  /** Ближайшая остановка по трассе, включая уже проеханные. */
  nearestExit(s: number): Exit {
    let nearest = this.nextExit(s);
    for (const exit of this.exits) {
      if (exit.sStop > s) break;
      if (s - exit.sStop < Math.abs(nearest.sStop - s)) nearest = exit;
    }
    return nearest;
  }

  /** Ширина полосы съезда справа в точке s (0 — съезда нет). */
  extraAt(s: number): number {
    const e = this.exitNear(s, 0);
    if (!e) return 0;
    return EXIT_W * smoothstep(e.s0, e.s0 + EXIT_TAPER, s) * (1 - smoothstep(e.sEnd - EXIT_TAPER, e.sEnd, s));
  }

  /** 1 — площадка заправки (рельеф выравнивается до уровня дороги). */
  stationFlat(s: number): number {
    const e = this.exitNear(s, 0) ?? this.exitNear(s + 100, 0);
    if (!e) return 0;
    return 1 - smoothstep(60, 100, Math.abs(s - e.sStop));
  }

  /** Веса районов у индекса (общий временный объект — не хранить). */
  weightsAt(i: number): Weights { return this.biomes.weights(i * STEP, this.wTmp); }

  /** Уровень моря рядом с s (впереди до ahead м) или null. */
  seaLevelNear(s: number, ahead = 1500): number | null {
    const seg = this.biomes.coastNear(s, ahead, 400);
    if (!seg) return null;
    if (!this.coastBase.has(seg.index)) this.ensure(Math.max(s, seg.start - 400) + STEP * 4);
    const b = this.coastBase.get(seg.index);
    return b === undefined ? null : b - 3.2;
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
    let target = clamp((t - this.y[i]) / 160, -0.05, 0.05) * intro;
    // у моря дорога выравнивается к уровню, на котором вошла в район побережья
    // заранее (за 1,5 км) запоминаем уровень и выравниваемся к нему — дорога у моря всегда выше воды
    const cs = this.biomes.coastNear(s, 1500, 300);
    let seaY = NaN;
    if (cs) {
      if (!this.coastBase.has(cs.index)) this.coastBase.set(cs.index, this.y[i]);
      const base = this.coastBase.get(cs.index)!;
      // пока побережье есть хоть немного — держим уровень строго; на подъезде — почти строго
      const wc = this.biomes.weights(s, this.wTmp).coast > 0 ? 1 : 0.85;
      target = lerp(target, clamp((base - this.y[i]) / 120, -0.04, 0.04), wc);
      seaY = base - 3.2;
    }
    this.slope += (target - this.slope) * 0.035;
    const ny = this.y[i] + this.slope * STEP;
    this.x.push(nx); this.y.push(ny); this.z.push(nz); this.h.push(nh); this.k.push(k);
    this.sea.push(seaY);
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
type ColFn = (i: number, j: number, p: THREE.Vector3) => number[];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _n = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();

function ribbon(i0: number, i1: number, cols: number, origin: THREE.Vector3, pos: PosFn, uv: UvFn, col?: ColFn, flip = false, colSize = 3) {
  const rows = i1 - i0 + 1;
  const P = new Float32Array(rows * cols * 3);
  const N = new Float32Array(rows * cols * 3);
  const U = new Float32Array(rows * cols * 2);
  const C = col ? new Float32Array(rows * cols * colSize) : null;
  // кеш точек: ряды i0-1 … i1+1 (соседние ряды за пределами чанка → нормали без швов)
  const ext = rows + 2;
  const G = new Float64Array(ext * cols * 3);
  for (let r = 0; r < ext; r++) {
    const i = Math.max(0, i0 - 1 + r);
    for (let j = 0; j < cols; j++) {
      pos(i, j, _a);
      const q = (r * cols + j) * 3;
      G[q] = _a.x; G[q + 1] = _a.y; G[q + 2] = _a.z;
    }
  }
  const gp = (r: number, j: number, out: THREE.Vector3) => {
    const q = ((r + 1) * cols + j) * 3;
    return out.set(G[q], G[q + 1], G[q + 2]);
  };
  for (let r = 0; r < rows; r++) {
    const i = i0 + r;
    for (let j = 0; j < cols; j++) {
      const k = r * cols + j;
      gp(r, j, _a);
      P[k * 3] = _a.x - origin.x; P[k * 3 + 1] = _a.y - origin.y; P[k * 3 + 2] = _a.z - origin.z;
      // центральные разности по кешу
      gp(r + 1, j, _b); gp(r - 1, j, _c);
      _t1.subVectors(_b, _c);
      gp(r, Math.min(cols - 1, j + 1), _b); gp(r, Math.max(0, j - 1), _d);
      _t2.subVectors(_b, _d);
      _n.crossVectors(_t2, _t1);
      // вырожденная (нулевой ширины) полоса — нормаль «вверх», иначе в шейдере normalize(0) = NaN → чёрные вспышки
      if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0); else _n.normalize();
      if (flip) _n.negate();
      N[k * 3] = _n.x; N[k * 3 + 1] = _n.y; N[k * 3 + 2] = _n.z;
      const [u, v] = uv(i, j);
      U[k * 2] = u; U[k * 2 + 1] = v;
      if (C && col) {
        const cv = col(i, j, _a);
        for (let q = 0; q < colSize; q++) C[k * colSize + q] = cv[q];
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
  if (C) g.setAttribute('color', new THREE.BufferAttribute(C, colSize));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export interface RoadMaterials {
  road: THREE.MeshStandardMaterial;
  exitLine: THREE.MeshStandardMaterial;
  dashCover: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
  post: THREE.MeshStandardMaterial;
  setSnow(amount: number): void;
  setAutumnGrass(enabled: boolean): void;
}

export function makeRoadMaterials(tex: RoadTextures, ground: { map: THREE.Texture; normalMap: THREE.Texture },
  gravel: { map: THREE.Texture; normalMap: THREE.Texture }, anisotropy: number,
  sand: { map: THREE.Texture; normalMap: THREE.Texture }): RoadMaterials {
  for (const t of [tex.map, tex.normalMap, tex.roughnessMap, ground.map, ground.normalMap, gravel.map, gravel.normalMap, sand.map]) {
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
  const autumnGrass = { value: 0 };
  // Трава ↔ песок по альфе цвета вершин. Осенью меняем только траву.
  groundM.onBeforeCompile = (sh) => {
    sh.uniforms.sandMap = { value: sand.map };
    sh.uniforms.autumnGrass = autumnGrass;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D sandMap;\nuniform float autumnGrass;')
      .replace('#include <map_fragment>',
        /* glsl */ `
          vec4 grassColor = texture2D(map, vMapUv);
          vec4 sandColor = texture2D(sandMap, vMapUv * 0.6);
          float grassShade = dot(grassColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 dryGrass = grassShade * vec3(1.85, 1.30, 0.37);
          grassColor.rgb = mix(grassColor.rgb, dryGrass, autumnGrass);
          diffuseColor *= mix(grassColor, sandColor * 1.15, clamp(vColor.a, 0.0, 1.0));
        `)
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vColor.rgb;');
  };
  groundM.customProgramCacheKey = () => 'ground-seasonal-grass';
  const rail = new THREE.MeshStandardMaterial({ color: 0xb4b9bc, metalness: 0.85, roughness: 0.36, side: THREE.DoubleSide });
  const post = new THREE.MeshStandardMaterial({ color: 0x8d9295, metalness: 0.7, roughness: 0.55 });
  // разрывы краевой линии у съезда: полоса асфальта поверх линии с альфа-маской 6 м / 6 м
  const dashMask = (() => {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000'; g.fillRect(0, 0, 4, 64);
    g.fillStyle = '#fff'; g.fillRect(0, 0, 4, 32);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    return t;
  })();
  const dashCover = new THREE.MeshStandardMaterial({
    map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap, roughness: 1, alphaMap: dashMask, alphaTest: 0.5,
    normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 0.55, polygonOffset: true, polygonOffsetFactor: -2,
  });
  const exitLine = new THREE.MeshStandardMaterial({ color: 0xc9c8c1, roughness: 0.62, polygonOffset: true, polygonOffsetFactor: -2 });
  const setSnow = addSnowCover([road, dashCover], gravelM, groundM);
  const setAutumnGrass = (enabled: boolean) => { autumnGrass.value = Number(enabled); };
  return { road, gravel: gravelM, ground: groundM, rail, post, exitLine, dashCover, setSnow, setAutumnGrass };
}

// поперечный профиль W-образного отбойника: (вбок от дороги, вверх), м
const RAIL_PROFILE: [number, number][] = [
  [0.0, 0.50], [0.05, 0.53], [0.075, 0.57], [0.075, 0.59], [0.035, 0.625], [0.035, 0.655],
  [0.075, 0.69], [0.075, 0.71], [0.05, 0.75], [0.0, 0.78],
];

class Chunk {
  readonly group = new THREE.Group();
  build?: Generator<void, void, void>;
  scattered = false;
  constructor(readonly index: number) {}
  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
      if (!m.userData.sharedGeo) m.geometry.dispose();
    });
    this.group.removeFromParent();
  }
}

const _gA = new THREE.Vector3(), _gB = new THREE.Vector3();

export class RoadWorld {
  readonly path: RoadPath;
  readonly group = new THREE.Group();
  private chunks = new Map<number, Chunk>();
  private postGeo: THREE.BufferGeometry;
  readonly far: FarTerrain;
  treeSeason: TreeSeason = 'summer';

  get snow() { return this.treeSeason === 'winter'; }

  setSeason(season: TreeSeason) {
    if (this.treeSeason === season) return;
    this.treeSeason = season;
    this.mats.setAutumnGrass(season === 'autumn');
    for (const chunk of this.chunks.values()) {
      for (const object of chunk.group.children) {
        if (object.userData.winterOnly) object.visible = this.snow;
        if (object instanceof THREE.InstancedMesh && object.userData.seasonalGeometry) {
          const geometries = object.userData.seasonalGeometry;
          object.geometry = geometries[season];
        }
      }
    }
  }

  readonly kit: PropKit;

  constructor(seed: number, readonly mats: RoadMaterials) {
    this.path = new RoadPath(seed);
    this.kit = new PropKit();
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

  /** Освобождает все загруженные чанки (дальний рельеф и материалы — disposeObject сцены). */
  dispose() {
    for (const chunk of this.chunks.values()) chunk.dispose();
    this.chunks.clear();
  }

  /** Подгрузка/выгрузка чанков вокруг позиции s. */
  update(s: number, carPos: THREE.Vector3) {
    this.path.ensure(s + AHEAD + CHUNK_LEN * 2);
    const first = Math.max(0, Math.floor((s - BEHIND) / CHUNK_LEN));
    const last = Math.floor((s + AHEAD) / CHUNK_LEN);
    for (const [k, c] of this.chunks) {
      if (k < first || k > last) { c.dispose(); this.chunks.delete(k); }
    }
    // Подгрузка ближнего чанка и пересчёт дальнего рельефа делят время кадра.
    const stats = RoadWorld.stats;
    let preparedChunk = false;
    for (let k = first; k <= last; k++) {
      let c = this.chunks.get(k);
      if (c?.scattered) continue;
      const t0 = stats ? performance.now() : 0;
      if (!c) {
        c = new Chunk(k);
        c.build = this.buildChunk(c);
        this.chunks.set(k, c);
      }
      if (c.build) {
        if (c.build.next().done) c.build = undefined;
        stats?.base.push(performance.now() - t0);
      } else {
        this.scatter(c);
        stats?.scatter.push(performance.now() - t0);
      }
      preparedChunk = true;
      break;
    }
    if (!preparedChunk) {
      const tf = stats ? performance.now() : 0;
      this.far.update(carPos, this.priming);
      stats?.far.push(performance.now() - tf);
    }
    return preparedChunk;
  }
  private priming = false;
  /** Замеры стадий постройки (включаются только в режиме проверки). */
  static stats: { base: number[]; scatter: number[]; far: number[] } | null = null;

  /** Точка земли ленты рельефа (как её строит меш): so — смещение со знаком стороны. */
  groundRaw(i: number, so: number, out: THREE.Vector3) {
    const p = this.path, half = ROAD.half;
    const o = Math.abs(so);
    // справа обочина сдвигается на ширину полосы съезда; у заправки рельеф ровный
    const e = so > 0 ? p.extraAt(i * STEP) : 0;
    const flat = so > 0 ? p.stationFlat(i * STEP) : 0;
    const oRel = o - e;
    p.point(i, so, 0, out);
    const roadLevel = out.y - 0.15;
    const ditch = -0.9 * Math.exp(-(((oRel - (half + 3.6)) / 1.6) ** 2)) * (1 - flat);
    const blend = smoothstep(half + 6, 80, oRel) * (1 - flat * (1 - smoothstep(half + 46, half + 95, o)));
    out.y = blend === 0
      ? roadLevel + ditch
      : roadLevel + (biomeTerrain(p, i, out.x, out.z, so) - roadLevel) * blend + ditch * (1 - blend);
    return out;
  }

  /** Смещения колонок ленты рельефа у индекса i (справа — со сдвигом на полосу съезда). */
  groundOffs(i: number, side: number): number[] {
    const e = side > 0 ? this.path.extraAt(i * STEP) : 0;
    if (e === 0) return GROUND_OFFS;
    return GROUND_OFFS.map((o) => o + e * (1 - smoothstep(30, 90, o)));
  }

  /** Высота поверхности ленты в произвольном смещении (линейно между колонками, как у меша). */
  groundAt(i: number, so: number): number {
    const o = Math.abs(so), side = Math.sign(so) || 1;
    const offs = this.groundOffs(i, side);
    if (o <= offs[0]) return this.path.y[i] - 0.2;
    let j = 0;
    while (j < offs.length - 2 && offs[j + 1] < o) j++;
    const t = clamp((o - offs[j]) / (offs[j + 1] - offs[j]), 0, 1);
    const a = this.groundRaw(i, side * offs[j], _gA).y, b = this.groundRaw(i, side * offs[j + 1], _gB).y;
    return a + (b - a) * t;
  }

  /** Второй шаг постройки чанка: обочина (объекты районов, здания, знаки). */
  private scatter(c: Chunk) {
    const i0 = c.index * CHUNK_STEPS;
    scatterChunk(this, c.index, i0, i0 + CHUNK_STEPS, c.group.position.clone(), c.group);
    c.scattered = true;
  }

  /** Сразу построить всё (для старта). */
  prime(s: number, carPos: THREE.Vector3) {
    this.priming = true;
    try {
      while (this.update(s, carPos)) { /* Построить все участки перед первым кадром. */ }
    } finally {
      this.priming = false;
    }
  }

  private *buildChunk(c: Chunk): Generator<void, void, void> {
    const k = c.index;
    const p = this.path;
    const i0 = k * CHUNK_STEPS, i1 = i0 + CHUNK_STEPS;
    p.ensure((i1 + 2) * STEP);
    const origin = new THREE.Vector3(p.x[i0], p.y[i0], p.z[i0]);
    c.group.position.copy(origin);
    const half = ROAD.half;
    const vOf = (i: number, period: number) => ((i - i0) * STEP) / period;

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
      const ex = (i: number) => (side > 0 ? p.extraAt(i * STEP) : 0);
      const gravel = ribbon(i0, i1, 3, origin,
        (i, j, out) => {
          const o = gOff[side < 0 ? 2 - j : j];
          const drop = o <= half ? 0 : -0.05 - (o - half - 0.5) * 0.12;
          return p.point(i, side * (o + ex(i)), drop, out);
        },
        (i, j) => [gOff[side < 0 ? 2 - j : j] / 1.5, vOf(i, 2)]);
      const gm = new THREE.Mesh(gravel, this.mats.gravel);
      gm.receiveShadow = true;
      c.group.add(gm);

      // лента рельефа: кювет у дороги → плавный переход к естественному рельефу
      const NC = GROUND_OFFS.length;
      const oAt = (j: number) => GROUND_OFFS[side < 0 ? NC - 1 - j : j];
      let offsetRow = -1;
      let offsets = GROUND_OFFS;
      const oAtI = (i: number, j: number) => {
        if (offsetRow !== i) {
          offsets = this.groundOffs(i, side);
          offsetRow = i;
        }
        return offsets[side < 0 ? NC - 1 - j : j];
      };
      const groundPos: PosFn = (i, j, out) => this.groundRaw(i, side * oAtI(i, j), out);
      const ground = ribbon(i0, i1, NC, origin, groundPos,
        (i, j) => [oAt(j) / 6, vOf(i, 6)],
        (i, j, pt) => groundRGBA(p, i, pt.x, pt.z, side * oAtI(i, j)), false, 4);
      const grm = new THREE.Mesh(ground, this.mats.ground);
      grm.receiveShadow = true;
      c.group.add(grm);

      // 4) отбойник (на обеих сторонах, непрерывный)
      const railO = half + 1.1;
      const NP = RAIL_PROFILE.length;
      // у заправки справа отбойника нет — строим его отрезками
      const railHere = (i: number) => side < 0 || p.stationFlat(i * STEP) < 0.02;
      for (let a = i0; a < i1;) {
        while (a < i1 && !railHere(a)) a++;
        let b = a;
        while (b < i1 && railHere(b + 1)) b++;
        if (b > a) {
          const rail = ribbon(a, b, NP, origin,
            (i, j, out) => {
              const [lat, up] = RAIL_PROFILE[j];
              return p.point(i, side * (railO + ex(i) - lat), up - 0.05, out);
            },
            (i, j) => [j / (NP - 1), vOf(i, 4)], undefined, side < 0);
          const rm = new THREE.Mesh(rail, this.mats.rail);
          rm.castShadow = true;
          rm.receiveShadow = true;
          c.group.add(rm);
        }
        a = b + 1;
      }

      // стойки каждые 4 м
      const count = CHUNK_STEPS / 2;
      const posts = new THREE.InstancedMesh(this.postGeo, this.mats.post, count);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
      const pt = new THREE.Vector3();
      for (let n = 0; n < count; n++) {
        const i = i0 + n * 2;
        if (!railHere(i)) { m.makeScale(0, 0, 0); posts.setMatrixAt(n, m); continue; }
        p.point(i, side * (railO + ex(i) + 0.12), -0.1, pt);
        // проставка смотрит к дороге: справа разворот на 180°
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.h[i] + (side > 0 ? Math.PI : 0));
        m.compose(pt.sub(origin), q, sc);
        posts.setMatrixAt(n, m);
      }
      posts.castShadow = true;
      posts.receiveShadow = true;
      posts.computeBoundingSphere();
      c.group.add(posts);
      yield;
    }

    // 5) полоса съезда: асфальт, сплошная линия по её краю, разрывы основной краевой линии
    let hasExit = false;
    for (let i = i0; i <= i1; i += 4) if (p.extraAt(i * STEP) > 0.01) { hasExit = true; break; }
    if (hasExit) {
      const exW = (i: number) => p.extraAt(i * STEP);
      const lane = ribbon(i0, i1, 4, origin,
        (i, j, out) => p.point(i, half + (exW(i) * j) / 3, 0, out),
        (i, j) => [0.905 + 0.09 * (j / 3), vOf(i, ROAD.period)]);
      const lm = new THREE.Mesh(lane, this.mats.road);
      lm.receiveShadow = true;
      c.group.add(lm);
      const edge = ribbon(i0, i1, 2, origin,
        (i, j, out) => {
          const e = exW(i);
          return p.point(i, half + Math.max(0, e - 0.32 + j * 0.15) * Math.min(1, e / 0.5), 0.006, out);
        },
        (i, j) => [j, vOf(i, ROAD.period)]);
      c.group.add(new THREE.Mesh(edge, this.mats.exitLine));
      const edgeL = half - ROAD.shoulder;
      const dash = ribbon(i0, i1, 2, origin,
        (i, j, out) => p.point(i, edgeL - 0.13 + j * 0.26, 0.004 + (exW(i) > 1 ? 0 : -0.05), out),
        (i) => [0.915, vOf(i, ROAD.period)]);
      const dm = new THREE.Mesh(dash, this.mats.dashCover);
      dm.receiveShadow = true;
      c.group.add(dm);
    }

    this.group.add(c.group);
  }
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
export class FarTerrain {
  readonly mesh: THREE.Mesh;
  private geo: THREE.PlaneGeometry;
  private center = new THREE.Vector2(Infinity, Infinity);
  private readonly size = 2400;
  private readonly segs = 160;
  private readonly sampleCount = (this.segs + 1) ** 2;
  private readonly staging = {
    P: new Float32Array(this.sampleCount * 3),
    N: new Float32Array(this.sampleCount * 3),
    C: new Float32Array(this.sampleCount * 4),
    U: new Float32Array(this.sampleCount * 2),
    M: new Uint8Array(this.sampleCount * 4),
  };

  constructor(private path: RoadPath, mat: THREE.MeshStandardMaterial) {
    this.geo = new THREE.PlaneGeometry(this.size, this.size, this.segs, this.segs);
    this.geo.rotateX(-Math.PI / 2);
    const n = this.geo.getAttribute('position').count;
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    const sn = this.segs + 1;
    this.seaMask = new THREE.DataTexture(new Uint8Array(sn * sn * 4), sn, sn, THREE.RGBAFormat);
    this.seaMask.magFilter = this.seaMask.minFilter = THREE.LinearFilter;
    this.seaMask.needsUpdate = true;
  }

  private job: ({ cx: number; cz: number; row: number; level: number } & FarTerrain['staging']) | null = null;
  private readonly edgeA = new THREE.Vector3();
  private readonly edgeB = new THREE.Vector3();
  /**
   * Маска моря на ту же сетку (1 — вода): вода только со стороны моря у участков побережья,
   * иначе плоскость моря затапливала бы низины и дорогу на подъезде к побережью.
   */
  readonly seaMask: THREE.DataTexture;
  /** Уровень моря для текущей маски (NaN — моря нет). */
  seaLevel = NaN;
  readonly seaCenter = new THREE.Vector2();
  readonly gridSize = 2400;

  private accumulateNormals(row: number, positions: Float32Array, normals: Float32Array) {
    // PlaneGeometry хранит по два треугольника на ячейку, строки идут подряд.
    const indices = this.geo.index!.array;
    const start = row * this.segs * 6;
    for (let i = start; i < start + this.segs * 6; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const cb = this.edgeA.set(positions[c] - positions[b], positions[c + 1] - positions[b + 1], positions[c + 2] - positions[b + 2]);
      const ab = this.edgeB.set(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
      cb.cross(ab);
      for (let j = i; j < i + 3; j++) {
        const k = indices[j] * 3;
        normals[k] += cb.x;
        normals[k + 1] += cb.y;
        normals[k + 2] += cb.z;
      }
    }
  }

  private normalizeRow(row: number, normals: Float32Array) {
    const start = row * (this.segs + 1) * 3;
    for (let i = start; i < start + (this.segs + 1) * 3; i += 3) {
      const n = this.edgeA.fromArray(normals, i).normalize();
      normals[i] = n.x;
      normals[i + 1] = n.y;
      normals[i + 2] = n.z;
    }
  }

  /** Пересчёт сетки — порциями по рядам, чтобы не было рывка в кадре; full — сразу целиком. */
  update(car: THREE.Vector3, full = false) {
    const snap = 120;
    const cx = Math.round(car.x / snap) * snap, cz = Math.round(car.z / snap) * snap;
    if (full && this.job && (this.job.cx !== cx || this.job.cz !== cz)) this.job = null;
    if (!this.job) {
      if (cx === this.center.x && cz === this.center.y) return;
      const pi = this.path.indexAtZ(car.z);
      const level = this.path.seaLevelNear(pi * 2, 1300);
      this.staging.N.fill(0);
      this.job = { cx, cz, row: 0, ...this.staging, level: level ?? NaN };
    }
    const job = this.job;
    const half = this.size / 2;
    const step = this.size / this.segs;
    const p = this.path;
    const deadline = full ? Infinity : performance.now() + 2.5;
    const rEnd = full ? this.segs + 1 : Math.min(this.segs + 1, job.row + 12);
    do {
      const r = job.row++;
      const lz = -half + r * step, wz = job.cz + lz;
      const i = p.indexAtZ(wz);
      const weights = p.weightsAt(i);
      const coastSide = weights.coast > 0 ? p.biomes.coastNear(i * STEP)?.seaSide ?? 0 : 0;
      const rightX = -Math.cos(p.h[i]), rightZ = Math.sin(p.h[i]);
      const roadHeight = p.y[i], roadX = p.x[i], roadZ = p.z[i];
      const inRoadRange = wz >= p.z[0] - 50 && wz <= p.z[p.z.length - 1];
      const nearWater = !Number.isNaN(job.level) && Math.abs(p.sea[i] - job.level) < 0.6 && weights.coast > 0.02;
      for (let c = 0; c <= this.segs; c++) {
        const k = r * (this.segs + 1) + c;
        const lx = -half + c * step, wx = job.cx + lx;
        const so = (wx - roadX) * rightX + (wz - roadZ) * rightZ;
        let y = biomeTerrain(p, i, wx, wz, so, weights, coastSide);
        const d = Math.abs(so);
        if (inRoadRange) {
          if (d < GROUND_FAR - 30) y = Math.min(y, roadHeight) - 25;
          else y -= 1.2 * (1 - smoothstep(GROUND_FAR, GROUND_FAR + 120, d));
        }
        job.P[k * 3] = lx; job.P[k * 3 + 1] = y; job.P[k * 3 + 2] = lz;
        job.U[k * 2] = wx / 6; job.U[k * 2 + 1] = wz / 6;
        job.C.set(groundRGBA(p, i, wx, wz, so, weights, coastSide), k * 4);
        // Маска моря: строка текстуры снизу вверх.
        const water = nearWater && so * coastSide > 10 ? 255 : 0;
        const mk = ((this.segs - r) * (this.segs + 1) + c) * 4;
        job.M[mk] = job.M[mk + 1] = job.M[mk + 2] = water; job.M[mk + 3] = 255;
      }
      if (r > 0) {
        this.accumulateNormals(r - 1, job.P, job.N);
        this.normalizeRow(r - 1, job.N);
      }
      if (r === this.segs) this.normalizeRow(r, job.N);
    } while (job.row < rEnd && performance.now() < deadline);
    if (job.row <= this.segs) return;
    // готово — подменяем данные сетки разом
    (this.geo.getAttribute('position') as THREE.BufferAttribute).copyArray(job.P).needsUpdate = true;
    (this.geo.getAttribute('color') as THREE.BufferAttribute).copyArray(job.C).needsUpdate = true;
    (this.geo.getAttribute('uv') as THREE.BufferAttribute).copyArray(job.U).needsUpdate = true;
    (this.geo.getAttribute('normal') as THREE.BufferAttribute).copyArray(job.N).needsUpdate = true;
    this.mesh.position.set(job.cx, 0, job.cz);
    this.center.set(job.cx, job.cz);
    this.seaMask.image.data!.set(job.M);
    this.seaMask.needsUpdate = true;
    this.seaLevel = job.level;
    this.seaCenter.set(job.cx, job.cz);
    this.job = null;
  }
}

/** Рельеф с учётом района: лес холмистее, в пустыне дюны, город и пригород выровнены, у моря — пляж и спуск под воду. */
export function biomeTerrain(p: RoadPath, i: number, x: number, z: number, so: number,
  w = p.weightsAt(i), coastSide?: number): number {
  const seed = p.seed;
  let h = terrainHeight(x, z, seed);
  if (w.forest > 0) h += w.forest * (fbm2(x / 260, z / 260, 3, seed + 404) - 0.35) * 26;
  if (w.desert > 0) {
    const n = fbm2(x / 150, z / 95, 3, seed + 505);
    h += w.desert * (Math.pow(1 - Math.abs(2 * n - 1), 2) * 10 - 3);
  }
  const ao = Math.abs(so);
  const flat = (w.city * 0.92 + w.suburb * 0.55) * (1 - smoothstep(140, 420, ao));
  if (flat > 0) h = lerp(h, p.y[i] - 0.4 + (fbm2(x / 80, z / 80, 2, seed + 6) - 0.5) * 2.4, flat);
  const sea = p.sea[i];
  if (w.coast > 0 && !Number.isNaN(sea)) {
    const side = coastSide ?? p.biomes.coastNear(i * STEP)?.seaSide ?? 0;
    if (side && Math.sign(so) === side) {
      const beach = Math.max(sea - 16, sea + 1.3 - (ao - 20) * 0.075);
      h = lerp(h, beach, w.coast * smoothstep(12, 36, ao));
    }
  }
  return h;
}

/** Цвет земли (RGB — оттенок травы, A — доля песка). */
export function groundRGBA(p: RoadPath, i: number, x: number, z: number, so: number,
  w = p.weightsAt(i), coastSide?: number): [number, number, number, number] {
  const seed = p.seed;
  const ao = Math.abs(so);
  const dry = fbm2(x / 70, z / 70, 3, seed + 7);
  const lush = fbm2(x / 23, z / 23, 3, seed + 8);
  const dust = 1 - smoothstep(ROAD.half + 1, ROAD.half + 9, ao);
  let r = 0.95 + dry * 0.25 + dust * 0.15, g = 0.95 + lush * 0.1 - dry * 0.05, b = 0.9 + dust * 0.1;
  const v = 0.85 + lush * 0.25;
  r *= v; g *= v; b *= v;
  // оттенки районов
  const tr = w.forest * 0.82 + w.city * 0.95 + w.suburb * 1.0 + w.desert * 1.05 + w.coast * 1.08;
  const tg = w.forest * 1.0 + w.city * 0.95 + w.suburb * 1.0 + w.desert * 0.95 + w.coast * 1.0;
  const tb = w.forest * 0.8 + w.city * 0.92 + w.suburb * 0.95 + w.desert * 0.85 + w.coast * 0.82;
  let sand = w.desert * clamp(0.75 + (dry - 0.5) * 0.8, 0, 1);
  if (w.coast > 0) {
    const side = coastSide ?? p.biomes.coastNear(i * STEP)?.seaSide ?? 0;
    if (side && Math.sign(so) === side) sand = Math.max(sand, w.coast * smoothstep(9, 22, ao));
    else sand = Math.max(sand, w.coast * 0.25 * smoothstep(0.55, 0.8, dry));
  }
  return [r * tr, g * tg, b * tb, sand];
}
