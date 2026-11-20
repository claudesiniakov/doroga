import * as THREE from 'three';
import { mulberry32, tfbm2, tnoise2, clamp, smoothstep } from './noise';

/** Геометрия полотна (метры). Используется и текстурой, и мешем дороги. */
export const ROAD = {
  laneWidth: 3.5,
  lanes: 3,
  shoulder: 1.5,
  /** Полуширина асфальта: 3 полосы + обочина. */
  get half() { return (this.laneWidth * this.lanes) / 2 + this.shoulder; },
  /** Период текстуры вдоль дороги (длина цикла разметки). */
  period: 12,
};

export interface RoadTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  grimeMap: THREE.Texture;
}

function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean, repeat = true): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Нормали из карты высот (бесшовно по обеим осям). */
function heightToNormal(hgt: Float32Array, w: number, h: number, strength: number, wrapX = true): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const at = (x: number, y: number) => {
    x = wrapX ? (x + w) % w : clamp(x, 0, w - 1);
    y = (y + h) % h;
    return hgt[y * w + x];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Трещины, залитые битумом: ломаные с переносом по V (бесшовно). */
function drawCracks(mask: Float32Array, w: number, h: number, rnd: () => number, count: number, xMin: number, xMax: number) {
  for (let c = 0; c < count; c++) {
    let x = xMin + rnd() * (xMax - xMin);
    let y = rnd() * h;
    let ang = rnd() * Math.PI * 2;
    const len = 80 + rnd() * 420;
    const width = 1.4 + rnd() * 2.2;
    for (let s = 0; s < len; s++) {
      ang += (rnd() - 0.5) * 0.35;
      x += Math.cos(ang);
      y += Math.sin(ang);
      if (x < xMin || x > xMax) break;
      const r = Math.ceil(width);
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const d = Math.hypot(ox, oy);
          if (d > width) continue;
          const px = Math.round(x + ox), py = (((Math.round(y + oy)) % h) + h) % h;
          if (px < 0 || px >= w) continue;
          const k = py * w + px;
          mask[k] = Math.max(mask[k], 1 - d / width);
        }
      }
    }
  }
}

/**
 * Полотно на всю ширину (U: 0..2*half метров) и один период разметки (V: 0..period метров).
 * Разметка, колея, заплатки, трещины и щебень «запечены» в текстуры.
 */
export function makeRoadTextures(size = 1024, seed = 7): RoadTextures {
  const W = size, H = size;
  const half = ROAD.half;
  const widthM = half * 2;
  const mPerPxX = widthM / W;
  const mPerPxY = ROAD.period / H;
  const rnd = mulberry32(seed);

  const albedo = new Uint8Array(W * H * 4);
  const rough = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const cracks = new Float32Array(W * H);

  // трещины — только на асфальте, по всей ширине
  drawCracks(cracks, W, H, rnd, 3, 0, W);

  const lw = ROAD.laneWidth;
  const edgeL = half - ROAD.shoulder; // расстояние от центра до краевой линии
  const lineW = 0.15, dashW = 0.13, dashLen = 3;
  const dashCenters = [-lw / 2, lw / 2];

  for (let y = 0; y < H; y++) {
    const vM = y * mPerPxY;
    for (let x = 0; x < W; x++) {
      const uM = x * mPerPxX - half; // от центра дороги, м
      const i = y * W + x;

      // зерно асфальта: мелкий щебень + средняя неоднородность
      const fine = tfbm2(x / 4, y / 4, W / 4, H / 4, 3, 11);
      const grain = tnoise2(x / 2, y / 2, W / 2, H / 2, 5);
      const medium = tfbm2(x / 64, y / 64, W / 64, H / 64, 4, 3);
      const stone = grain > 0.86 ? (grain - 0.86) / 0.14 : 0; // светлые камешки
      const pit = grain < 0.1 ? (0.1 - grain) / 0.1 : 0;      // поры

      let base = 0.165 + (medium - 0.5) * 0.06 + (fine - 0.5) * 0.05 + stone * 0.16 - pit * 0.06;
      let r = 0.86 + (fine - 0.5) * 0.1 - stone * 0.15;
      let hgt = fine * 0.6 + stone * 0.9 - pit * 0.9;

      // колея: укатанные полосы от колёс — темнее и глаже
      let track = 0;
      for (const lc of [-lw, 0, lw]) {
        for (const t of [-0.82, 0.82]) {
          const d = Math.abs(uM - (lc + t));
          track = Math.max(track, 1 - smoothstep(0.18, 0.55, d));
        }
      }
      const trackN = tfbm2(x / 16, y / 128, W / 16, H / 128, 3, 21);
      track *= 0.6 + trackN * 0.5;
      base -= track * 0.035;
      r -= track * 0.2;
      hgt -= track * 0.25;

      // обочина: пыльнее и светлее, больше крошки
      const onShoulder = smoothstep(edgeL + 0.1, edgeL + 0.5, Math.abs(uM));
      base += onShoulder * (0.03 + (medium - 0.5) * 0.04);

      // трещины (битумная заливка — чёрная и глянцевая)
      const cr = cracks[i];
      if (cr > 0) {
        base = base * (1 - cr * 0.8) + 0.06 * cr * 0.8;
        r = r * (1 - cr) + 0.7 * cr;
        hgt -= cr * 0.15;
      }

      // разметка
      let paint = 0;
      for (const s of [-edgeL, edgeL]) {
        const d = Math.abs(uM - s);
        paint = Math.max(paint, 1 - smoothstep(lineW / 2 - mPerPxX, lineW / 2 + mPerPxX, d));
      }
      if (vM < dashLen) {
        const ends = smoothstep(0, 0.03, vM) * (1 - smoothstep(dashLen - 0.03, dashLen, vM));
        for (const s of dashCenters) {
          const d = Math.abs(uM - s);
          paint = Math.max(paint, ends * (1 - smoothstep(dashW / 2 - mPerPxX, dashW / 2 + mPerPxX, d)));
        }
      }
      if (paint > 0) {
        // потёртость краски: износ сильнее в колее
        const wear = tfbm2(x / 8, y / 8, W / 8, H / 8, 4, 41);
        const keep = smoothstep(0.28 + track * 0.25, 0.42 + track * 0.25, wear + stone * 0.1);
        const p = paint * keep;
        base = base * (1 - p) + (0.74 + (fine - 0.5) * 0.08) * p;
        r = r * (1 - p) + 0.62 * p;
        hgt += p * 0.35;
      }

      const c = clamp(base, 0, 1) * 255;
      const k = i * 4;
      albedo[k] = c * 1.0;
      albedo[k + 1] = c * 0.995;
      albedo[k + 2] = c * 0.985;
      albedo[k + 3] = 255;
      const rr = clamp(r, 0.05, 1) * 255;
      rough[k] = 255; rough[k + 1] = rr; rough[k + 2] = 0; rough[k + 3] = 255;
      height[i] = hgt;
    }
  }

  const normal = heightToNormal(height, W, H, 0.45, false);

  // Крупномасштабная «грязь» на весь чанк (96 м): пятна масла по центрам полос,
  // латки ремонта, пыль у краёв. Перемножается с основным цветом в шейдере.
  const GW = 128, GH = 1024;
  const grime = new Uint8Array(GW * GH * 4);
  const patches: { u0: number; u1: number; v0: number; v1: number; tone: number }[] = [];
  for (let p = 0; p < 5; p++) {
    const lane = Math.floor(rnd() * 3) - 1;
    const u0 = lane * lw - 1.2 - rnd() * 0.8;
    const u1 = u0 + 1.6 + rnd() * 2.2;
    const v0 = rnd() * 0.85;
    patches.push({ u0, u1, v0, v1: v0 + 0.02 + rnd() * 0.08, tone: rnd() < 0.5 ? 0.82 : 1.1 });
  }
  for (let y = 0; y < GH; y++) {
    const v = y / GH;
    for (let x = 0; x < GW; x++) {
      const uM = (x / GW) * widthM - half;
      let g = 1;
      // пятна масла по центру полос
      for (const lc of [-lw, 0, lw]) {
        const d = Math.abs(uM - lc);
        const oil = (1 - smoothstep(0.1, 0.7, d)) * tfbm2(x / 4, y / 16, GW / 4, GH / 16, 3, 77);
        g -= oil * 0.18;
      }
      // неравномерность покрытия по длине
      g *= 0.94 + tfbm2(x / 16, y / 64, GW / 16, GH / 64, 4, 91) * 0.12;
      // латки
      for (const p of patches) {
        if (uM > p.u0 && uM < p.u1 && v > p.v0 && v < p.v1) g *= p.tone;
      }
      // пыль у краёв асфальта
      g += smoothstep(half - 1.0, half, Math.abs(uM)) * 0.12;
      const c = clamp(g * 200, 0, 255);
      const k = (y * GW + x) * 4;
      grime[k] = c; grime[k + 1] = c; grime[k + 2] = c * 0.98; grime[k + 3] = 255;
    }
  }

  const map = dataTex(albedo, W, H, true, false);
  const normalMap = dataTex(normal, W, H, false, false);
  const roughnessMap = dataTex(rough, W, H, false, false);
  const grimeMap = dataTex(grime, GW, GH, false, false);
  return { map, normalMap, roughnessMap, grimeMap };
}

/** Бесшовная текстура травы/земли (цвет + нормаль). */
export function makeGroundTextures(size = 512) {
  const W = size, H = size;
  const albedo = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const blades = tnoise2(x / 2, y / 4, W / 2, H / 4, 2);
      const clump = tfbm2(x / 32, y / 32, W / 32, H / 32, 4, 5);
      const dirt = smoothstep(0.55, 0.75, tfbm2(x / 64, y / 64, W / 64, H / 64, 4, 9));
      const dry = tfbm2(x / 32, y / 32, W / 32, H / 32, 3, 13);
      let r = 0.20 + dry * 0.14, g = 0.26 + clump * 0.12, b = 0.09;
      const bl = blades * 0.35 + 0.8;
      r *= bl; g *= bl; b *= bl;
      r = r * (1 - dirt) + 0.30 * dirt;
      g = g * (1 - dirt) + 0.24 * dirt;
      b = b * (1 - dirt) + 0.16 * dirt;
      const k = (y * W + x) * 4;
      albedo[k] = clamp(r, 0, 1) * 255;
      albedo[k + 1] = clamp(g, 0, 1) * 255;
      albedo[k + 2] = clamp(b, 0, 1) * 255;
      albedo[k + 3] = 255;
      height[y * W + x] = blades * 0.6 + clump * 0.6 - dirt * 0.4;
    }
  }
  const map = dataTex(albedo, W, H, true);
  const normalMap = dataTex(heightToNormal(height, W, H, 2.0), W, H, false);
  return { map, normalMap };
}

/** Щебёночная полоса за асфальтом. */
export function makeGravelTextures(size = 256, seed = 5) {
  const W = size, H = size;
  const albedo = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = tnoise2(x / 2, y / 2, W / 2, H / 2, seed);
      const m = tfbm2(x / 16, y / 16, W / 16, H / 16, 3, seed + 1);
      const v = 0.28 + s * 0.22 + (m - 0.5) * 0.1;
      const k = (y * W + x) * 4;
      albedo[k] = clamp(v * 1.02, 0, 1) * 255;
      albedo[k + 1] = clamp(v * 0.97, 0, 1) * 255;
      albedo[k + 2] = clamp(v * 0.9, 0, 1) * 255;
      albedo[k + 3] = 255;
      height[y * W + x] = s;
    }
  }
  return {
    map: dataTex(albedo, W, H, true),
    normalMap: dataTex(heightToNormal(height, W, H, 3.0), W, H, false),
  };
}

/** Текстура номерного знака (оригинальный формат, не реальный). */
export function makePlateTexture(text: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 112;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f0';
  g.fillRect(0, 0, 512, 112);
  g.strokeStyle = '#111';
  g.lineWidth = 6;
  g.strokeRect(5, 5, 502, 102);
  g.fillStyle = '#121212';
  g.font = 'bold 76px "Arial Narrow", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Песок: мелкая рябь от ветра + зерно (бесшовно). */
export function makeSandTextures(size = 512) {
  const W = size, H = size;
  const albedo = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const warp = tfbm2(x / 64, y / 64, W / 64, H / 64, 3, 71) * 6;
      const ripple = Math.sin(((y / H) * 24 + warp) * Math.PI * 2) * 0.5 + 0.5;
      const grain = tnoise2(x / 2, y / 2, W / 2, H / 2, 72);
      const tone = tfbm2(x / 32, y / 32, W / 32, H / 32, 3, 73);
      const v = 0.62 + ripple * 0.06 + (grain - 0.5) * 0.12 + (tone - 0.5) * 0.1;
      const k = (y * W + x) * 4;
      albedo[k] = clamp(v * 1.0, 0, 1) * 255;
      albedo[k + 1] = clamp(v * 0.86, 0, 1) * 255;
      albedo[k + 2] = clamp(v * 0.66, 0, 1) * 255;
      albedo[k + 3] = 255;
      height[y * W + x] = ripple * 0.8 + grain * 0.5;
    }
  }
  return { map: dataTex(albedo, W, H, true), normalMap: dataTex(heightToNormal(height, W, H, 1.2), W, H, false) };
}

/** Нормали ряби на воде (бесшовно). */
export function makeWaterNormal(size = 512) {
  const W = size, H = size;
  const height = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      height[y * W + x] = tfbm2(x / 32, y / 16, W / 32, H / 16, 5, 81) * 1.0 + tnoise2(x / 8, y / 4, W / 8, H / 4, 82) * 0.25;
    }
  }
  return dataTex(heightToNormal(height, W, H, 6), W, H, false);
}
