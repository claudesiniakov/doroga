import * as THREE from 'three';
import { clamp } from './noise';
import { makePlateTexture } from './textures';

export interface CarConfig {
  id: string;
  name: string;
  tagline: string;
  color: string;
  maxSpeedKmh: number;
  accel: number;        // м/с²
  brake: number;        // м/с²
  laneChangeTime: number;
  plate: string;
  /** Объём бака, л. */
  tankL: number;
  body?: 'coupe' | 'suv' | 'van' | 'vette' | 'classic';
  /** Множитель крена/клевка кузова (мягкая подвеска > 1). */
  roll?: number;
  stats: { speed: number; accel: number; handling: number; brakes: number };
}

/** Монотонная кубическая интерполяция (Фрич–Карлсон) по отсортированным x. */
export function spline(pts: [number, number][]) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// ——— силуэт купе (метры; +Z — вперёд, Y — вверх) ———
export const DIM = {
  halfLen: 2.25,
  wheelR: 0.33,
  frontAxle: 1.38,
  rearAxle: -1.32,
  track: 0.775,
  archR: 0.375,
};

const topY = spline([[-2.25, 0.76], [-2.21, 0.9], [-2.08, 0.955], [-1.6, 0.95], [-1.0, 0.918], [0.0, 0.884], [0.9, 0.848],
  [1.38, 0.805], [1.85, 0.735], [2.12, 0.655], [2.25, 0.5]]);
const baseBottom = spline([[-2.25, 0.42], [-2.12, 0.29], [-1.75, 0.215], [1.8, 0.2], [2.1, 0.225], [2.25, 0.32]]);
const widthRaw = spline([[-2.25, 0.86], [-1.9, 0.925], [-1.3, 0.958], [-0.6, 0.932], [0.1, 0.905], [0.9, 0.918],
  [1.4, 0.93], [1.9, 0.885], [2.25, 0.79]]);

function archLift(z: number) {
  let y = 0;
  for (const az of [DIM.frontAxle, DIM.rearAxle]) {
    const dz = z - az;
    if (Math.abs(dz) < DIM.archR) y = Math.max(y, DIM.wheelR + Math.sqrt(DIM.archR ** 2 - dz * dz));
  }
  return y;
}

function bottomY(z: number) { return Math.max(baseBottom(z), archLift(z)); }

function halfWidth(z: number) {
  const u = z / DIM.halfLen;
  const p = u > 0 ? 5.5 : 16;
  const f = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), p)), 1 / p);
  return widthRaw(z) * f;
}

// показатель суперэллипса: низ боковины почти вертикальный, верх — скруглённое плечо
const seOf = (s: number) => (s < 0 ? 7 : 3.4);

/** Точка сечения кузова: s = sin θ в [-1, 1] (низ → верх), сторона ±1. */
function sectionPoint(z: number, s: number, side: number, out: THREE.Vector3) {
  const top = topY(z);
  const bot = Math.min(bottomY(z), top - 0.05);
  const cy = (top + bot) / 2, hy = (top - bot) / 2;
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  const e = seOf(s);
  const y = cy + hy * Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
  let x = halfWidth(z) * Math.pow(c, 2 / e);
  x *= 1 - 0.1 * Math.pow(Math.max(s, 0), 2) - 0.07 * Math.pow(Math.max(-s, 0), 3);
  return out.set(side * x, y, z);
}

/** Полуширина кузова на высоте y в сечении z (для привязки фар и фонарей к поверхности). */
function sectionXAt(z: number, y: number) {
  const top = topY(z);
  const bot = Math.min(bottomY(z), top - 0.05);
  const cy = (top + bot) / 2, hy = (top - bot) / 2;
  const q = clamp((y - cy) / hy, -1, 1);
  const e = seOf(q);
  const s = Math.sign(q) * Math.pow(Math.abs(q), e / 2);
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  let x = halfWidth(z) * Math.pow(c, 2 / e);
  x *= 1 - 0.1 * Math.pow(Math.max(s, 0), 2) - 0.07 * Math.pow(Math.max(-s, 0), 3);
  return x;
}

/** z поверхности на торце (front=+1/rear=-1) для точки (x, y). */
function surfaceZ(x: number, y: number, end: 1 | -1) {
  // от торца внутрь, пока сечение не станет шире |x| (бинарный поиск ломается об арки)
  for (let m = DIM.halfLen; m > 1.4; m -= 0.0015) {
    if (sectionXAt(end * m, y) >= Math.abs(x)) return end * m;
  }
  return end * 1.4;
}

/** Лофт: ряды (станции по z) × кольцо точек; материалы назначаются по квадам. */
/**
 * Станции лофта по длине: гуще к торцам (синус) и очень густо у колёсных арок —
 * край арки почти вертикален, при редких сечениях он рисуется «лесенкой».
 */
export function bodyStations(halfLen: number, N: number, axles: number[], archR: number): number[] {
  const zs: number[] = [];
  for (let r = 0; r < N; r++) zs.push(halfLen * Math.sin(((-1 + (2 * r) / (N - 1)) * Math.PI) / 2) * 0.9995);
  for (const az of axles) {
    for (let z = az - archR - 0.06; z <= az + archR + 0.06; z += 0.012) zs.push(z);
  }
  zs.sort((a, b) => a - b);
  return zs.filter((z, i) => i === 0 || z - zs[i - 1] > 0.004);
}

export function loft(rows: THREE.Vector3[][], classify: (a: THREE.Vector3, r: number, c: number) => number, closed: boolean, ccw: boolean) {
  const R = rows.length, C = rows[0].length;
  const pos: number[] = [];
  for (const row of rows) for (const p of row) pos.push(p.x, p.y, p.z);
  const groups = new Map<number, number[]>();
  const mid = new THREE.Vector3();
  const cols = closed ? C : C - 1;
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const c1 = (c + 1) % C;
      const a = r * C + c, b = r * C + c1, d = (r + 1) * C + c, e = (r + 1) * C + c1;
      mid.copy(rows[r][c]).add(rows[r][c1]).add(rows[r + 1][c]).add(rows[r + 1][c1]).multiplyScalar(0.25);
      const g = classify(mid, r, c);
      if (!groups.has(g)) groups.set(g, []);
      if (ccw) groups.get(g)!.push(a, b, d, b, e, d);
      else groups.get(g)!.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const idx: number[] = [];
  for (const [g, list] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
    geo.addGroup(idx.length, list.length, g);
    for (let k = 0; k < list.length; k++) idx.push(list[k]); // без распаковки: на густых сетках она переполняет стек
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export interface CarModel {
  root: THREE.Group;      // позиция/ориентация на дороге (точка — земля под центром)
  body: THREE.Group;      // крен/тангаж кузова
  wheels: { spin: THREE.Group; steer: THREE.Group; front: boolean }[];
  paint: THREE.MeshPhysicalMaterial;
  tailMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  setBrake(on: number): void;
  setHeadlights(on: number): void;
  /** Ливрея страховки (если у машины есть). */
  setLivery?(on: boolean): void;
  length: number;
  width: number;
  wheelR: number;
}

export function buildCar(cfg: CarConfig, envIntensity = 1): CarModel {
  const root = new THREE.Group();
  root.name = 'car';
  const body = new THREE.Group();
  root.add(body);

  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(cfg.color), metalness: 0.35, roughness: 0.28,
    clearcoat: 1, clearcoatRoughness: 0.035, envMapIntensity: envIntensity,
  });
  const black = new THREE.MeshPhysicalMaterial({ color: 0x0b0b0c, roughness: 0.45, metalness: 0.1, clearcoat: 0.3, envMapIntensity: envIntensity });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0c1218, roughness: 0.02, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.01,
    envMapIntensity: 1.6 * envIntensity, reflectivity: 0.9,
  });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe8eaee, metalness: 1, roughness: 0.12, envMapIntensity: envIntensity });
  const under = new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.9 });

  // ——— кузов ———
  const N = 120, M = 30; // станции по длине, точек на половину кольца
  const rows: THREE.Vector3[][] = [];
  for (const z of bodyStations(DIM.halfLen, N, [DIM.frontAxle, DIM.rearAxle], DIM.archR)) {
    const ring: THREE.Vector3[] = [];
    // правая сторона снизу вверх, затем левая сверху вниз — замкнутое кольцо
    for (let k = 0; k < M; k++) ring.push(sectionPoint(z, -1 + (2 * k) / (M - 1), 1, new THREE.Vector3()));
    for (let k = M - 2; k > 0; k--) ring.push(sectionPoint(z, -1 + (2 * k) / (M - 1), -1, new THREE.Vector3()));
    rows.push(ring);
  }
  // замыкаем торцы: кольцо стягивается к центру в той же плоскости (плоская крышка)
  const cap = (ring: THREE.Vector3[]) => {
    const c = ring.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
    return [0.55, 0].map((k) => ring.map((p) => p.clone().sub(c).multiplyScalar(k).add(c)));
  };
  const [r1, r0] = cap(rows[0]);
  const [f1, f0] = cap(rows[rows.length - 1]);
  rows.unshift(r0, r1);
  rows.push(f1, f0);
  const bodyGeo = loft(rows, (p) => {
    const ax = Math.abs(p.x);
    const bot = bottomY(p.z);
    // решётка радиатора и воздухозаборники
    if (p.z > 2.0 && p.y > 0.27 && p.y < 0.47 && ax < 0.6) return 1;
    if (p.z > 1.95 && p.y < 0.27) return 1;          // сплиттер
    if (p.z < -2.1 && p.y < 0.33) return 1;         // диффузор
    // пороги — по основной нижней линии, без колёсных арок (иначе чёрная «лесенка» по краю арки)
    if (p.y < baseBottom(p.z) + 0.075 && p.y < bot + 0.075 && ax > 0.55 && Math.abs(p.z) < 1.75) return 1;
    return 0;
  }, true, true);
  const bodyMesh = new THREE.Mesh(bodyGeo, [paint, black]);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  body.add(bodyMesh);

  // ——— «аквариум»: стёкла, стойки, крыша ———
  const zA = 0.93, zC = -1.42;
  const roofY = spline([[zC, topY(zC)], [-1.15, 1.03], [-0.8, 1.165], [-0.3, 1.245], [0.15, 1.235], [0.5, 1.12], [zA, topY(zA)]]);
  const GR = 70, GK = 32;
  const gRows: THREE.Vector3[][] = [];
  const sOf: number[] = [];
  for (let k = 0; k <= GK; k++) sOf.push(Math.sin((Math.PI * k) / GK));
  for (let r = 0; r < GR; r++) {
    const z = zC + ((zA - zC) * r) / (GR - 1);
    const yb = topY(z) - 0.012;
    const H = Math.max(0, roofY(z) - yb);
    const wb = sectionXAt(z, yb) - 0.035;
    const wr = Math.min(wb, 0.66);
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k <= GK; k++) {
      const phi = Math.PI - (Math.PI * k) / GK;
      const s = Math.sin(phi), c = Math.cos(phi);
      const a = wb + (wr - wb) * Math.min(1, s * 1.1);
      const x = Math.sign(c) * a * Math.pow(Math.abs(c), 2 / 2.6);
      const y = yb + H * Math.pow(s, 2 / 3.2);
      ring.push(new THREE.Vector3(x, y, z));
    }
    gRows.push(ring);
  }
  const ghGeo = loft(gRows, (p, _r, c) => {
    const s = (sOf[c] + sOf[c + 1]) / 2;
    const z = p.z;
    if (s < 0.07) return 2;                                            // уплотнитель
    if (z > 0.3) return s > 0.6 && s < 0.74 ? 0 : 1;                  // A-стойка
    if (z > -0.72) {
      if (s > 0.74) return 0;                                         // крыша
      if (Math.abs(z + 0.3) < 0.035) return 2;                        // B-стойка
      return 1;
    }
    // за B-стойкой: заднее стекло сверху, форточка спереди, остальное — сплошная C-стойка (без «завитков» на скосе)
    if (s > 0.8) return 1;
    if (s < 0.45 && z > -1.1) return 1;
    return 0;
  }, false, false);
  const gh = new THREE.Mesh(ghGeo, [paint, glass, black]);
  gh.castShadow = true;
  body.add(gh);

  // днище/подкапотное пространство между колёсами
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.46, 3.4), under);
  tub.position.set(0, 0.45, -0.05);
  body.add(tub);

  // ——— фары: светящиеся полосы, повторяющие форму носа ———
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f7ff, emissiveIntensity: 3.2, roughness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 2.2, roughness: 0.3 });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0c10, roughness: 0.05, metalness: 0.3, clearcoat: 1, envMapIntensity: 1.4 * envIntensity });

  const strip = (pts: THREE.Vector3[], r: number, mat: THREE.Material) => {
    const curve = new THREE.CatmullRomCurve3(pts);
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, r, 8, false), mat);
    body.add(m);
    return m;
  };
  const surfPts = (xs: number[], y: (x: number) => number, end: 1 | -1, inset: number) =>
    xs.map((x) => new THREE.Vector3(x, y(x), surfaceZ(x, y(x), end) + end * inset));
  for (const side of [-1, 1]) {
    // корпус фары (чёрное стекло) + две светодиодные полосы
    const xs = [0.36, 0.46, 0.56, 0.64, 0.7].map((x) => side * x);
    const yL = (x: number) => 0.6 + (Math.abs(x) - 0.36) * 0.12;
    const lens = surfPts(xs, yL, 1, -0.012);
    strip(lens, 0.042, lensMat);
    strip(surfPts(xs, (x) => yL(x) + 0.022, 1, 0.022), 0.008, headMat);
    strip(surfPts(xs.slice(0, 3), (x) => yL(x) - 0.02, 1, 0.02), 0.012, headMat);
  }
  // задний фонарь: сплошная полоса на всю ширину + угловые блоки
  {
    const xs: number[] = [];
    for (let i = 0; i <= 16; i++) xs.push(-0.78 + (1.56 * i) / 16);
    strip(surfPts(xs, () => 0.865, -1, -0.006), 0.026, lensMat);
    strip(surfPts(xs, () => 0.865, -1, 0.012), 0.011, tailMat);
    for (const side of [-1, 1]) {
      const cx = [0.58, 0.64, 0.7].map((x) => side * x);
      strip(surfPts(cx, () => 0.81, -1, 0.01), 0.018, tailMat);
    }
  }

  // ——— номерной знак сзади ———
  {
    const y = 0.56;
    const z = surfaceZ(0.27, y, -1) - 0.01;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112),
      new THREE.MeshStandardMaterial({ map: makePlateTexture(cfg.plate), roughness: 0.4, metalness: 0.2 }));
    plate.position.set(0, y, z);
    plate.rotation.y = Math.PI;
    body.add(plate);
  }

  // ——— зеркала ———
  for (const side of [-1, 1]) {
    const z = 0.72;
    const x = sectionXAt(z, topY(z) - 0.05) + 0.02;
    const housing = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), paint);
    housing.scale.set(0.085, 0.042, 0.06);
    housing.position.set(side * x, topY(z) + 0.1, z);
    housing.castShadow = true;
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.025, 0.05), black);
    stalk.position.set(side * (x - 0.06), topY(z) + 0.06, z + 0.02);
    const face = new THREE.Mesh(new THREE.CircleGeometry(1, 20), chrome);
    face.scale.set(0.07, 0.034, 1);
    face.position.set(side * x, topY(z) + 0.1, z - 0.052);
    face.rotation.y = Math.PI;
    body.add(housing, stalk, face);
  }

  // ——— зазоры дверей и ручки ———
  {
    const gapMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const line = (pts: THREE.Vector3[]) => {
      const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0045, 4, false), gapMat);
      body.add(m);
    };
    for (const side of [-1, 1]) {
      // передняя и задняя кромки двери: от порога до линии стёкол
      for (const z of [0.98, -0.5]) {
        const pts: THREE.Vector3[] = [];
        const y0 = bottomY(z) + 0.09, y1 = topY(z) - 0.03;
        for (let i = 0; i <= 10; i++) {
          const y = y0 + ((y1 - y0) * i) / 10;
          const zz = z + (z > 0 ? -0.06 : 0.04) * (i / 10) ** 2;
          pts.push(new THREE.Vector3(side * (sectionXAt(zz, y) + 0.0015), y, zz));
        }
        line(pts);
      }
      // нижняя кромка двери
      const lower: THREE.Vector3[] = [];
      for (let i = 0; i <= 12; i++) {
        const z = 0.98 - (1.48 * i) / 12;
        const y = bottomY(z) + 0.09;
        lower.push(new THREE.Vector3(side * (sectionXAt(z, y) + 0.0015), y, z));
      }
      line(lower);
      // утопленная ручка
      const hz = -0.3, hy = topY(hz) - 0.12;
      const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.14, 4, 8), chrome);
      handle.rotation.x = Math.PI / 2;
      handle.position.set(side * (sectionXAt(hz, hy) + 0.004), hy, hz);
      body.add(handle);
    }
  }

  // ——— спойлер-утка и выхлоп ———
  {
    for (const side of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.14, 24, 1, true), chrome);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(side * 0.5, 0.3, surfaceZ(0.5, 0.3, -1) + 0.02);
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.044, 24), under);
      inner.position.copy(pipe.position).add(new THREE.Vector3(0, 0, -0.04));
      inner.rotation.y = Math.PI;
      body.add(pipe, inner);
    }
  }

  // ——— диффузор с рёбрами под номером ———
  {
    const zr = surfaceZ(0.6, 0.3, -1);
    // целиком под кузовом: не шире заднего свеса и не выступает назад
    const diff = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.1, 0.3), black);
    diff.position.set(0, 0.27, zr + 0.2);
    body.add(diff);
    for (let i = -3; i <= 3; i++) {
      if (Math.abs(i) === 2) continue; // место под выхлоп
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.11, 0.3), black);
      if (Math.abs(i) > 2) continue;
      fin.position.set(i * 0.17, 0.26, zr + 0.16);
      body.add(fin);
    }
  }

  // ——— подкрылки и окантовка арок ———
  for (const az of [DIM.frontAxle, DIM.rearAxle]) {
    for (const side of [-1, 1]) {
      const liner = new THREE.Mesh(new THREE.CylinderGeometry(DIM.archR, DIM.archR, 0.26, 28, 1, true, 0, Math.PI), under);
      liner.material.side = THREE.DoubleSide;
      liner.rotation.z = Math.PI / 2;
      liner.position.set(side * (DIM.track - 0.08), DIM.wheelR, az);
      body.add(liner);
    }
  }

  // ——— колёса ———
  const wheels: CarModel['wheels'] = [];
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x131313, roughness: 0.86, metalness: 0 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xc4c8ce, metalness: 1, roughness: 0.2, envMapIntensity: envIntensity });
  const rimDark = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.8, roughness: 0.4 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0x77797c, metalness: 0.9, roughness: 0.42 });
  const caliperMat = new THREE.MeshPhysicalMaterial({ color: 0xd4141a, roughness: 0.35, clearcoat: 0.8 });

  const R = DIM.wheelR, rimR = 0.235, W = 0.255;
  const prof: THREE.Vector2[] = [];
  const shoulder = 0.035;
  prof.push(new THREE.Vector2(rimR, -W / 2 + 0.01));
  prof.push(new THREE.Vector2(R - 0.06, -W / 2));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    prof.push(new THREE.Vector2(R - shoulder + Math.cos(a) * shoulder, -W / 2 + shoulder + Math.sin(a) * shoulder));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    prof.push(new THREE.Vector2(R - shoulder + Math.cos(a) * shoulder, W / 2 - shoulder + Math.sin(a) * shoulder));
  }
  prof.push(new THREE.Vector2(R - 0.06, W / 2));
  prof.push(new THREE.Vector2(rimR, W / 2 - 0.01));
  const tireGeo = new THREE.LatheGeometry(prof, 64);
  tireGeo.rotateZ(Math.PI / 2);

  const spokeGeo = new THREE.BoxGeometry(0.03, rimR - 0.07, 0.034);
  spokeGeo.translate(0, (rimR - 0.07) / 2 + 0.065, 0);
  const barrelGeo = new THREE.CylinderGeometry(rimR, rimR, W - 0.03, 40, 1, true);
  barrelGeo.rotateZ(Math.PI / 2);
  const lipGeo = new THREE.TorusGeometry(rimR - 0.006, 0.011, 8, 48);
  lipGeo.rotateY(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.07, 0.075, 0.04, 24);
  hubGeo.rotateZ(Math.PI / 2);
  const discGeo = new THREE.CylinderGeometry(0.175, 0.175, 0.026, 40);
  discGeo.rotateZ(Math.PI / 2);

  for (const front of [true, false]) {
    for (const side of [-1, 1]) {
      const steer = new THREE.Group();
      steer.position.set(side * DIM.track, R, front ? DIM.frontAxle : DIM.rearAxle);
      const spin = new THREE.Group();
      steer.add(spin);
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      spin.add(tire);
      const barrel = new THREE.Mesh(barrelGeo, rimDark);
      barrel.material.side = THREE.DoubleSide;
      spin.add(barrel);
      const face = side * (W / 2 - 0.035);
      const lip = new THREE.Mesh(lipGeo, rimMat);
      lip.position.x = face;
      spin.add(lip);
      const hub = new THREE.Mesh(hubGeo, rimMat);
      hub.position.x = face - side * 0.01;
      spin.add(hub);
      // 5 сдвоенных спиц
      for (let k = 0; k < 10; k++) {
        const pair = Math.floor(k / 2), off = (k % 2 ? 1 : -1) * 0.075;
        const sp = new THREE.Mesh(spokeGeo, rimMat);
        sp.rotation.x = (pair / 5) * Math.PI * 2 + off;
        sp.position.x = face - side * 0.012;
        sp.castShadow = true;
        spin.add(sp);
      }
      // тормоз: диск и суппорт не вращаются вместе с колесом
      const disc = new THREE.Mesh(discGeo, discMat);
      disc.position.x = -side * 0.02;
      steer.add(disc);
      const cal = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.09), caliperMat);
      cal.position.set(side * 0.02, 0.1, front ? -0.1 : 0.1);
      cal.rotation.x = front ? 0.6 : -0.6;
      steer.add(cal);
      root.add(steer);
      wheels.push({ spin, steer, front });
    }
  }

  // мягкая контактная тень под машиной (заземляет её в любой сцене)
  {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.85)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 5.2),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.75 }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.012;
    blob.renderOrder = 1;
    root.add(blob);
  }

  return {
    root, body, wheels, paint, tailMat, headMat, length: 4.5, width: 1.9, wheelR: DIM.wheelR,
    setBrake(on: number) { tailMat.emissiveIntensity = 2.2 + on * 5; },
    setHeadlights(on: number) { headMat.emissiveIntensity = 3.2 + on * 3; },
  };
}
