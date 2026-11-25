import * as THREE from 'three';
import { projectX, projectY, projectZ } from './surface-ray';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Shape } from './traffic-models';
import { loft, spline, CarConfig, CarModel } from './car';
import { makePlateTexture } from './textures';
import { buildRoofRail } from './roof-rail';

/**
 * «Кедр 4×4» — компактный трёхдверный внедорожник (оригинальный дизайн, без марок и логотипов):
 * рубленый кузов, вертикальная пятая дверь, круглые фары, прямые бамперы и штампованные диски.
 */
export function buildKedr(cfg: CarConfig, envIntensity = 1): CarModel {
  const R = 0.36, axF = 1.12, axR = -1.08, track = 0.7;
  const sh = new Shape({
    halfLen: 1.875,
    top: [[-1.875, 0.95], [-1.86, 1.045], [-1.2, 1.058], [0, 1.055], [0.75, 1.055], [1.55, 1.045], [1.82, 1.025], [1.875, 0.97]],
    bottom: [[-1.875, 0.52], [-1.78, 0.45], [-1.4, 0.43], [1.4, 0.43], [1.78, 0.46], [1.875, 0.52]],
    width: [[-1.875, 0.8], [-1.6, 0.83], [0, 0.835], [1.6, 0.83], [1.875, 0.79]],
    planFront: 14, planRear: 18, axles: [axF, axR], wheelR: R, archR: 0.42, archBlend: 0.055,
    seLow: 10, seHigh: 6, tumble: 0.035,
  });

  const root = new THREE.Group();
  root.name = 'car';
  const body = new THREE.Group();
  root.add(body);

  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(cfg.color), metalness: 0.12, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.12, envMapIntensity: envIntensity,
  });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x151617, roughness: 0.78, metalness: 0 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0d141b, roughness: 0.03, metalness: 0.1, clearcoat: 1, envMapIntensity: 1.5 * envIntensity });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe6e8ec, metalness: 1, roughness: 0.14, envMapIntensity: envIntensity });
  const satin = new THREE.MeshStandardMaterial({ color: 0x9ba4a8, metalness: 0.65, roughness: 0.36, envMapIntensity: envIntensity });
  const under = new THREE.MeshStandardMaterial({ color: 0x0e0e0f, roughness: 0.9 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e2, emissiveIntensity: 3.0, roughness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 2.0, roughness: 0.3 });
  const amber = new THREE.MeshStandardMaterial({ color: 0x5a3200, emissive: 0xff8a10, emissiveIntensity: 0.35, roughness: 0.3 });
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, cast = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    body.add(mesh);
    return mesh;
  };

  // Кузов окрашен сплошь, накладные бамперы и расширители сделаны отдельными деталями.
  const bm = new THREE.Mesh(loft(sh.body(110, 26), () => 0, true, true), paint);
  bm.castShadow = bm.receiveShadow = true;
  body.add(bm);

  // ——— «аквариум»: раскосое лобовое, плоская крыша, вертикальная пятая дверь ———
  const zA = 0.72, zC = -1.865;
  const roof = spline([[zC, sh.top(zC)], [-1.845, 1.53], [-1.64, 1.655], [-0.8, 1.685], [0.14, 1.677], [0.34, 1.6], [zA, sh.top(zA)]]);
  const GR = 90, GK = 30;
  const angles = [0, 0.001, ...Array.from({ length: GK - 1 }, (_, k) => Math.PI * (k + 1) / GK), Math.PI - 0.001, Math.PI];
  const rows: THREE.Vector3[][] = [];
  for (let r = 0; r < GR; r++) {
    const t = r / (GR - 1);
    // ряды гуще у торцов — там излом пятой двери и лобового
    const z = zC + (zA - zC) * (t < 0.06 ? t * 0.3 : 0.018 + (t - 0.06) * (0.982 / 0.94));
    // Широкая кабина начинается на плечах кузова, ниже его центрального гребня.
    const yb = sh.top(z) - 0.064, H = Math.max(0, roof(z) - yb);
    const wb = sh.xAt(z, yb) - 0.024;
    const wr = Math.min(wb * 0.94, 0.69);
    const ring: THREE.Vector3[] = [];
    for (const angle of angles) {
      const phi = Math.PI - angle;
      const s = Math.sin(phi), c = Math.cos(phi);
      const a = wb + (wr - wb) * Math.min(1, s * 1.05);
      ring.push(new THREE.Vector3(Math.sign(c) * a * Math.pow(Math.abs(c), 2 / 7), yb + H * Math.pow(s, 2 / 7), z));
    }
    rows.push(ring);
  }
  const gh = loft(rows, (p, _r, c) => {
    const s = (Math.sin(angles[c]) + Math.sin(angles[c + 1])) / 2, z = p.z;
    if (s < 0.001) return 0;                                        // стык окон с кузовом
    if (z > 0.39) return s > 0.61 && p.y < 1.55 ? 1 : 0;             // лобовое и окрашенная рамка
    if (z < -1.70) return s > 0.57 && p.y < 1.57 ? 1 : 0;            // стекло пятой двери и окрашенная рамка
    if (s > 0.72) return 0;                                         // крыша и её закруглённые края
    if (Math.abs(z + 0.57) < 0.061) return 0;                         // широкая стойка за дверью
    if (z < -1.58) return 0;                                        // задняя стойка
    return 1;
  }, false, false);
  const ghm = new THREE.Mesh(gh, [paint, glass, plastic]);
  ghm.castShadow = true;
  body.add(ghm);

  add(new THREE.BoxGeometry(1.3, 0.5, 2.9), under, 0, 0.66, 0, false);

  const endDetail = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number,
    end: 1 | -1, lift: number) => {
    if (end < 0) geometry.rotateY(Math.PI);
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const px = x + positions.getX(i), py = y + positions.getY(i);
      const z = projectZ(bm, px, py, end > 0) ?? sh.surfaceZ(px, py, end);
      positions.setXYZ(i, px, py, z + end * lift);
    }
    geometry.computeVertexNormals();
    add(geometry, material, 0, 0, 0, false);
  };
  const endStrip = (w: number, h: number, material: THREE.Material, x: number, y: number, end: 1 | -1, lift: number) =>
    endDetail(new THREE.PlaneGeometry(w, h, Math.ceil(w / 0.024), Math.ceil(h / 0.024)), material, x, y, end, lift);

  // Единая тёмная решётка с круглыми фарами и верхними указателями поворота.
  endStrip(1.48, 0.245, plastic, 0, 0.819, 1, 0.013);
  for (const y of [0.748, 0.784, 0.820, 0.856, 0.892]) {
    endStrip(0.82, 0.009, satin, 0, y, 1, 0.021);
  }
  for (const side of [-1, 1]) {
    const x = side * 0.578, y = 0.817;
    endDetail(new THREE.RingGeometry(0.089, 0.106, 38, 3), chrome, x, y, 1, 0.024);
    endDetail(new THREE.CircleGeometry(0.089, 40), glass, x, y, 1, 0.027);
    endDetail(new THREE.CircleGeometry(0.075, 40), headMat, x, y, 1, 0.030);
    for (const offset of [-0.035, 0, 0.035]) {
      endStrip(0.006, 0.112, satin, x + offset, y, 1, 0.034);
    }
    endStrip(0.265, 0.057, plastic, side * 0.60, 0.976, 1, 0.012);
    endStrip(0.18, 0.042, amber, side * 0.647, 0.976, 1, 0.023);
    endStrip(0.07, 0.042, satin, side * 0.518, 0.976, 1, 0.023);
  }

  // Прямые металлические бамперы с чёрными торцами.
  for (const end of [-1, 1] as const) {
    const y = end > 0 ? 0.594 : 0.565;
    const z = sh.surfaceZ(0, y, end) + end * 0.039;
    add(new RoundedBoxGeometry(1.61, 0.105, 0.17, 3, 0.022), satin, 0, y, z);
    add(new RoundedBoxGeometry(1.43, 0.036, 0.034, 2, 0.01), plastic, 0, y + 0.003, z + end * 0.078);
    for (const side of [-1, 1]) {
      add(new RoundedBoxGeometry(0.14, 0.113, 0.185, 3, 0.028), plastic, side * 0.77, y, z);
    }
  }

  // Вертикальные трёхсекционные фонари по краям пятой двери.
  for (const side of [-1, 1]) {
    const x = side * 0.635;
    endStrip(0.165, 0.285, plastic, x, 0.823, -1, 0.012);
    endStrip(0.133, 0.10, tailMat, x, 0.896, -1, 0.022);
    endStrip(0.133, 0.061, amber, x, 0.802, -1, 0.022);
    endStrip(0.133, 0.061, satin, x, 0.731, -1, 0.022);
  }
  const plate = new THREE.MeshStandardMaterial({ map: makePlateTexture(cfg.plate), roughness: 0.4 });
  endStrip(0.46, 0.10, plate, 0, 0.803, -1, 0.014);
  endStrip(0.24, 0.029, plastic, 0, 0.925, -1, 0.017);

  const seamMaterial = new THREE.MeshStandardMaterial({ color: 0x232a22, roughness: 0.85 });
  // ——— рейлинги, антенна, зеркала, ручки ———
  for (const side of [-1, 1]) {
    body.add(buildRoofRail(ghm, side * 0.34, [
      [0.15, 0.027], [0.06, 0.055], [-0.12, 0.07],
      [-0.68, 0.07], [-1.24, 0.07], [-1.39, 0.055], [-1.50, 0.027],
    ], plastic, plastic));
    // Ножка зеркала ставится в основание расширенной передней стойки.
    const mz = 0.55, my = 1.115;
    const mount = projectX(ghm, my, mz, side > 0) ?? side * sh.xAt(mz, sh.top(mz) - 0.064);
    const mx = mount + side * 0.115;
    add(new RoundedBoxGeometry(0.15, 0.033, 0.042, 2, 0.012), plastic, mount + side * 0.055, my, mz);
    add(new RoundedBoxGeometry(0.15, 0.103, 0.055, 2, 0.018), plastic, mx, my + 0.047, mz);
    add(new THREE.PlaneGeometry(0.116, 0.075).rotateY(Math.PI), chrome, mx, my + 0.047, mz - 0.029, false);
    // Шов двери и ручка повторяют боковину кузова.
    const doorPoint = (y: number, z: number, offset: number) => {
      const surface = projectX(bm, y, z, side > 0);
      return new THREE.Vector3((surface ?? side * sh.xAt(z, y)) + side * offset, y, z);
    };
    const seam: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) seam.push(doorPoint(1.035 - 0.485 * i / 10, 0.64, 0.004));
    for (let i = 1; i <= 18; i++) seam.push(doorPoint(0.55, 0.64 - 1.22 * i / 18, 0.004));
    for (let i = 1; i <= 10; i++) seam.push(doorPoint(0.55 + 0.485 * i / 10, -0.58, 0.004));
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seam), 72, 0.004, 6, false), seamMaterial, 0, 0, 0, false);
    const trim = Array.from({ length: 13 }, (_, i) => doorPoint(0.68, 0.50 - i * 0.077, 0.008));
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trim), 32, 0.012, 8, false), plastic, 0, 0, 0, false);
    const accent = trim.map((point) => new THREE.Vector3(point.x + side * 0.010, point.y + 0.003, point.z));
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(accent), 32, 0.003, 6, false), satin, 0, 0, 0, false);
    const handle = doorPoint(0.97, -0.44, 0.009);
    add(new RoundedBoxGeometry(0.03, 0.035, 0.15, 2, 0.01), plastic, handle.x, handle.y, handle.z, false);
  }
  const aerialX = 0.62, aerialZ = 0.89;
  const aerialBase = projectY(bm, aerialX, aerialZ, true);
  if (aerialBase !== undefined) {
    add(new THREE.CylinderGeometry(0.025, 0.035, 0.027, 12), plastic, aerialX, aerialBase + 0.006, aerialZ);
    const mast = new THREE.CylinderGeometry(0.004, 0.007, 0.45, 8).translate(0, 0.225, 0).rotateX(-0.22);
    add(mast, plastic, aerialX, aerialBase + 0.016, aerialZ, false);
  }

  // ——— чёрные расширители арок и брызговики ———
  for (const az of [axF, axR]) {
    for (const side of [-1, 1]) {
      const x = side * (sh.halfW(az) + 0.0);
      const flare = new THREE.TorusGeometry(0.435, 0.025, 8, 28, Math.PI * 1.04).rotateZ(-Math.PI * 0.02);
      flare.scale(1, 1, 0.55);
      flare.rotateY(Math.PI / 2);
      add(flare, plastic, x, R, az);
      const liner = new THREE.CylinderGeometry(0.42, 0.42, 0.26, 28, 1, true, 0, Math.PI);
      liner.rotateZ(Math.PI / 2);
      const lm = add(liner, under, side * (track - 0.08), R, az, false);
      (lm.material as THREE.Material).side = THREE.DoubleSide;
      add(new THREE.BoxGeometry(0.22, 0.24, 0.02), plastic, side * track, 0.33, az - 0.47, false);
    }
  }

  // ——— колёса: шины с грубым протектором, штампованные диски ———
  const wheels: CarModel['wheels'] = [];
  const W = 0.205, rimR = 0.205;
  const prof: THREE.Vector2[] = [];
  const sh2 = 0.05;
  prof.push(new THREE.Vector2(rimR, -W / 2 + 0.01), new THREE.Vector2(R - 0.08, -W / 2));
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(R - sh2 + Math.cos(a) * sh2, -W / 2 + sh2 + Math.sin(a) * sh2)); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(R - sh2 + Math.cos(a) * sh2, W / 2 - sh2 + Math.sin(a) * sh2)); }
  prof.push(new THREE.Vector2(R - 0.08, W / 2), new THREE.Vector2(rimR, W / 2 - 0.01));
  const tire = new THREE.LatheGeometry(prof, 128);
  {
    // грунтозацепы: шашки протектора по беговой дорожке
    const p = tire.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = Math.hypot(x, z);
      if (r < R - 0.03) continue;
      const a = Math.atan2(z, x);
      const lug = (Math.sin(a * 32 + (y > 0 ? 0.9 : 0)) > 0 ? 1 : 0) * (Math.abs(y) > 0.015 ? 1 : 0.4);
      const k = (r - 0.012 + lug * 0.012) / r;
      p.setX(i, x * k); p.setZ(i, z * k);
    }
    tire.computeVertexNormals();
  }
  tire.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xa3a7ac, metalness: 0.55, roughness: 0.38, envMapIntensity: envIntensity });
  const disc = new THREE.CylinderGeometry(rimR - 0.01, rimR - 0.01, 0.02, 40).rotateZ(Math.PI / 2);
  const barrel = new THREE.CylinderGeometry(rimR, rimR, W - 0.03, 40, 1, true).rotateZ(Math.PI / 2);
  const hole = new THREE.CircleGeometry(1, 16).rotateY(Math.PI / 2);
  const cap = new THREE.SphereGeometry(0.06, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.PI / 2);
  const nut = new THREE.CylinderGeometry(0.011, 0.011, 0.02, 6).rotateZ(Math.PI / 2);
  for (const front of [true, false]) {
    for (const side of [-1, 1]) {
      const steer = new THREE.Group();
      steer.position.set(side * track, R, front ? axF : axR);
      const spin = new THREE.Group();
      steer.add(spin);
      const t = new THREE.Mesh(tire, tireMat);
      t.castShadow = true;
      spin.add(t);
      const b = new THREE.Mesh(barrel, under);
      (b.material as THREE.Material).side = THREE.DoubleSide;
      spin.add(b);
      const face = side * (W / 2 - 0.045);
      const d = new THREE.Mesh(disc, steel);
      d.position.x = face;
      spin.add(d);
      // овальные вырезы и гайки
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const h = new THREE.Mesh(hole, under);
        h.scale.set(1, 0.03, 0.05);
        h.position.set(face + side * 0.011, Math.cos(a) * 0.14, Math.sin(a) * 0.14);
        h.rotation.x = -a;
        if (side < 0) h.rotation.y = Math.PI;
        spin.add(h);
      }
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        const n = new THREE.Mesh(nut, chrome);
        n.position.set(face + side * 0.014, Math.cos(a) * 0.075, Math.sin(a) * 0.075);
        spin.add(n);
      }
      const c = new THREE.Mesh(cap, chrome);
      c.position.x = face + side * 0.01;
      if (side < 0) c.rotation.y = Math.PI;
      spin.add(c);
      root.add(steer);
      wheels.push({ spin, steer, front });
    }
  }

  // мягкая контактная тень
  {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.8)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.45)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 4.3),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, opacity: 0.7 }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.012;
    blob.renderOrder = 1;
    root.add(blob);
  }

  return {
    root, body, wheels, paint, tailMat, headMat, length: 3.75, width: 1.76, wheelR: R,
    setBrake(on: number) { tailMat.emissiveIntensity = 2.0 + on * 5; },
    setHeadlights(on: number) { headMat.emissiveIntensity = 3.0 + on * 3; },
  };
}
