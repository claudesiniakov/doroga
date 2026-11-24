/**
 * КБМ (бонус-малус) ОСАГО: коэффициенты и
 * переходы между классами за год — по числу страховых случаев (0, 1, 2, 3, 4+).
 * В игре новичок начинает с класса 3.
 */
export interface KbmRow { cls: string; k: number; next: [number, number, number, number, number]; }

// индексы: 0 — «М», 1 — класс 0, …, 14 — класс 13
export const KBM: KbmRow[] = [
  { cls: 'М', k: 3.92, next: [1, 0, 0, 0, 0] },
  { cls: '0', k: 2.94, next: [2, 0, 0, 0, 0] },
  { cls: '1', k: 2.25, next: [3, 0, 0, 0, 0] },
  { cls: '2', k: 1.76, next: [4, 2, 0, 0, 0] },
  { cls: '3', k: 1.17, next: [5, 2, 0, 0, 0] },
  { cls: '4', k: 1.0, next: [6, 3, 2, 0, 0] },
  { cls: '5', k: 0.91, next: [7, 4, 2, 0, 0] },
  { cls: '6', k: 0.83, next: [8, 5, 3, 0, 0] },
  { cls: '7', k: 0.78, next: [9, 5, 3, 0, 0] },
  { cls: '8', k: 0.74, next: [10, 6, 3, 0, 0] },
  { cls: '9', k: 0.68, next: [11, 6, 3, 2, 0] },
  { cls: '10', k: 0.63, next: [12, 7, 4, 2, 0] },
  { cls: '11', k: 0.57, next: [13, 7, 4, 2, 0] },
  { cls: '12', k: 0.52, next: [14, 7, 4, 2, 0] },
  { cls: '13', k: 0.46, next: [14, 8, 4, 2, 0] },
];

export const KBM_START = 4; // класс 3 — новичок
export const OSAGO_BASE = 10;

export const osagoFactors = (idx: number) => [OSAGO_BASE, 1, KBM[idx].k, 1, 1, 1, 1];
export const osagoPrice = (idx: number) => Math.max(1, Math.round(osagoFactors(idx).reduce((price, factor) => price * factor, 1)));
export const kbmNext = (idx: number, claims: number) => KBM[idx].next[Math.min(4, Math.max(0, claims))];

export function loadKbm(): number {
  try {
    const v = Number(localStorage.getItem('doroga.kbm'));
    if (Number.isInteger(v) && v >= 0 && v < KBM.length && localStorage.getItem('doroga.kbm') !== null) return v;
  } catch { /* нет хранилища */ }
  return KBM_START;
}

export function saveKbm(idx: number) {
  try { localStorage.setItem('doroga.kbm', String(idx)); } catch { /* нет хранилища */ }
}

export const fmtK = (k: number) => k.toFixed(2).replace('.', ',');
