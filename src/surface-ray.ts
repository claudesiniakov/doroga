import * as THREE from 'three';

type Axis = 0 | 1 | 2;

/**
 * Ускоренный поиск пересечения осевого луча с мешем.
 *
 * Raycaster перебирает все треугольники меша: для кузова (~30 тыс. треугольников)
 * и тысяч лучей, которые «продавливают» накладки на поверхность, это секунды
 * работы главного потока. Здесь для каждой оси строится 2D-сетка по проекции
 * треугольников, и луч проверяет только треугольники своей ячейки. Для осевых
 * лучей результат совпадает с Raycaster (те же треугольники, та же точка).
 */
class AxisSurface {
  private readonly pos: Float32Array;
  private readonly tri: ArrayLike<number> | null;
  private readonly triCount: number;
  private readonly uAxis: number;
  private readonly vAxis: number;
  private readonly facing: Int8Array;
  private readonly cellStart: Int32Array;
  private readonly cellTris: Int32Array;
  private readonly uMin: number;
  private readonly vMin: number;
  private readonly uStep: number;
  private readonly vStep: number;
  private static readonly CELLS = 48;

  constructor(geometry: THREE.BufferGeometry, private readonly axis: Axis, private readonly cullBack: boolean) {
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    this.pos = attribute.array as Float32Array;
    const index = geometry.getIndex();
    this.tri = index ? index.array : null;
    this.triCount = Math.floor((index ? index.count : attribute.count) / 3);

    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    this.uAxis = (axis + 1) % 3;
    this.vAxis = (axis + 2) % 3;
    this.uMin = component(box.min, this.uAxis);
    this.vMin = component(box.min, this.vAxis);
    this.uStep = Math.max(1e-6, (component(box.max, this.uAxis) - this.uMin) / AxisSurface.CELLS);
    this.vStep = Math.max(1e-6, (component(box.max, this.vAxis) - this.vMin) / AxisSurface.CELLS);

    const cells = AxisSurface.CELLS * AxisSurface.CELLS;
    const counts = new Int32Array(cells + 1);
    this.facing = new Int8Array(this.triCount);
    for (let t = 0; t < this.triCount; t++) {
      const [au, av, bu, bv, cu, cv] = this.triangle2d(t);
      this.facing[t] = Math.sign((bu - au) * (cv - av) - (bv - av) * (cu - au));
      this.forEachCell(au, av, bu, bv, cu, cv, (cell) => { counts[cell + 1]++; });
    }

    this.cellStart = new Int32Array(cells + 1);
    for (let i = 1; i <= cells; i++) this.cellStart[i] = this.cellStart[i - 1] + counts[i];
    this.cellTris = new Int32Array(this.cellStart[cells]);
    const cursor = this.cellStart.slice();
    for (let t = 0; t < this.triCount; t++) {
      const [au, av, bu, bv, cu, cv] = this.triangle2d(t);
      this.forEachCell(au, av, bu, bv, cu, cv, (cell) => { this.cellTris[cursor[cell]++] = t; });
    }
  }

  /** 2D-координаты треугольника (u/v) — без аллокаций объекта на треугольник. */
  private triangle2d(t: number): number[] {
    const a = this.tri ? this.tri[t * 3] : t * 3;
    const b = this.tri ? this.tri[t * 3 + 1] : t * 3 + 1;
    const c = this.tri ? this.tri[t * 3 + 2] : t * 3 + 2;
    return [
      this.pos[a * 3 + this.uAxis], this.pos[a * 3 + this.vAxis],
      this.pos[b * 3 + this.uAxis], this.pos[b * 3 + this.vAxis],
      this.pos[c * 3 + this.uAxis], this.pos[c * 3 + this.vAxis],
    ];
  }

  private forEachCell(au: number, av: number, bu: number, bv: number, cu: number, cv: number, visit: (cell: number) => void) {
    const i0 = this.cellOf(Math.min(au, bu, cu), this.uMin, this.uStep);
    const i1 = this.cellOf(Math.max(au, bu, cu), this.uMin, this.uStep);
    const j0 = this.cellOf(Math.min(av, bv, cv), this.vMin, this.vStep);
    const j1 = this.cellOf(Math.max(av, bv, cv), this.vMin, this.vStep);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) visit(j * AxisSurface.CELLS + i);
    }
  }

  private cellOf(value: number, min: number, step: number) {
    const cell = Math.floor((value - min) / step);
    return cell < 0 ? 0 : cell >= AxisSurface.CELLS ? AxisSurface.CELLS - 1 : cell;
  }

  /** Координата вдоль оси для луча, идущего со стороны +∞ (fromPositive) или −∞. */
  hit(u: number, v: number, fromPositive: boolean): number | undefined {
    const cell = this.cellOf(v, this.vMin, this.vStep) * AxisSurface.CELLS + this.cellOf(u, this.uMin, this.uStep);
    const want = fromPositive ? 1 : -1;
    let best = fromPositive ? -Infinity : Infinity;
    let found = false;
    for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
      const t = this.cellTris[k];
      if (this.cullBack && this.facing[t] !== want) continue;
      const a = this.tri ? this.tri[t * 3] : t * 3;
      const b = this.tri ? this.tri[t * 3 + 1] : t * 3 + 1;
      const c = this.tri ? this.tri[t * 3 + 2] : t * 3 + 2;
      const au = this.pos[a * 3 + this.uAxis], av = this.pos[a * 3 + this.vAxis];
      const bu = this.pos[b * 3 + this.uAxis], bv = this.pos[b * 3 + this.vAxis];
      const cu = this.pos[c * 3 + this.uAxis], cv = this.pos[c * 3 + this.vAxis];
      const det = (bu - au) * (cv - av) - (bv - av) * (cu - au);
      if (!det) continue;
      const wa = ((bu - u) * (cv - v) - (bv - v) * (cu - u)) / det;
      const wb = ((cu - u) * (av - v) - (cv - v) * (au - u)) / det;
      const wc = 1 - wa - wb;
      const eps = -1e-9;
      if (wa < eps || wb < eps || wc < eps) continue;
      const point = wa * this.pos[a * 3 + this.axis] + wb * this.pos[b * 3 + this.axis] + wc * this.pos[c * 3 + this.axis];
      if (fromPositive ? point > best : point < best) {
        best = point;
        found = true;
      }
    }
    return found ? best : undefined;
  }
}

const component = (v: THREE.Vector3, axis: number) => (axis === 0 ? v.x : axis === 1 ? v.y : v.z);

const cache = new WeakMap<THREE.BufferGeometry, Map<string, AxisSurface>>();

function surfaceFor(mesh: THREE.Mesh, axis: Axis): AxisSurface {
  const material = mesh.material;
  const materials = Array.isArray(material) ? material : [material];
  const cullBack = materials.every((m) => m.side === THREE.FrontSide);
  const key = `${axis}:${cullBack ? 1 : 0}`;
  let byMesh = cache.get(mesh.geometry);
  if (!byMesh) cache.set(mesh.geometry, (byMesh = new Map()));
  let surface = byMesh.get(key);
  if (!surface) byMesh.set(key, (surface = new AxisSurface(mesh.geometry, axis, cullBack)));
  return surface;
}

/** Пересечение осевого луча с мешем: координата вдоль оси или undefined. */
function surfaceHit(mesh: THREE.Mesh, axis: Axis, u: number, v: number, fromPositive: boolean): number | undefined {
  return surfaceFor(mesh, axis).hit(u, v, fromPositive);
}

/** X-координата поверхности вдоль луча по X: луч идёт из +∞ (fromPositive) или −∞. */
export const projectX = (mesh: THREE.Mesh, y: number, z: number, fromPositive: boolean) =>
  surfaceHit(mesh, 0, y, z, fromPositive);

/** Y-координата поверхности вдоль вертикального луча (сверху вниз / снизу вверх). */
export const projectY = (mesh: THREE.Mesh, x: number, z: number, fromPositive: boolean) =>
  surfaceHit(mesh, 1, z, x, fromPositive);

/** Z-координата поверхности вдоль луча по Z: луч идёт из +∞ (fromPositive) или −∞. */
export const projectZ = (mesh: THREE.Mesh, x: number, y: number, fromPositive: boolean) =>
  surfaceHit(mesh, 2, x, y, fromPositive);
