import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, vnoise2, fbm2, tfbm2, tnoise2, clamp, smoothstep } from './noise';

// ——— утилиты геометрии с цветом в вершинах ———
type Paint = number | ((p: THREE.Vector3, n: THREE.Vector3) => THREE.Color);
const _p = new THREE.Vector3(), _nn = new THREE.Vector3(), _c = new THREE.Color();

function prep(g: THREE.BufferGeometry, paint: Paint) {
  const out = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'normal') out.deleteAttribute(k);
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  const pos = out.getAttribute('position'), nor = out.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    _nn.fromBufferAttribute(nor, i);
    const c = typeof paint === 'number' ? _c.set(paint) : paint(_p, _nn);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // нулевая нормаль (вырожденный треугольник) → «вверх»: normalize(0) в шейдере даёт NaN
  for (let i = 0; i < nor.count; i++) {
    if (nor.getX(i) ** 2 + nor.getY(i) ** 2 + nor.getZ(i) ** 2 < 1e-10) nor.setXYZ(i, 0, 1, 0);
  }
  return out;
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s: number | [number, number, number] = 1) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    Array.isArray(s) ? new THREE.Vector3(...s) : new THREE.Vector3(s, s, s));
  return g.applyMatrix4(m);
}

function merge(list: THREE.BufferGeometry[]) {
  const g = mergeGeometries(list, false)!;
  g.computeBoundingSphere();
  return g;
}

/** Случайное смещение вершин по нормали (органичная форма), швы не расходятся — шум по позиции. */
function displace(g: THREE.BufferGeometry, amp: number, freq: number, seed: number) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    const n = vnoise2(tmp.x * freq + tmp.z * 0.7 * freq, tmp.y * freq, seed) - 0.5;
    const len = tmp.length() || 1;
    tmp.multiplyScalar(1 + (n * amp) / len);
    pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

const shade = (base: number, lo: number, hi: number, y0: number, y1: number, jitter = 0.06, seed = 1) =>
  (p: THREE.Vector3) => {
    const t = clamp((p.y - y0) / (y1 - y0), 0, 1);
    const k = lo + (hi - lo) * t + (vnoise2(p.x * 3.1 + p.z * 1.7, p.y * 2.3, seed) - 0.5) * jitter;
    return _c.set(base).multiplyScalar(k);
  };

// ——— растительность ———
function spruceTier(t: number, tiers: number, lo: boolean) {
  const progress = t / (tiers - 1);
  return { r: 2.3 - progress * 1.5, h: 3.4 - progress * 1.2, y: 2.2 + t * (lo ? 2.6 : 1.6) };
}

function conifer(parts: THREE.BufferGeometry[]) {
  const geometry = merge(parts);
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const mask = new Float32Array(position.count);
  const trunk = parts[0].getAttribute('position').count;
  for (let i = trunk; i < position.count; i++) {
    const patch = vnoise2(position.getX(i) * 1.7 + position.getY(i), position.getZ(i) * 1.7, 91);
    mask[i] = smoothstep(0.18, 0.62, normal.getY(i) + (patch - 0.5) * 0.48) * (0.66 + patch * 0.34);
  }
  geometry.setAttribute('snowMask', new THREE.BufferAttribute(mask, 1));
  return geometry;
}

function spruce(lo: boolean) {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(prep(at(new THREE.CylinderGeometry(0.1, 0.2, 3.2, lo ? 5 : 7), 0, 1.6, 0), 0x4a3426));
  const tiers = lo ? 3 : 5;
  for (let t = 0; t < tiers; t++) {
    const { r, h, y } = spruceTier(t, tiers, lo);
    let cone: THREE.BufferGeometry = new THREE.ConeGeometry(r, h, lo ? 6 : 11, lo ? 1 : 3);
    if (!lo) cone = displace(cone.toNonIndexed(), 0.35, 1.3, 7 + t);
    parts.push(prep(at(cone, 0, y + h / 2, 0, 0, t * 0.7), shade(0x24452b, 0.55, 1.15, y, y + h, 0.25, t)));
  }
  return conifer(parts);
}

function festiveLights() {
  const parts: THREE.BufferGeometry[] = [];
  const palette = [0xff483f, 0xffcd57, 0x48cfff, 0x61ef89, 0xff82da];
  const bulb = new THREE.IcosahedronGeometry(0.105, 0);
  for (let t = 0; t < 5; t++) {
    const { r, h, y } = spruceTier(t, 5, false);
    const count = 24 - t * 3;
    for (let n = 0; n < count; n++) {
      const angle = (n / count) * Math.PI * 2 + t * 0.52;
      const rise = 0.22 + 0.11 * Math.sin(angle * 3);
      const radius = r * (1 - rise / h) + 0.07;
      const color = new THREE.Color(palette[(n + t * 2) % palette.length]).multiplyScalar(2.4);
      parts.push(prep(bulb.clone().translate(Math.cos(angle) * radius, y + rise, Math.sin(angle) * radius), () => color));
    }
  }
  const star = new THREE.Shape();
  for (let n = 0; n < 10; n++) {
    const angle = Math.PI / 2 + n * Math.PI / 5;
    const radius = n % 2 ? 0.22 : 0.48;
    const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
    if (n === 0) star.moveTo(x, y); else star.lineTo(x, y);
  }
  star.closePath();
  const golden = new THREE.Color(0xffb839).multiplyScalar(2.3);
  for (const azimuth of [0, Math.PI / 2]) {
    parts.push(prep(new THREE.ShapeGeometry(star).rotateY(azimuth).translate(0, 11.0, 0), () => golden));
  }
  bulb.dispose();
  return merge(parts);
}

function pine(lo: boolean) {
  const parts: THREE.BufferGeometry[] = [];
  const h = 8.8;
  parts.push(prep(at(new THREE.CylinderGeometry(0.1, 0.27, h, lo ? 5 : 8), 0, h / 2, 0),
    shade(0x77523a, 0.55, 1.18, 0, h)));
  const crowns = lo ? 3 : 6;
  for (let i = 0; i < crowns; i++) {
    const angle = i * 2.4, y = 7.5 + i * 0.45;
    const spread = i === crowns - 1 ? 0 : 0.9;
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1.65 - i * 0.09, lo ? 0 : 1);
    if (!lo) g = displace(g, 0.35, 1.1, 51 + i);
    parts.push(prep(at(g, Math.cos(angle) * spread, y, Math.sin(angle) * spread, 0, angle, 0, [1, 0.63, 1]),
      shade(0x3b5735, 0.56, 1.15, y - 1, y + 1, 0.18, 51 + i)));
  }
  return conifer(parts);
}

function bareTree(lo: boolean, birch: boolean) {
  const parts: THREE.BufferGeometry[] = [];
  const random = mulberry32(birch ? 97 : 113);
  const bark = birch ? 0xe8e6df : 0x4a3a2a;
  const branch = (a: THREE.Vector3, b: THREE.Vector3, base: number, tip: number) => {
    const direction = b.clone().sub(a);
    const length = direction.length();
    const geometry = new THREE.CylinderGeometry(tip, base, length, lo ? 4 : 6)
      .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()))
      .translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    parts.push(prep(geometry, birch
      ? (p) => _c.set(vnoise2(p.y * 5, (p.x + p.z) * 9, 3) > 0.74 ? 0x39342f : bark)
      : bark));
  };
  const joint = new THREE.Vector3(0.09, birch ? 4.2 : 3.2, 0);
  branch(new THREE.Vector3(), joint, birch ? 0.17 : 0.29, birch ? 0.085 : 0.15);
  branch(joint, new THREE.Vector3(0.21, birch ? 9.2 : 6.25, -0.17), birch ? 0.085 : 0.15, 0.018);
  const count = lo ? 4 : 7;
  for (let i = 0; i < count; i++) {
    const angle = i * 2.4, spread = (birch ? 1.4 : 2.25) * (0.7 + random() * 0.5);
    const height = joint.y + 0.2 + (i / count) * (birch ? 3.2 : 1.5);
    const root = new THREE.Vector3(0.1, height, 0);
    const tip = new THREE.Vector3(Math.cos(angle) * spread, height + 1.2 + random(), Math.sin(angle) * spread);
    branch(root, tip, birch ? 0.052 : 0.09, 0.014);
    if (!lo) {
      const fork = root.clone().lerp(tip, 0.54);
      for (const turn of [-0.58, 0.64]) {
        const end = fork.clone().add(new THREE.Vector3(Math.cos(angle + turn), 0.9 + random() * 0.5, Math.sin(angle + turn)));
        branch(fork, end, 0.031, 0.008);
      }
    }
  }
  return merge(parts);
}

function blobTree(trunkCol: number, leafCol: number, lo: boolean, slim = false) {
  const parts: THREE.BufferGeometry[] = [];
  const th = slim ? 4.2 : 3.2;
  parts.push(prep(at(new THREE.CylinderGeometry(slim ? 0.1 : 0.16, slim ? 0.16 : 0.28, th, lo ? 5 : 8), 0, th / 2, 0), slim
    ? (p: THREE.Vector3) => _c.set(vnoise2(p.y * 6, p.x * 20, 3) > 0.72 ? 0x222222 : 0xe8e6df)
    : trunkCol));
  if (!lo) {
    for (const [ry, rz] of [[0.3, 0.6], [2.4, 0.55], [4.4, 0.7]]) {
      parts.push(prep(at(new THREE.CylinderGeometry(0.05, 0.1, 1.8, 5), 0, th - 0.4, 0, 0, ry, rz).translate(0, 0, 0), trunkCol));
    }
  }
  const rnd = mulberry32(slim ? 11 : 5);
  const blobs = lo ? 3 : 6;
  for (let b = 0; b < blobs; b++) {
    const r = (slim ? 1.0 : 1.7) + rnd() * 0.9;
    const a = (b / blobs) * Math.PI * 2;
    const spread = b === 0 ? 0 : (slim ? 0.7 : 1.4);
    const y = th + (slim ? 1.2 + b * 0.8 : 1.0 + rnd() * 1.6);
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(r, lo ? 0 : 2);
    if (!lo) g = displace(g, 0.45, 1.1, 20 + b);
    const yc = y;
    parts.push(prep(at(g, Math.cos(a) * spread, y, Math.sin(a) * spread, 0, 0, 0, [1, slim ? 1.5 : 0.85, 1]),
      shade(leafCol, 0.55, 1.2, yc - r, yc + r, 0.3, b)));
  }
  return merge(parts);
}

function bush(col: number, lo: boolean) {
  const parts: THREE.BufferGeometry[] = [];
  for (let b = 0; b < 3; b++) {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.7 + b * 0.15, lo ? 0 : 1);
    if (!lo) g = displace(g, 0.3, 2, 40 + b);
    parts.push(prep(at(g, (b - 1) * 0.6, 0.45, (b % 2) * 0.4, 0, 0, 0, [1, 0.7, 1]), shade(col, 0.6, 1.15, 0, 1.2, 0.3, b)));
  }
  return merge(parts);
}

function cactus(lo: boolean) {
  const ribbed = (r: number, h: number) => {
    const g = new THREE.CylinderGeometry(r, r * 1.05, h, lo ? 8 : 16, lo ? 1 : 4);
    if (!lo) {
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i);
        const a = Math.atan2(z, x), k = 1 + 0.09 * Math.cos(a * 8);
        p.setX(i, x * k); p.setZ(i, z * k);
      }
      g.computeVertexNormals();
    }
    return g;
  };
  const parts: THREE.BufferGeometry[] = [];
  const green = shade(0x4f6b38, 0.75, 1.1, 0, 5, 0.15);
  parts.push(prep(at(ribbed(0.32, 4.6), 0, 2.3, 0), green));
  parts.push(prep(at(new THREE.SphereGeometry(0.32, lo ? 8 : 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 4.6, 0), green));
  for (const [side, y, h] of [[1, 1.8, 1.8], [-1, 2.4, 1.4]] as const) {
    parts.push(prep(at(ribbed(0.2, 0.8), side * 0.55, y, 0, 0, 0, Math.PI / 2), green));
    parts.push(prep(at(ribbed(0.2, h), side * 0.92, y + h / 2, 0), green));
    parts.push(prep(at(new THREE.SphereGeometry(0.2, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), side * 0.92, y + h, 0), green));
  }
  return merge(parts);
}

function rock(col: number, lo: boolean, seed: number) {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, lo ? 1 : 3);
  g = displace(g, 0.55, 1.6, seed);
  at(g, 0, 0.35, 0, 0, 0, 0, [1.4, 0.75, 1.1]);
  return prep(g, (p, n) => _c.set(col).multiplyScalar(0.65 + 0.4 * clamp(n.y, 0, 1) + (vnoise2(p.x * 4, p.z * 4 + p.y * 3, seed) - 0.5) * 0.2));
}

// ——— дорожное оборудование ———
function delineator() {
  return merge([
    prep(at(new THREE.BoxGeometry(0.12, 1.05, 0.1), 0, 0.52, 0), (p) => _c.set(p.y > 0.78 && p.y < 0.94 ? 0x111111 : 0xf2f2f0)),
    prep(at(new THREE.BoxGeometry(0.13, 0.08, 0.03), 0, 0.86, 0.045), 0xff5a10),
  ]);
}

function lamp() {
  const parts: THREE.BufferGeometry[] = [];
  const metal = 0x8a8f94;
  parts.push(prep(at(new THREE.CylinderGeometry(0.07, 0.13, 9, 8), 0, 4.5, 0), metal));
  parts.push(prep(at(new THREE.CylinderGeometry(0.2, 0.24, 0.6, 8), 0, 0.3, 0), 0x55595e));
  // изогнутый вынос к дороге (вдоль +X)
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 8.6, 0), new THREE.Vector3(0.1, 9.6, 0), new THREE.Vector3(2.2, 9.5, 0));
  parts.push(prep(new THREE.TubeGeometry(curve, 10, 0.055, 6), metal));
  parts.push(prep(at(new THREE.BoxGeometry(0.75, 0.14, 0.32), 2.45, 9.45, 0, 0, 0, -0.06), 0x3a3d40));
  parts.push(prep(at(new THREE.BoxGeometry(0.6, 0.02, 0.24), 2.45, 9.37, 0, 0, 0, -0.06), 0xfff2d6));
  return merge(parts);
}

function powerPole() {
  const wood = 0x5b4632;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(prep(at(new THREE.CylinderGeometry(0.12, 0.17, 10, 7), 0, 5, 0), shade(wood, 0.8, 1.05, 0, 10, 0.2)));
  parts.push(prep(at(new THREE.BoxGeometry(0.12, 0.14, 2.4), 0, 9.3, 0), wood));
  for (const z of [-1.0, 0, 1.0]) parts.push(prep(at(new THREE.CylinderGeometry(0.05, 0.07, 0.25, 6), 0, 9.5, z), 0x6d8a9c));
  parts.push(prep(at(new THREE.BoxGeometry(0.06, 1.3, 0.06), 0, 8.7, 0.55, 0.8, 0, 0), wood));
  return merge(parts);
}

function lifeguard() {
  const parts: THREE.BufferGeometry[] = [];
  const white = 0xece8df, red = 0xc23a2a, wood = 0x8b6a48;
  for (const [x, z] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) parts.push(prep(at(new THREE.BoxGeometry(0.14, 2.6, 0.14), x, 1.3, z), wood));
  parts.push(prep(at(new THREE.BoxGeometry(2.4, 0.12, 2.4), 0, 2.6, 0), wood));
  parts.push(prep(at(new THREE.BoxGeometry(2.0, 1.5, 1.8), 0, 3.4, -0.1), (p) => _c.set(Math.floor((p.x + 2) / 0.4) % 2 ? white : red)));
  parts.push(prep(at(new THREE.BoxGeometry(1.7, 0.6, 0.02), 0, 3.55, 0.81), 0x22303a));
  parts.push(prep(at(new THREE.ConeGeometry(1.9, 0.7, 4), 0, 4.5, -0.1, 0, Math.PI / 4, 0), red));
  parts.push(prep(at(new THREE.BoxGeometry(0.7, 0.06, 2.6), 0, 1.3, 1.9, -0.95, 0, 0), wood));
  return merge(parts);
}

function fence() {
  const parts: THREE.BufferGeometry[] = [];
  const wood = 0xcfc4b0;
  for (let i = 0; i < 4; i++) parts.push(prep(at(new THREE.BoxGeometry(0.1, 1.2, 0.1), 0, 0.6, i * 2), wood));
  for (const y of [0.45, 0.95]) parts.push(prep(at(new THREE.BoxGeometry(0.05, 0.1, 8), 0.06, y, 3), wood));
  return merge(parts);
}

export type PropId =
  | 'pine' | 'pineLo' | 'spruce' | 'spruceLo' | 'festiveLights' | 'oak' | 'oakLo' | 'birch' | 'birchLo' | 'bush' | 'dryBush'
  | 'cactus' | 'cactusLo' | 'rock' | 'rockLo' | 'redRock' | 'delineator' | 'lamp' | 'powerPole' | 'lifeguard' | 'fence';

// ——— текстуры фасадов ———
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/**
 * Плитка стены дома 4×3 м: штукатурка (альфа=1 — красится цветом дома) и окно (альфа=0 — своё).
 * Пары (цвет, шероховатость).
 */
function houseTile() {
  const S = 256;
  const color = canvasTex(S, S, (g) => {
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = (y * S + x) * 4;
      const n = 0.86 + tnoise2(x / 2, y / 2, S / 2, S / 2, 3) * 0.1 + tfbm2(x / 32, y / 32, S / 32, S / 32, 3, 4) * 0.06;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = n * 255; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // окно: рама, стекло с отражением неба, подоконник
    const wx = 80, wy = 60, ww = 96, wh = 120;
    g.fillStyle = 'rgba(245,245,240,1)'; g.fillRect(wx - 8, wy - 8, ww + 16, wh + 16);
    const grd = g.createLinearGradient(0, wy, 0, wy + wh);
    grd.addColorStop(0, '#9fb6c8'); grd.addColorStop(0.45, '#4a6276'); grd.addColorStop(1, '#1d2834');
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = grd; g.fillRect(wx, wy, ww, wh);
    g.fillStyle = '#f2f2ee'; g.fillRect(wx + ww / 2 - 3, wy, 6, wh); g.fillRect(wx, wy + 44, ww, 5);
    g.fillStyle = '#d8d6d0'; g.fillRect(wx - 12, wy + wh + 8, ww + 24, 9);
  });
  // R — маска покраски (1 — штукатурка), G — шероховатость
  const rough = canvasTex(S, S, (g) => {
    g.fillStyle = '#ffe600'; g.fillRect(0, 0, S, S);
    g.fillStyle = '#00d000'; g.fillRect(80 - 12, 60 - 8, 96 + 24, 120 + 25);
    g.fillStyle = '#001400'; g.fillRect(80, 60, 96, 120);
  }, false);
  return { color, rough };
}

/** Плитка стеклянного фасада 12×14 м (4 окна × 4 этажа): стекло своё, рамы/перекрытия красятся. */
function towerTile(seed: number) {
  const S = 512, cols = 4, rows = 4;
  const rnd = mulberry32(seed);
  const tints: string[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const v = rnd();
    tints.push(v < 0.15 ? '#c9b49a' : v < 0.5 ? '#3d5a6e' : v < 0.85 ? '#2c4354' : '#55788e');
  }
  const color = canvasTex(S, S, (g) => {
    g.fillStyle = '#b8bcc0'; g.fillRect(0, 0, S, S);
    const cw = S / cols, rh = S / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + 6, y = r * rh + 22, w = cw - 12, h = rh - 30;
      const grd = g.createLinearGradient(x, y, x + w * 0.4, y + h);
      grd.addColorStop(0, tints[r * cols + c]); grd.addColorStop(1, '#16222c');
      g.fillStyle = grd; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x, y, w, h * 0.35);
      g.fillStyle = '#9da3a8'; g.fillRect(x + w / 2 - 2, y, 4, h);
    }
  });
  const rough = canvasTex(S, S, (g) => {
    g.fillStyle = '#ff8c00'; g.fillRect(0, 0, S, S);
    const cw = S / cols, rh = S / rows;
    g.fillStyle = '#000c00';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) g.fillRect(c * cw + 6, r * rh + 22, cw - 12, rh - 30);
  }, false);
  return { color, rough };
}

/** Материал фасада: штукатурка/рамы окрашиваются цветом вершин, стекло — нет. */
function facadeMaterial(tex: { color: THREE.Texture; rough: THREE.Texture }, metal: number, env: number) {
  const m = new THREE.MeshStandardMaterial({ map: tex.color, roughnessMap: tex.rough, roughness: 1, metalness: metal, vertexColors: true, envMapIntensity: env });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', 'vec4 texel = texture2D( map, vMapUv ); diffuseColor.rgb *= texel.rgb; float paintMask = texture2D( roughnessMap, vRoughnessMapUv ).r;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, paintMask );');
  };
  m.customProgramCacheKey = () => 'facade';
  return m;
}

// ——— здания (уникальные — склеиваются в один меш на чанк) ———
function boxUV(w: number, h: number, d: number, tileW: number, tileH: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ny > 0.5) uv.setXY(i, 0.004, 0.004);                   // крыша/низ — однотонный кусок плитки (рама/штукатурка)
    else uv.setXY(i, ((nx > 0.5 ? z : x) + 50) / tileW, (y + h / 2) / tileH);
  }
  return g;
}

export interface BuildingParts { wall: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[]; solid: THREE.BufferGeometry[]; }

export function withColor(g: THREE.BufferGeometry, hex: number, keepUv: boolean) {
  const out = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(out.attributes)) if (!['position', 'normal', ...(keepUv ? ['uv'] : [])].includes(k)) out.deleteAttribute(k);
  const c = new THREE.Color(hex);
  const arr = new Float32Array(out.getAttribute('position').count * 3);
  for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
  out.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return out;
}

const WALLS = [0xf1e6cf, 0xe9d3b0, 0xd9e3e6, 0xf3efe6, 0xe7c7a6, 0xcfd9c2, 0xf0d9d0];
const ROOFS = [0x6e3b2c, 0x4a4f57, 0x7a5a3a, 0x3d4a5c, 0x8a4430];
const TOWER_FRAMES = [0xb8bcc0, 0x8e949a, 0xd6cfc2, 0x5f666e];

/** Дом: стены с окнами (u — по 4 м, v — по 3 м), двускатная крыша, труба, крыльцо. Перед дома — +Z. */
export function house(out: BuildingParts, m: THREE.Matrix4, rnd: () => number, w: number, d: number) {
  const floors = rnd() < 0.55 ? 1 : 2, h = floors * 3;
  const wall = WALLS[Math.floor(rnd() * WALLS.length)], roofC = ROOFS[Math.floor(rnd() * ROOFS.length)];
  out.wall.push(withColor(boxUV(w, h, d, 4, 3), wall, true).translate(0, h / 2 - 0.4, 0).applyMatrix4(m));
  out.solid.push(withColor(new THREE.BoxGeometry(w + 0.2, 0.5, d + 0.2), 0x7d7a74, false).translate(0, -0.35, 0).applyMatrix4(m));
  // крыша: треугольная призма вдоль X со свесами
  const rh = 1.6 + rnd() * 1.2;
  const shape = new THREE.Shape([new THREE.Vector2(-d / 2 - 0.5, 0), new THREE.Vector2(d / 2 + 0.5, 0), new THREE.Vector2(0, rh)]);
  const roof = new THREE.ExtrudeGeometry(shape, { depth: w + 0.8, bevelEnabled: false });
  roof.rotateY(Math.PI / 2).translate(-(w + 0.8) / 2, h - 0.4, 0);
  out.solid.push(withColor(roof, roofC, false).applyMatrix4(m));
  if (rnd() < 0.7) out.solid.push(withColor(new THREE.BoxGeometry(0.6, 1.6, 0.6), 0x8a5a44, false).translate(w * 0.25, h + rh * 0.6, -d * 0.15).applyMatrix4(m));
  // дверь и крыльцо
  out.solid.push(withColor(new THREE.BoxGeometry(1.0, 2.1, 0.08), 0x5a3e2b, false).translate(-w * 0.2, 0.65, d / 2 + 0.02).applyMatrix4(m));
  out.solid.push(withColor(new THREE.BoxGeometry(2.0, 0.25, 1.2), 0x9a958c, false).translate(-w * 0.2, -0.3, d / 2 + 0.6).applyMatrix4(m));
}

/** Высотка: стеклянные фасады, парапет, техника на крыше, тёмный первый этаж. */
export function tower(out: BuildingParts, m: THREE.Matrix4, rnd: () => number, hMax: number, w: number, d: number) {
  const h = Math.round((18 + rnd() * (hMax - 18)) / 3.5) * 3.5;
  const frame = TOWER_FRAMES[Math.floor(rnd() * TOWER_FRAMES.length)];
  out.glass.push(withColor(boxUV(w, h, d, 12, 14), frame, true).translate(0, h / 2 + 4, 0).applyMatrix4(m));
  out.solid.push(withColor(new THREE.BoxGeometry(w + 0.6, 4.5, d + 0.6), 0x2a2e33, false).translate(0, 2.0, 0).applyMatrix4(m));
  out.solid.push(withColor(new THREE.BoxGeometry(w + 0.3, 1.0, d + 0.3), frame, false).translate(0, h + 4.4, 0).applyMatrix4(m));
  const units = 1 + Math.floor(rnd() * 3);
  for (let u = 0; u < units; u++) {
    const uw = 3 + rnd() * 5, ud = 3 + rnd() * 5, uh = 1.5 + rnd() * 3;
    out.solid.push(withColor(new THREE.BoxGeometry(uw, uh, ud), 0x7a7f85, false)
      .translate((rnd() - 0.5) * (w - uw - 2), h + 4 + uh / 2, (rnd() - 0.5) * (d - ud - 2)).applyMatrix4(m));
  }
  // ступенчатая верхушка у части башен
  if (h > 45 && rnd() < 0.5) {
    const h2 = 7 + rnd() * 10;
    out.glass.push(withColor(boxUV(w * 0.6, h2, d * 0.6, 12, 14), frame, true).translate(0, h + 4 + h2 / 2, 0).applyMatrix4(m));
  }
}


/**
 * Заправка у съезда. Локальные оси: +X — вдоль дороги, +Z — от дороги (вправо), начало — центр полосы съезда у колонки.
 */
export function exitStation(out: BuildingParts, m: THREE.Matrix4) {
  const S = (g: THREE.BufferGeometry, c: number) => out.solid.push(withColor(g, c, false).applyMatrix4(m));
  // площадка (толстая — закрывает неровности под ней)
  S(new THREE.BoxGeometry(64, 1.6, 24).translate(0, -0.79, 13.8), 0x6a6d70);
  S(new THREE.BoxGeometry(64, 0.02, 0.2).translate(0, 0.02, 2.0), 0xd8d6cf);
  // островок с колонками у правого края полосы
  S(new THREE.BoxGeometry(12, 0.22, 1.3).translate(0, 0.11, 2.75), 0xb8b6b0);
  for (const x of [-3.2, 3.2]) {
    S(new THREE.BoxGeometry(0.9, 1.75, 0.55).translate(x, 1.1, 2.75), 0xeeeeec);
    S(new THREE.BoxGeometry(0.92, 0.35, 0.57).translate(x, 1.8, 2.75), 0xd2401f);
    S(new THREE.BoxGeometry(0.5, 0.35, 0.02).translate(x, 1.35, 2.47), 0x1c2a33);
    S(new THREE.BoxGeometry(0.06, 0.06, 0.5).translate(x - 0.3, 1.0, 2.35), 0x222222);
  }
  // навес над полосой: колонны справа, консоль над машиной
  for (const x of [-6, 6]) for (const z of [2.75, 9]) S(new THREE.BoxGeometry(0.45, 5.2, 0.45).translate(x, 2.6, z), 0xe2e2e0);
  S(new THREE.BoxGeometry(16, 0.7, 11.5).translate(0, 5.55, 4.2), 0xf3f3f1);
  S(new THREE.BoxGeometry(16.1, 0.35, 11.6).translate(0, 5.05, 4.2), 0xd2401f);
  S(new THREE.BoxGeometry(15.4, 0.04, 11).translate(0, 5.18, 4.2), 0xfff4dc);
  // магазин
  out.wall.push(withColor(boxUV(14, 4, 8, 4, 3), 0xf3f0ea, true).translate(0, 1.6, 18).applyMatrix4(m));
  S(new THREE.BoxGeometry(14.4, 0.6, 8.4).translate(0, 3.9, 18), 0xd2401f);
  S(new THREE.BoxGeometry(3, 2.4, 0.1).translate(-3, 1.2, 13.98), 0x1c2a33);
}

/** Автосервис у съезда (те же локальные оси, что у заправки): боксы с воротами, подъёмник, шины. */
export function repairShop(out: BuildingParts, m: THREE.Matrix4) {
  const S = (g: THREE.BufferGeometry, c: number) => out.solid.push(withColor(g, c, false).applyMatrix4(m));
  S(new THREE.BoxGeometry(64, 1.6, 24).translate(0, -0.79, 13.8), 0x6a6d70);
  S(new THREE.BoxGeometry(64, 0.02, 0.2).translate(0, 0.02, 2.0), 0xd8d6cf);
  // здание: два бокса, ворота к дороге
  const bz = 11.5;
  S(new THREE.BoxGeometry(20, 6.2, 11).translate(0, 3.1, bz + 5.5), 0xc9d2da);
  S(new THREE.BoxGeometry(20.4, 0.5, 11.4).translate(0, 6.4, bz + 5.5), 0x2f5f9e);
  S(new THREE.BoxGeometry(20.2, 0.6, 0.2).translate(0, 0.3, bz - 0.05), 0x8a9096);
  for (const x of [-5, 5]) {
    S(new THREE.BoxGeometry(7.4, 4.4, 0.12).translate(x, 2.2, bz - 0.06), 0x30353b);       // проём
    S(new THREE.BoxGeometry(7.8, 0.25, 0.25).translate(x, 4.5, bz - 0.12), 0x2f5f9e);      // перемычка
  }
  // левые ворота подняты: внутри подъёмник и тёмный бокс
  S(new THREE.BoxGeometry(7.2, 4.3, 6).translate(-5, 2.15, bz + 3), 0x1b1e22);
  for (const x of [-7.6, -2.4]) S(new THREE.BoxGeometry(0.35, 3.6, 0.35).translate(x, 1.8, bz + 2.5), 0xf2c21b);
  S(new THREE.BoxGeometry(5.6, 0.2, 2).translate(-5, 1.6, bz + 2.5), 0x8a8f94);
  // правые ворота опущены — рифлёные полосы
  for (let k = 0; k < 11; k++) S(new THREE.BoxGeometry(7.3, 0.06, 0.04).translate(5, 0.25 + k * 0.4, bz - 0.15), 0x9aa3ab);
  // шины в стопках, бочки, компрессор
  for (const [x, z, n] of [[9.5, 8.5, 4], [10.6, 8.6, 3], [-9.8, 9.0, 5]] as const) {
    for (let k = 0; k < n; k++) {
      const t = new THREE.TorusGeometry(0.34, 0.14, 8, 18).rotateX(Math.PI / 2);
      S(t.translate(x, 0.15 + k * 0.28, z), 0x161616);
    }
  }
  for (const [x, z] of [[12.5, 9.5], [13.3, 9.9]] as const) S(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 14).translate(x, 0.45, z), 0x2b5fa8);
  S(new THREE.BoxGeometry(1.0, 1.1, 0.7).translate(-12.5, 0.55, 9.6), 0xd2401f);
  // разметка места ремонта у полосы
  for (const x of [-3, 3]) S(new THREE.BoxGeometry(0.15, 0.02, 3.2).translate(x, 0.025, 3.6), 0xe8d24a);
}

export class PropKit {
  readonly geo: Record<PropId, THREE.BufferGeometry>;
  readonly mat: THREE.MeshStandardMaterial;
  readonly coniferMat: THREE.MeshStandardMaterial;
  readonly bare: Partial<Record<PropId, THREE.BufferGeometry>>;
  private readonly snowOnBranches = { value: 0 };

  setTreeSnow(amount: number) { this.snowOnBranches.value = amount; }
  readonly festiveMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  readonly houseMat: THREE.MeshStandardMaterial;
  readonly towerMat: THREE.MeshStandardMaterial;
  readonly solidMat: THREE.MeshStandardMaterial;
  readonly wireMat: THREE.MeshStandardMaterial;
  readonly signs = new Map<string, THREE.Material>();
  readonly ads: THREE.Material[];

  constructor() {
    this.geo = {
      pine: pine(false), pineLo: pine(true),
      oak: blobTree(0x4a3a2a, 0x3f6a2e, false), oakLo: blobTree(0x4a3a2a, 0x3f6a2e, true),
      birch: blobTree(0xe8e6df, 0x6f9a3e, false, true), birchLo: blobTree(0xe8e6df, 0x6f9a3e, true, true),
      bush: bush(0x41652f, false), dryBush: bush(0x8a7a52, true),
      spruce: spruce(false), spruceLo: spruce(true), festiveLights: festiveLights(),
      cactus: cactus(false), cactusLo: cactus(true),
      rock: rock(0x8d8478, false, 3), rockLo: rock(0x8d8478, true, 3), redRock: rock(0xa8633e, false, 9),
      delineator: delineator(), lamp: lamp(), powerPole: powerPole(), lifeguard: lifeguard(), fence: fence(),
    };
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
    this.bare = { oak: bareTree(false, false), oakLo: bareTree(true, false),
      birch: bareTree(false, true), birchLo: bareTree(true, true) };
    // Одинаковая сфера для обеих крон: при переключении уже созданных инстансов отсечение остаётся корректным.
    for (const [id, geometry] of Object.entries(this.bare) as [PropId, THREE.BufferGeometry][]) {
      const bounds = this.geo[id].boundingSphere!.union(geometry.boundingSphere!);
      geometry.boundingSphere!.copy(bounds);
    }
    this.coniferMat = this.mat.clone();
    this.coniferMat.customProgramCacheKey = () => 'snow-on-conifers';
    this.coniferMat.onBeforeCompile = (shader) => {
      shader.uniforms.branchSnow = this.snowOnBranches;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float snowMask;\nvarying float branchMask;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nbranchMask = snowMask;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float branchSnow;\nvarying float branchMask;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.79, 0.86, 0.94), branchSnow * branchMask);');
    };
    this.houseMat = facadeMaterial(houseTile(), 0, 0.6);
    this.towerMat = facadeMaterial(towerTile(5), 0.25, 1.3);
    this.solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    this.wireMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6 });
    this.ads = [
      ['ЛЕТО', 'кефир «Облако»', '#ff8a3d', '#1b2a4a'],
      ['ШИНЫ ГРИП', 'держат дорогу', '#111', '#f5c518'],
      ['МОТЕЛЬ 24', 'через 3 км направо', '#fff', '#2f6b4f'],
      ['МОРЕ БЛИЗКО', 'Солнечная Бухта · 12 км', '#0d3b66', '#f4d35e'],
      ['КОФЕ С СОБОЙ', 'на каждой заправке', '#fff', '#6b3e26'],
    ].map(([a, b, fg, bg]) => new THREE.MeshStandardMaterial({ roughness: 0.6, map: canvasTex(1024, 384, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, 1024, 384);
      g.fillStyle = fg; g.globalAlpha = 0.18; g.beginPath(); g.arc(860, 300, 260, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      g.font = '900 130px "Arial Black", Arial, sans-serif'; g.textBaseline = 'middle'; g.fillText(a, 50, 150);
      g.font = '600 56px Arial, sans-serif'; g.fillText(b, 56, 285);
    }) }));
  }

  /** Знак по шаблону: 'speed:90', 'town:Сосновка', 'km:12', 'fuel', 'dir:Береговое|12'. */
  sign(key: string): THREE.Material {
    let m = this.signs.get(key);
    if (m) return m;
    const [kind, arg = ''] = key.split(':');
    const tex = kind === 'speed'
      ? canvasTex(256, 256, (g) => {
        g.fillStyle = '#fff'; g.beginPath(); g.arc(128, 128, 124, 0, 7); g.fill();
        g.strokeStyle = '#d0121b'; g.lineWidth = 30; g.beginPath(); g.arc(128, 128, 108, 0, 7); g.stroke();
        g.fillStyle = '#111'; g.font = 'bold 110px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(arg, 128, 136);
      })
      : kind === 'town'
        ? canvasTex(512, 192, (g) => {
          g.fillStyle = '#fff'; g.fillRect(0, 0, 512, 192);
          g.strokeStyle = '#111'; g.lineWidth = 12; g.strokeRect(10, 10, 492, 172);
          g.fillStyle = '#111'; g.font = 'bold 72px "Arial Narrow", Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(arg, 256, 100);
        })
        : kind === 'service'
          ? canvasTex(512, 128, (g) => {
            g.fillStyle = '#2f5f9e'; g.fillRect(0, 0, 512, 128);
            g.fillStyle = '#fff'; g.font = '900 64px "Arial Black", Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('АВТОСЕРВИС', 290, 68);
            // гаечный ключ
            g.save(); g.translate(58, 64); g.rotate(-0.7);
            g.fillRect(-6, -34, 12, 54);
            g.beginPath(); g.arc(0, -36, 18, 0, Math.PI * 2); g.fill();
            g.fillStyle = '#2f5f9e'; g.fillRect(-7, -60, 14, 26);
            g.restore();
          })
        : kind === 'fuel'
          ? canvasTex(512, 128, (g) => {
            g.fillStyle = '#d2401f'; g.fillRect(0, 0, 512, 128);
            g.fillStyle = '#fff'; g.font = '900 80px "Arial Black", Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('ТОПЛИВО 24', 256, 68);
          })
          : canvasTex(512, 192, (g) => {
            const [name, km] = arg.split('|');
            g.fillStyle = '#1d4fa3'; g.fillRect(0, 0, 512, 192);
            g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(12, 12, 488, 168);
            g.fillStyle = '#fff'; g.font = 'bold 60px "Arial Narrow", Arial'; g.textBaseline = 'middle';
            g.fillText(name, 40, 96); g.textAlign = 'right'; g.fillText(km, 470, 96);
          });
    m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45 });
    this.signs.set(key, m);
    return m;
  }
}

/** Дальний пояс: кольца гор с воздушной перспективой (без тумана сцены). */
export function mountainRing(radius: number, hMin: number, hMax: number, seed: number, near: THREE.Color, far: THREE.Color) {
  const N = 400, pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const n = fbm2(Math.cos(a) * 3 + 10, Math.sin(a) * 3 + 10, 5, seed);
    const ridge = 1 - Math.abs(fbm2(Math.cos(a) * 7, Math.sin(a) * 7, 3, seed + 1) * 2 - 1);
    const h = hMin + (hMax - hMin) * smoothstep(0.3, 0.75, n) * (0.7 + ridge * 0.3);
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    // три ряда: подножие в дымке, середина, гребень
    for (const [k, t] of [[0, 0], [0.55, 0.6], [1, 1]] as const) {
      pos.push(x, -80 + (h + 80) * k, z);
      const c = far.clone().lerp(near, t);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < N; i++) for (let r = 0; r < 2; r++) {
    const a = i * 3 + r, b = a + 3;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
  m.frustumCulled = false;
  return m;
}
