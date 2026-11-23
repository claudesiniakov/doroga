import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Shape } from './traffic-models';
import { loft, spline, CarConfig, CarModel } from './car';
import { makePlateTexture } from './textures';
import { buildRoofRail } from './roof-rail';

/**
 * «Кедр 4×4» — компактный трёхдверный внедорожник (оригинальный дизайн, без марок и логотипов):
 * рубленый кузов, вертикальная пятая дверь, круглые фары, чёрные расширители арок, рейлинги, штампованные диски.
 */
export function buildKedr(cfg: CarConfig, envIntensity = 1): CarModel {
  const R = 0.36, axF = 1.12, axR = -1.08, track = 0.7;
  const sh = new Shape({
    halfLen: 1.875,
    top: [[-1.875, 0.95], [-1.86, 1.045], [-1.2, 1.058], [0, 1.055], [0.75, 1.045], [1.55, 1.02], [1.82, 0.995], [1.875, 0.9]],
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
  const roof = spline([[zC, sh.top(zC)], [-1.845, 1.56], [-1.79, 1.628], [0.2, 1.645], [0.36, 1.605], [zA, sh.top(zA)]]);
  const GR = 90, GK = 30;
  const angles = [0, 0.012, ...Array.from({ length: GK - 1 }, (_, k) => Math.PI * (k + 1) / GK), Math.PI - 0.012, Math.PI];
  const rows: THREE.Vector3[][] = [];
  for (let r = 0; r < GR; r++) {
    const t = r / (GR - 1);
    // ряды гуще у торцов — там излом пятой двери и лобового
    const z = zC + (zA - zC) * (t < 0.06 ? t * 0.3 : 0.018 + (t - 0.06) * (0.982 / 0.94));
    const yb = sh.top(z) - 0.01, H = Math.max(0, roof(z) - yb);
    const wb = sh.xAt(z, yb) - 0.025, wr = Math.min(wb, 0.765);
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
    if (s < 0.03) return 0;                                          // пояс под окнами
    if (z > 0.36) return s > 0.6 && s < 0.8 ? 0 : 1;                  // A-стойка
    if (z < -1.82) return s > 0.14 ? 1 : 0;                         // стекло пятой двери (на изломе)
    if (s > 0.86) return 0;                                          // крыша
    if (Math.abs(z + 0.32) < 0.06) return 2;                          // B-стойка
    if (Math.abs(z + 1.18) < 0.08) return 0;                          // C-стойка
    if (z < -1.7) return 0;                                          // D-стойка
    return 1;
  }, false, false);
  const ghm = new THREE.Mesh(gh, [paint, glass, plastic]);
  ghm.castShadow = true;
  body.add(ghm);

  add(new THREE.BoxGeometry(1.3, 0.5, 2.9), under, 0, 0.66, 0, false);

  // ——— перед: решётка, круглые фары в хромовых ободках, поворотники, бампер ———
  const zf = (x: number, y: number) => sh.surfaceZ(x, y, 1);
  add(new RoundedBoxGeometry(0.88, 0.2, 0.05, 2, 0.02), plastic, 0, 0.89, zf(0.44, 0.89) + 0.005);
  for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.82, 0.018, 0.02), chrome, 0, 0.83 + i * 0.06, zf(0.4, 0.89) + 0.035);
  for (const side of [-1, 1]) {
    const x = side * 0.6, y = 0.885, z = zf(0.6, y);
    const ring = new THREE.TorusGeometry(0.1, 0.016, 10, 32);
    add(ring, chrome, x, y, z + 0.012);
    const lens = new THREE.CylinderGeometry(0.096, 0.096, 0.03, 32).rotateX(Math.PI / 2);
    add(lens, glass, x, y, z + 0.0);
    add(new THREE.TorusGeometry(0.055, 0.011, 8, 28), headMat, x, y, z + 0.02, false);
    add(new THREE.CircleGeometry(0.022, 20), headMat, x, y, z + 0.022, false);
    add(new RoundedBoxGeometry(0.16, 0.05, 0.03, 2, 0.01), amber, x, 0.745, zf(0.6, 0.745) + 0.01, false);
  }
  const frontBumper = zf(0, 0.6) + 0.04;
  add(new RoundedBoxGeometry(1.74, 0.21, 0.24, 3, 0.06), plastic, 0, 0.6, frontBumper);
  add(new RoundedBoxGeometry(0.70, 0.075, 0.04, 2, 0.017), satin, 0, 0.55, frontBumper + 0.116);
  for (const side of [-1, 1]) {
    const fogX = side * 0.60, fogY = 0.605, fogZ = frontBumper + 0.119;
    add(new THREE.TorusGeometry(0.045, 0.008, 8, 20), satin, fogX, fogY, fogZ, false);
    add(new THREE.CircleGeometry(0.038, 24), glass, fogX, fogY, fogZ + 0.002, false);
    add(new THREE.CircleGeometry(0.025, 20), headMat, fogX, fogY, fogZ + 0.004, false);
    add(new THREE.CylinderGeometry(0.011, 0.011, 0.008, 6).rotateX(Math.PI / 2),
      plastic, side * 0.27, 0.55, frontBumper + 0.137, false);
  }
  add(new THREE.TorusGeometry(0.035, 0.01, 6, 16).rotateY(Math.PI / 2), chrome, 0.45, 0.52, zf(0.45, 0.52) + 0.14);

  // ——— зад: фонари по углам, номер на пятой двери, ручка, бампер ———
  const zr = (x: number, y: number) => sh.surfaceZ(x, y, -1);
  for (const side of [-1, 1]) {
    const y = 0.84;
    add(new RoundedBoxGeometry(0.46, 0.15, 0.05, 2, 0.02), glass, side * 0.57, y, zr(0.6, y) - 0.01);
    add(new RoundedBoxGeometry(0.22, 0.1, 0.03, 2, 0.01), tailMat, side * 0.67, y, zr(0.6, y) - 0.03, false);
    add(new RoundedBoxGeometry(0.12, 0.1, 0.03, 2, 0.01), amber, side * 0.49, y, zr(0.6, y) - 0.03, false);
  }
  {
    const y = 0.86, z = zr(0.27, y) - 0.01;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112),
      new THREE.MeshStandardMaterial({ map: makePlateTexture(cfg.plate), roughness: 0.4, metalness: 0.2 }));
    plate.position.set(0, y, z);
    plate.rotation.y = Math.PI;
    body.add(plate);
    add(new RoundedBoxGeometry(0.22, 0.03, 0.03, 2, 0.01), chrome, 0, 0.98, zr(0.11, 0.98) - 0.015, false);
  }
  const rearBumper = zr(0, 0.58) - 0.03;
  add(new RoundedBoxGeometry(1.72, 0.2, 0.22, 3, 0.06), plastic, 0, 0.58, rearBumper);
  add(new RoundedBoxGeometry(0.66, 0.065, 0.038, 2, 0.016), satin, 0, 0.53, rearBumper - 0.101);

  const ray = new THREE.Raycaster();
  const seamMaterial = new THREE.MeshStandardMaterial({ color: 0x232a22, roughness: 0.85 });
  // ——— рейлинги, антенна, зеркала, ручки ———
  for (const side of [-1, 1]) {
    body.add(buildRoofRail(ghm, side * 0.34, [
      [0.15, 0.027], [0.06, 0.055], [-0.12, 0.07],
      [-0.74, 0.07], [-1.36, 0.07], [-1.52, 0.055], [-1.62, 0.027],
    ], plastic, plastic));
    // зеркала на ножке
    const mz = 0.62, my = 1.2, mx = side * (sh.xAt(mz, 1.04) + 0.09);
    add(new RoundedBoxGeometry(0.06, 0.15, 0.2, 2, 0.02), plastic, mx, my, mz);
    add(new THREE.PlaneGeometry(0.16, 0.12).rotateY(Math.PI), chrome, mx, my, mz - 0.032, false);
    add(new THREE.BoxGeometry(0.1, 0.03, 0.04), plastic, side * (sh.xAt(mz, 1.04) + 0.03), 1.12, mz);
    // Шов двери и ручка повторяют боковину кузова.
    const doorPoint = (y: number, z: number, offset: number) => {
      ray.ray.set(new THREE.Vector3(side * 2, y, z), new THREE.Vector3(-side, 0, 0));
      const surface = ray.intersectObject(bm, false)[0]?.point;
      return new THREE.Vector3((surface?.x ?? side * sh.xAt(z, y)) + side * offset, y, z);
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
  ray.ray.set(new THREE.Vector3(aerialX, 2, aerialZ), new THREE.Vector3(0, -1, 0));
  const aerialBase = ray.intersectObject(bm, false)[0]?.point.y;
  if (aerialBase !== undefined) {
    add(new THREE.CylinderGeometry(0.025, 0.035, 0.027, 12), plastic, aerialX, aerialBase + 0.006, aerialZ);
    const mast = new THREE.CylinderGeometry(0.004, 0.007, 0.45, 8).translate(0, 0.225, 0).rotateX(-0.22);
    add(mast, plastic, aerialX, aerialBase + 0.016, aerialZ, false);
  }

  // ——— чёрные расширители арок и брызговики ———
  for (const az of [axF, axR]) {
    for (const side of [-1, 1]) {
      const x = side * (sh.halfW(az) + 0.0);
      const flare = new THREE.TorusGeometry(0.44, 0.05, 8, 28, Math.PI * 1.12).rotateZ(-Math.PI * 0.06);
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
