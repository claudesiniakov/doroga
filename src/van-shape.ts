import * as THREE from 'three';
import { Shape } from './traffic-models';
import { spline } from './car';

/** Общая форма минивэна (машина игрока «Простор 7» и вариант в трафике). +Z — вперёд, +X — левый борт. */
export const VAN = { R: 0.34, axF: 1.42, axR: -1.53, track: 0.8, halfLen: 2.4 };

export function vanShape(): Shape {
  return new Shape({
    halfLen: VAN.halfLen,
    top: [[-2.4, 0.95], [-2.385, 1.04], [-1.5, 1.045], [0, 1.03], [1.2, 1.0], [1.6, 0.93], [2.05, 0.82], [2.32, 0.7], [2.4, 0.52]],
    bottom: [[-2.4, 0.44], [-2.2, 0.3], [-1.95, 0.22], [1.9, 0.22], [2.2, 0.26], [2.4, 0.36]],
    width: [[-2.4, 0.9], [-2.0, 0.94], [0, 0.95], [1.6, 0.94], [2.2, 0.88], [2.4, 0.8]],
    planFront: 6, planRear: 16, axles: [VAN.axF, VAN.axR], wheelR: VAN.R, archR: 0.39,
    seLow: 9, seHigh: 4.5, tumble: 0.05,
  });
}

/** «Аквариум»: раскосое лобовое (однообъёмник), высокая плоская крыша, почти вертикальная пятая дверь. */
export function vanGreenhouse(sh: Shape, GR = 90, GK = 30) {
  const zA = 1.45, zC = -2.375;
  const roof = spline([[zC, sh.top(zC)], [-2.355, 1.56], [-2.24, 1.72], [0.55, 1.765], [0.85, 1.7], [1.2, 1.42], [zA, sh.top(zA)]]);
  const sOf: number[] = [];
  for (let k = 0; k <= GK; k++) sOf.push(Math.sin((Math.PI * k) / GK));
  const rows: THREE.Vector3[][] = [];
  for (let r = 0; r < GR; r++) {
    const t = r / (GR - 1);
    const z = zC + (zA - zC) * (t < 0.05 ? t * 0.3 : 0.015 + (t - 0.05) * (0.985 / 0.95));
    const yb = sh.top(z) - 0.01, H = Math.max(0, roof(z) - yb);
    const wb = sh.xAt(z, yb) - 0.03, wr = Math.min(wb, 0.8);
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k <= GK; k++) {
      const phi = Math.PI - (Math.PI * k) / GK;
      const s = Math.sin(phi), c = Math.cos(phi);
      const a = wb + (wr - wb) * Math.min(1, s * 1.05);
      ring.push(new THREE.Vector3(Math.sign(c) * a * Math.pow(Math.abs(c), 2 / 4), yb + H * Math.pow(s, 2 / 5), z));
    }
    rows.push(ring);
  }
  // 0 — кузов, 1 — стекло, 2 — чёрные стойки/уплотнитель
  const classify = (p: THREE.Vector3, _r: number, c: number) => {
    const s = (sOf[c] + sOf[c + 1]) / 2, z = p.z;
    if (s < 0.06) return 2;
    if (z > 0.85) return s > 0.6 && s < 0.76 ? 0 : 1;               // лобовое и A-стойки
    // пятая дверь: на вертикальном изломе каждый столбец сетки идёт от пояса до крыши — стекло всё, кроме краёв
    if (z < -2.3) return s > 0.14 ? 1 : 0;
    if (s > 0.86) return 0;                                          // крыша
    if (Math.abs(z - 0.15) < 0.05) return 2;                         // B-стойка
    if (Math.abs(z + 0.95) < 0.05) return 2;                         // за сдвижной дверью
    if (z < -2.0) return 0;                                          // D-стойка
    return 1;
  };
  return { rows, classify, zA, zC };
}

/** Кузов: бамперы и пороги — пластик. */
export function vanBodyClassify(sh: Shape) {
  return (p: THREE.Vector3) => {
    const ax = Math.abs(p.x), bot = sh.bottom(p.z);
    if (p.z > 2.15 && p.y > 0.3 && p.y < 0.5 && ax < 0.62) return 1;   // нижняя решётка
    if (p.z < -2.25 && p.y < 0.42) return 1;                          // задний бампер снизу
    if (p.y < sh.base(p.z) + 0.08 && p.y < bot + 0.08 && ax > 0.55) return 1; // пороги (без арок)
    return 0;
  };
}
