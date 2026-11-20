import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Shape } from './traffic-models';
import { loft, spline, bodyStations, CarConfig, CarModel } from './car';
import { makePlateTexture } from './textures';
import absolutLogo from './brand/absolut-logo.svg?raw';

/**
 * Логотип страховщика (векторный, с сайта): знак «a.» — на двери, название в две строки — на корме.
 * В исходнике viewBox 0 0 279 61: знак занимает x 0…80, название — x 92…279.
 */
function brandTextures() {
  const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const markC = mk(1024, 1024), wordC = mk(2048, 460);
  const mark = new THREE.CanvasTexture(markC), word = new THREE.CanvasTexture(wordC);
  for (const t of [mark, word]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; }
  const img = new Image();
  img.onload = () => {
    const k = img.naturalWidth / 279;             // пикселей на единицу viewBox
    // дверь: знак «a.» в белом круге с тёмно-синим ободком (цвет логотипа)
    const g = markC.getContext('2d')!;
    g.beginPath(); g.arc(512, 512, 496, 0, Math.PI * 2); g.fillStyle = '#1D4382'; g.fill();
    g.beginPath(); g.arc(512, 512, 470, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
    const mw = 80 * k, mh = 61 * k, s = 600 / Math.max(mw, mh);
    g.drawImage(img, 0, 0, mw, mh, 512 - (mw * s) / 2, 512 - (mh * s) / 2, mw * s, mh * s);
    mark.needsUpdate = true;
    // корма: логотип целиком — знак «a.» + «Абсолют / Страхование», в его цветах
    const w = wordC.getContext('2d')!;
    const sw = 279 * k, sh = 61 * k, s2 = Math.min(1980 / sw, 440 / sh);
    w.drawImage(img, 0, 0, sw, sh, 1024 - (sw * s2) / 2, 230 - (sh * s2) / 2, sw * s2, sh * s2);
    word.needsUpdate = true;
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(absolutLogo);
  return { mark, word };
}

/**
 * «Комета» в духе современного среднемоторного американского спорткара (без марок и логотипов):
 * кабина сдвинута вперёд, короткий низкий нос, широкие задние «бёдра», боковые воздухозаборники,
 * крышка двигателя за кабиной, четыре трубы по центру. Ливрея (полосы + надпись) — по setLivery().
 */
export const VETTE = { R: 0.345, axF: 1.3, axR: -1.42, track: 0.82, halfLen: 2.315 };

/** Полосы ливреи в координатах кузова (+X — левый борт, +Y — вверх, +Z — вперёд). */
const LIVERY_GLSL = /* glsl */`
vec3 liveryColor(vec3 p, vec3 n, vec3 base) {
  const vec3 navy = vec3(0.012, 0.035, 0.16);
  const vec3 sky  = vec3(0.05, 0.36, 0.78);
  const vec3 red  = vec3(0.72, 0.02, 0.03);
  float aa = 0.006;
  vec3 c = base;
  // продольные полосы сверху: капот, крыша, крышка двигателя
  float wTop = smoothstep(0.35, 0.65, n.y);
  float ax = abs(p.x);
  vec3 t = base;
  t = mix(t, red,  1.0 - smoothstep(0.205, 0.205 + aa, ax));
  t = mix(t, base, 1.0 - smoothstep(0.185, 0.185 + aa, ax));
  t = mix(t, sky,  1.0 - smoothstep(0.175, 0.175 + aa, ax));
  t = mix(t, base, 1.0 - smoothstep(0.115, 0.115 + aa, ax));
  t = mix(t, navy, 1.0 - smoothstep(0.095, 0.095 + aa, ax));
  c = mix(c, t, wTop);
  // боковая «волна»: поднимается к корме
  float wSide = smoothstep(0.35, 0.65, abs(n.x)) * (1.0 - wTop);
  float y0 = 0.5 + 0.13 * smoothstep(1.9, -1.6, p.z);
  float y = p.y - y0;
  vec3 s = base;
  s = mix(s, navy, smoothstep(0.0, aa, y) * (1.0 - smoothstep(0.075, 0.075 + aa, y)));
  s = mix(s, sky,  smoothstep(0.092, 0.092 + aa, y) * (1.0 - smoothstep(0.14, 0.14 + aa, y)));
  s = mix(s, red,  smoothstep(0.156, 0.156 + aa, y) * (1.0 - smoothstep(0.178, 0.178 + aa, y)));
  // полосы не заходят на нос и корму
  s = mix(base, s, smoothstep(2.15, 1.95, p.z) * smoothstep(-2.25, -2.05, p.z));
  c = mix(c, s, wSide);
  return c;
}`;



export function buildVette(cfg: CarConfig & { sponsor?: string }, envIntensity = 1): CarModel {
  const { R, axF, axR, track, halfLen } = VETTE;
  const sh = new Shape({
    halfLen,
    top: [[-2.315, 0.82], [-2.29, 1.0], [-2.21, 1.075], [-1.95, 1.05], [-1.25, 1.03], [-0.6, 0.985], [0.2, 0.915],
      [0.95, 0.855], [1.5, 0.73], [2.0, 0.615], [2.2, 0.555], [2.315, 0.47]],
    bottom: [[-2.315, 0.36], [-2.15, 0.24], [-1.85, 0.17], [1.8, 0.15], [2.15, 0.17], [2.315, 0.25]],
    width: [[-2.315, 0.86], [-2.0, 0.95], [-1.45, 0.968], [-0.8, 0.94], [-0.2, 0.902], [0.5, 0.905], [1.3, 0.93],
      [1.9, 0.9], [2.315, 0.74]],
    planFront: 4.2, planRear: 11, axles: [axF, axR], wheelR: R, archR: 0.385,
    seLow: 6, seHigh: 4.2, tumble: 0.09,
  });

  const root = new THREE.Group();
  root.name = 'car';
  const body = new THREE.Group();
  root.add(body);

  const livery = { value: 0 };
  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(cfg.color), metalness: 0.2, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03,
    envMapIntensity: envIntensity, sheen: 0.4, sheenColor: new THREE.Color(0xdfe6ff),
  });
  // кузовная краска с ливреей: полосы считаются по координатам и нормали кузова
  const paintBody = paint.clone();
  paintBody.onBeforeCompile = (s) => {
    s.uniforms.uLivery = livery;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjP;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;\nvObjN = normal;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vObjP;\nvarying vec3 vObjN;\nuniform float uLivery;\n${LIVERY_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (uLivery > 0.5) diffuseColor.rgb = liveryColor(vObjP, normalize(vObjN), diffuseColor.rgb);');
  };
  paintBody.customProgramCacheKey = () => 'vette-livery';

  const black = new THREE.MeshPhysicalMaterial({ color: 0x0b0b0c, roughness: 0.42, metalness: 0.1, clearcoat: 0.4, envMapIntensity: envIntensity });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.55, metalness: 0.3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1117, roughness: 0.02, metalness: 0.1, clearcoat: 1, envMapIntensity: 1.6 * envIntensity });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe6e8ec, metalness: 1, roughness: 0.14, envMapIntensity: envIntensity });
  const under = new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.9 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf2f6ff, emissiveIntensity: 3.2, roughness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 2.2, roughness: 0.3 });
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, cast = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    body.add(mesh);
    return mesh;
  };
  const tube = (pts: THREE.Vector3[], r: number, m: THREE.Material) =>
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(10, pts.length * 6), r, 8, false), m, 0, 0, 0, false);
  const onSurf = (x: number, y: number, end: 1 | -1, out = 0) => new THREE.Vector3(x, y, sh.surfaceZ(x, y, end) + end * out);

  // ——— кузов: решётки, сплиттер, диффузор, пороги и боковые воздухозаборники — чёрные ———
  const rows: THREE.Vector3[][] = [];
  const M = 64; // густое кольцо: края решёток без «ступенек»
  for (const z of bodyStations(halfLen, 120, [axF, axR], 0.385)) {
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < M; k++) ring.push(sh.point(z, -1 + (2 * k) / (M - 1), 1));
    for (let k = M - 2; k > 0; k--) ring.push(sh.point(z, -1 + (2 * k) / (M - 1), -1));
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
  const bodyGeo = loft(rows, (p) => {
    const ax = Math.abs(p.x);
    if (p.y < sh.base(p.z) + 0.06 && ax > 0.55) return 1;                   // пороги
    return 0;
  }, true, true);
  const bm = new THREE.Mesh(bodyGeo, [paintBody, black]);
  bm.castShadow = bm.receiveShadow = true;
  body.add(bm);

  // ——— «аквариум»: кабина впереди, наклонное лобовое, контрфорсы за ней ———
  const zA = 0.95, zC = -1.08;
  const roof = spline([[zC, sh.top(zC)], [-0.78, 1.13], [-0.42, 1.222], [0.05, 1.235], [0.45, 1.165], [zA, sh.top(zA)]]);
  const GR = 70, GK = 30, sOf: number[] = [];
  for (let k = 0; k <= GK; k++) sOf.push(Math.sin((Math.PI * k) / GK));
  const gRows: THREE.Vector3[][] = [];
  for (let r = 0; r < GR; r++) {
    const z = zC + ((zA - zC) * r) / (GR - 1);
    const yb = sh.top(z) - 0.012, H = Math.max(0, roof(z) - yb);
    // ширина — по «плечам» кузова (чуть ниже верха), а не по самому верху, где сечение сходится к середине
    const wb = sh.xAt(z, sh.top(z) - 0.09) - 0.015, wr = wb * 0.9; // кабина почти во всю ширину кузова
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k <= GK; k++) {
      const phi = Math.PI - (Math.PI * k) / GK;
      const s = Math.sin(phi), c = Math.cos(phi);
      const a = wb + (wr - wb) * Math.min(1, s * 1.1);
      ring.push(new THREE.Vector3(Math.sign(c) * a * Math.pow(Math.abs(c), 2 / 2.8), yb + H * Math.pow(s, 2 / 3.6), z));
    }
    gRows.push(ring);
  }
  const ghGeo = loft(gRows, (p, _r, c) => {
    const s = (sOf[c] + sOf[c + 1]) / 2, z = p.z;
    if (s < 0.07) return 2;
    if (z > 0.38) return s > 0.58 && s < 0.72 ? 2 : 1;          // лобовое, чёрные A-стойки
    if (z > -0.42) return s > 0.8 ? 0 : 1;                       // крыша, боковые стёкла
    if (s > 0.8) return 1;                                       // заднее стекло
    return 0;                                                    // контрфорсы
  }, false, false);
  const gh = new THREE.Mesh(ghGeo, [paintBody, glass, black]);
  gh.castShadow = true;
  body.add(gh);
  add(new THREE.BoxGeometry(1.25, 0.42, 3.4), under, 0, 0.4, -0.05, false);

  /**
   * Гладкая панель по поверхности торца (front +1 / rear -1): сетка x×y, z — по поверхности кузова.
   * Так решётки и диффузор без «ступенек» сетки кузова.
   */
  const endPatch = (end: 1 | -1, x0: number, x1: number, y0: (x: number) => number, y1: (x: number) => number, m: THREE.Material, off = 0.005) => {
    const nx = 40, ny = 8, pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      for (let j = 0; j <= ny; j++) {
        const y = y0(x) + ((y1(x) - y0(x)) * j) / ny;
        pos.push(x, y, sh.surfaceZ(x, y, end) + end * off);
      }
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const a = i * (ny + 1) + j, b = a + 1, d = a + ny + 1, e = d + 1;
      if (end > 0) idx.push(a, d, b, b, d, e); else idx.push(a, b, d, b, e, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = add(g, m, 0, 0, 0, false);
    (mesh.material as THREE.Material).side = THREE.DoubleSide;
    return mesh;
  };
  // передняя нижняя решётка: трапеция с плавно скруглёнными краями
  endPatch(1, -0.66, 0.66, (x) => 0.2 + 0.03 * (Math.abs(x) / 0.66) ** 2, (x) => 0.36 - 0.05 * (Math.abs(x) / 0.66) ** 3, black);
  for (let k = 1; k <= 3; k++) {
    const y = 0.22 + k * 0.035;
    tube([-0.6, -0.3, 0, 0.3, 0.6].map((x) => onSurf(x, y, 1, 0.012)), 0.006, carbon);
  }
  // диффузор: панель по плоскости кормы + рёбра
  endPatch(-1, -0.78, 0.78, () => 0.2, (x) => 0.46 - 0.06 * (Math.abs(x) / 0.78) ** 2, black);
  for (const x of [-0.5, -0.3, 0.3, 0.5]) add(new THREE.BoxGeometry(0.012, 0.1, 0.12), carbon, x, 0.32, sh.surfaceZ(Math.abs(x), 0.32, -1) + 0.03, false);

  // боковые воздухозаборники: гладкая трапеция по изгибу борта (сетка кузова дала бы «ступеньки»)
  for (const side of [-1, 1]) {
    const rowsN = 16, colsN = 10;
    const pos: number[] = [], idx: number[] = [];
    const zF = -0.6, zB = -1.03;
    for (let r = 0; r <= rowsN; r++) {
      const u = r / rowsN, z = zF + (zB - zF) * u;
      const y0 = 0.44 + 0.03 * u, y1 = 0.83 - 0.15 * u;     // верх скошен назад-вниз
      for (let c = 0; c <= colsN; c++) {
        const y = y0 + ((y1 - y0) * c) / colsN;
        pos.push(side * (sh.xAt(z, y) + 0.004), y, z); // тёмная вставка поверх борта
      }
    }
    for (let r = 0; r < rowsN; r++) for (let c = 0; c < colsN; c++) {
      const a = r * (colsN + 1) + c, b = a + 1, d = a + colsN + 1, e = d + 1;
      if (side > 0) idx.push(a, d, b, b, d, e); else idx.push(a, b, d, b, e, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = add(g, black, 0, 0, 0, false);
    (m.material as THREE.Material).side = THREE.DoubleSide;
    // рёбра внутри заборника
    for (let k = 1; k <= 3; k++) {
      const z = zF + (zB - zF) * (k / 4), y = 0.6;
      add(new THREE.BoxGeometry(0.01, 0.3, 0.012), carbon, side * (sh.xAt(z, y) + 0.004), y, z, false);
    }
  }

  // крышка двигателя: стекло с жалюзи между контрфорсами
  {
    const z0 = -1.15, z1 = -1.95, len = z0 - z1, zc = (z0 + z1) / 2;
    const y = sh.top(zc) + 0.012;
    const lid = add(new RoundedBoxGeometry(0.9, 0.02, len, 2, 0.009), glass, 0, y, zc, false);
    lid.rotation.x = Math.atan2(sh.top(z1) - sh.top(z0), len) * -1;
    for (let k = 0; k < 7; k++) add(new THREE.BoxGeometry(0.86, 0.012, 0.025), carbon, 0, y + 0.012, z0 - 0.1 - k * 0.1, false);
  }

  // ——— задний спойлер: карбоновое антикрыло на двух стойках с торцевыми пластинами ———
  {
    const zw = -2.08, deckY = sh.top(zw), y = deckY + 0.17, span = 1.62;
    // крыло — профиль, вытянутый по ширине (ExtrudeGeometry по оси X)
    const prof = new THREE.Shape();
    prof.moveTo(0.14, 0);
    prof.bezierCurveTo(0.1, 0.045, -0.06, 0.05, -0.13, 0.012);
    prof.lineTo(-0.13, -0.004);
    prof.bezierCurveTo(-0.04, 0.012, 0.08, 0.004, 0.14, 0);
    const wingGeo = new THREE.ExtrudeGeometry(prof, { depth: span, bevelEnabled: false, curveSegments: 12 });
    wingGeo.translate(0, 0, -span / 2).rotateY(Math.PI / 2);   // ось профиля — вдоль кузова, размах — по X
    const wing = add(wingGeo, carbon, 0, y, zw);
    wing.rotation.x = -0.12;                                    // угол атаки
    for (const side of [-1, 1]) {
      // стойки от крышки багажника к крылу
      const x = side * 0.46, base = sh.top(zw + 0.02) - 0.01;
      add(new RoundedBoxGeometry(0.035, y - base + 0.02, 0.12, 2, 0.012), carbon, x, (y + base) / 2, zw + 0.01).rotation.x = 0.1;
      // торцевые пластины
      add(new RoundedBoxGeometry(0.012, 0.11, 0.32, 2, 0.005), carbon, side * (span / 2 + 0.004), y + 0.01, zw);
    }
  }

  // ——— перед: узкие стреловидные фары и светодиодные «брови» ———
  for (const side of [-1, 1]) {
    const xs = [0.38, 0.5, 0.62, 0.72, 0.79].map((x) => side * x);
    const yL = (x: number) => 0.6 + (Math.abs(x) - 0.38) * 0.1;
    tube(xs.map((x) => onSurf(x, yL(x), 1, -0.012)), 0.034, glass);
    tube(xs.map((x) => onSurf(x, yL(x) + 0.018, 1, 0.02)), 0.008, headMat);
    tube(xs.slice(1, 4).map((x) => onSurf(x, yL(x) - 0.016, 1, 0.02)), 0.006, headMat);
  }
  // ——— зад: угловатые двухсекционные фонари, четыре трубы по центру, номер ———
  for (const side of [-1, 1]) {
    const pts = [0.36, 0.5, 0.64, 0.76, 0.82].map((x, i) => onSurf(side * x, 0.98 - i * 0.012 - (i > 2 ? (i - 2) * 0.05 : 0), -1, 0.012));
    tube(pts.map((p) => p.clone().add(new THREE.Vector3(0, 0, 0.02))), 0.03, black);
    tube(pts, 0.013, tailMat);
    tube(pts.map((p) => p.clone().add(new THREE.Vector3(0, -0.04, 0))), 0.009, tailMat);
  }
  {
    const zr = sh.surfaceZ(0.2, 0.36, -1);
    for (const x of [-0.17, -0.06, 0.06, 0.17]) {
      const pipe = add(new THREE.CylinderGeometry(0.042, 0.042, 0.12, 20, 1, true), chrome, x, 0.36, zr + 0.03, false);
      pipe.rotation.x = Math.PI / 2;
      (pipe.material as THREE.Material).side = THREE.DoubleSide;
      const inner = add(new THREE.CircleGeometry(0.038, 20), under, x, 0.36, zr + 0.05, false);
      inner.rotation.y = Math.PI;
    }
    const y = 0.62, z = sh.surfaceZ(0.27, y, -1) - 0.01;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112),
      new THREE.MeshStandardMaterial({ map: makePlateTexture(cfg.plate), roughness: 0.4, metalness: 0.2 }));
    plate.position.set(0, y, z);
    plate.rotation.y = Math.PI;
    body.add(plate);
  }

  // ——— зеркала, ручки, зазоры дверей ———
  const gapMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
  for (const side of [-1, 1]) {
    const mz = 0.78, my = sh.top(mz) + 0.09, bx = sh.xAt(mz, sh.top(mz) - 0.04);
    add(new RoundedBoxGeometry(0.12, 0.03, 0.05, 2, 0.012), black, side * (bx + 0.05), my - 0.05, mz, false);
    // обтекаемый корпус зеркала: вытянут вбок и назад
    const h = add(new THREE.CapsuleGeometry(0.045, 0.12, 6, 14), paint, side * (bx + 0.13), my, mz);
    h.rotation.z = Math.PI / 2;
    h.scale.set(1, 1, 1.15);
    const face = add(new THREE.CircleGeometry(1, 18), chrome, side * (bx + 0.13), my, mz - 0.05, false);
    face.scale.set(0.09, 0.038, 1);
    face.rotation.y = Math.PI;
    for (const z of [0.92, -0.58]) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 8; k++) {
        const y = sh.base(z) + 0.08 + ((sh.top(z) - 0.03 - sh.base(z) - 0.08) * k) / 8;
        pts.push(new THREE.Vector3(side * (sh.xAt(z, y) + 0.0015), y, z));
      }
      tube(pts, 0.0042, gapMat);
    }
  }

  // ——— подкрылки ———
  for (const az of [axF, axR]) for (const side of [-1, 1]) {
    const liner = new THREE.CylinderGeometry(0.385, 0.385, 0.26, 28, 1, true, 0, Math.PI).rotateZ(Math.PI / 2);
    const lm = add(liner, under, side * (track - 0.08), R, az, false);
    (lm.material as THREE.Material).side = THREE.DoubleSide;
  }

  // ——— колёса: многоспицевые тёмные диски, жёлтые суппорты ———
  const wheels: CarModel['wheels'] = [];
  const W = 0.27, rimR = 0.25;
  const prof: THREE.Vector2[] = [];
  const s2 = 0.035;
  prof.push(new THREE.Vector2(rimR, -W / 2 + 0.01), new THREE.Vector2(R - 0.05, -W / 2));
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(R - s2 + Math.cos(a) * s2, -W / 2 + s2 + Math.sin(a) * s2)); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(R - s2 + Math.cos(a) * s2, W / 2 - s2 + Math.sin(a) * s2)); }
  prof.push(new THREE.Vector2(R - 0.05, W / 2), new THREE.Vector2(rimR, W / 2 - 0.01));
  const tire = new THREE.LatheGeometry(prof, 64).rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x131313, roughness: 0.86 });
  // белые лакированные диски
  const rimMat = new THREE.MeshPhysicalMaterial({ color: 0xf3f3f0, metalness: 0.15, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: envIntensity });
  const lipMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc3, metalness: 1, roughness: 0.2, envMapIntensity: envIntensity });
  const caliperMat = new THREE.MeshPhysicalMaterial({ color: 0xf2c200, roughness: 0.35, clearcoat: 0.8 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0x77797c, metalness: 0.9, roughness: 0.42 });
  const barrel = new THREE.CylinderGeometry(rimR, rimR, W - 0.03, 40, 1, true).rotateZ(Math.PI / 2);
  const spoke = new THREE.BoxGeometry(0.024, rimR - 0.06, 0.03).translate(0, (rimR - 0.06) / 2 + 0.055, 0);
  const lip = new THREE.TorusGeometry(rimR - 0.006, 0.011, 8, 48).rotateY(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.06, 0.065, 0.04, 20).rotateZ(Math.PI / 2);
  const disc = new THREE.CylinderGeometry(0.18, 0.18, 0.026, 36).rotateZ(Math.PI / 2);
  for (const front of [true, false]) for (const side of [-1, 1]) {
    const steer = new THREE.Group();
    steer.position.set(side * track, R, front ? axF : axR);
    const spin = new THREE.Group();
    steer.add(spin);
    const t = new THREE.Mesh(tire, tireMat); t.castShadow = true; spin.add(t);
    const b = new THREE.Mesh(barrel, under); (b.material as THREE.Material).side = THREE.DoubleSide; spin.add(b);
    const face = side * (W / 2 - 0.035);
    const l = new THREE.Mesh(lip, lipMat); l.position.x = face; spin.add(l);
    const h = new THREE.Mesh(hub, rimMat); h.position.x = face - side * 0.01; spin.add(h);
    for (let k = 0; k < 10; k++) {
      const sp = new THREE.Mesh(spoke, rimMat);
      sp.rotation.x = (k / 10) * Math.PI * 2 + (k % 2 ? 0.08 : -0.08);
      sp.rotation.z = side * 0.06;
      sp.position.x = face - side * 0.012;
      spin.add(sp);
    }
    const d = new THREE.Mesh(disc, discMat); d.position.x = -side * 0.02; steer.add(d);
    const cal = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.16, 0.1, 2, 0.02), caliperMat);
    cal.position.set(side * 0.02, 0.1, front ? -0.1 : 0.1);
    cal.rotation.x = front ? 0.6 : -0.6;
    steer.add(cal);
    root.add(steer);
    wheels.push({ spin, steer, front });
  }

  // ——— логотип страховщика (виден вместе с ливреей) ———
  const logos = new THREE.Group();
  logos.visible = false;
  body.add(logos);
  // на дверях — большая «a» по центру (с наклоном по изгибу борта)
  const brand = brandTextures();
  const letterMat = new THREE.MeshStandardMaterial({ map: brand.mark, transparent: true, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -3 });
  for (const side of [-1, 1]) {
    const z = 0.2, y = 0.6, size = 0.42;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(size, size), letterMat);
    p.position.set(side * (sh.xAt(z, y) + 0.006), y, z);
    const dxdy = (sh.xAt(z, y + 0.1) - sh.xAt(z, y - 0.1)) / 0.2;
    const tilt = side * Math.atan(-dxdy);
    p.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * Math.PI / 2));
    logos.add(p);
  }
  // на корме — логотип целиком, по центру между фонарями и номером; наклейка повторяет изгиб кормы
  {
    const W = 0.84, H = W * (460 / 2048), yc = 0.8, nx = 24, ny = 6;
    const pos: number[] = [], uv: number[] = [], ix: number[] = [];
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
      const u = i / nx, v = j / ny;
      const x = W / 2 - u * W, y = yc - H / 2 + v * H;   // сзади правая сторона картинки — это −X
      pos.push(x, y, sh.surfaceZ(Math.abs(x), y, -1) - 0.006);
      uv.push(u, v);
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const a = i * (ny + 1) + j, b = a + 1, d = a + ny + 1, e = d + 1;
      ix.push(a, b, d, b, e, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(ix);
    g.computeVertexNormals();
    logos.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: brand.word, transparent: true, roughness: 0.35, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 })));
  }

  // контактная тень
  {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.85)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.5)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.3),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, opacity: 0.75 }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.012;
    blob.renderOrder = 1;
    root.add(blob);
  }

  return {
    root, body, wheels, paint: paintBody, tailMat, headMat, length: 4.63, width: 1.94, wheelR: R,
    setBrake(on: number) { tailMat.emissiveIntensity = 2.2 + on * 5; },
    setHeadlights(on: number) { headMat.emissiveIntensity = 3.2 + on * 3; },
    setLivery(on: boolean) { livery.value = on ? 1 : 0; logos.visible = on; },
  };
}
