import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { loft, CarConfig, CarModel } from './car';
import { makePlateTexture } from './textures';
import { VAN, vanShape, vanGreenhouse, vanBodyClassify } from './van-shape';

/** «Простор 7» — семиместный минивэн (оригинальный дизайн): однообъёмный кузов, сдвижная дверь, вертикальные фонари. */
export function buildVan(cfg: CarConfig, envIntensity = 1): CarModel {
  const { R, axF, axR, track } = VAN;
  const sh = vanShape();
  const root = new THREE.Group();
  root.name = 'car';
  const body = new THREE.Group();
  root.add(body);

  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(cfg.color), metalness: 0.45, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: envIntensity,
  });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.7 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0c1218, roughness: 0.03, metalness: 0.1, clearcoat: 1, envMapIntensity: 1.5 * envIntensity });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe6e8ec, metalness: 1, roughness: 0.14, envMapIntensity: envIntensity });
  const under = new THREE.MeshStandardMaterial({ color: 0x0e0e0f, roughness: 0.9 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f7ff, emissiveIntensity: 3.0, roughness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 2.0, roughness: 0.3 });
  const amber = new THREE.MeshStandardMaterial({ color: 0x5a3200, emissive: 0xff8a10, emissiveIntensity: 0.35, roughness: 0.3 });
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, cast = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    body.add(mesh);
    return mesh;
  };
  const tube = (pts: THREE.Vector3[], r: number, m: THREE.Material, cast = false) =>
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(8, pts.length * 6), r, 8, false), m, 0, 0, 0, cast);
  const onSurf = (x: number, y: number, end: 1 | -1, out = 0) => new THREE.Vector3(x, y, sh.surfaceZ(x, y, end) + end * out);

  // ——— кузов и «аквариум» ———
  const bm = new THREE.Mesh(loft(sh.body(120, 28), vanBodyClassify(sh), true, true), [paint, plastic]);
  bm.castShadow = bm.receiveShadow = true;
  body.add(bm);
  const gh = vanGreenhouse(sh);
  const ghm = new THREE.Mesh(loft(gh.rows, gh.classify, false, false), [paint, glass, plastic]);
  ghm.castShadow = true;
  body.add(ghm);
  add(new THREE.BoxGeometry(1.4, 0.5, 3.9), under, 0, 0.5, -0.05, false);
  // щётка пятой двери
  add(new THREE.BoxGeometry(0.42, 0.018, 0.012).rotateZ(0.5), plastic, 0.1, 1.16, gh.zC - 0.03, false);

  // ——— перед: стреловидные фары по форме носа, решётка, противотуманки ———
  for (const side of [-1, 1]) {
    const xs = [0.42, 0.55, 0.68, 0.78, 0.84].map((x) => side * x);
    const yL = (x: number) => 0.74 + (Math.abs(x) - 0.42) * 0.22;
    tube(xs.map((x) => onSurf(x, yL(x), 1, -0.014)), 0.05, glass);
    tube(xs.map((x) => onSurf(x, yL(x) + 0.025, 1, 0.024)), 0.009, headMat);
    tube(xs.slice(0, 3).map((x) => onSurf(x, yL(x) - 0.025, 1, 0.022)), 0.013, headMat);
    add(new RoundedBoxGeometry(0.12, 0.04, 0.03, 2, 0.01), amber, side * 0.8, yL(0.8) - 0.01, sh.surfaceZ(0.8, 0.8, 1) - 0.02, false);
    // противотуманки
    const fz = sh.surfaceZ(0.66, 0.4, 1);
    add(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 20).rotateX(Math.PI / 2), headMat, side * 0.66, 0.4, fz + 0.005, false);
    add(new THREE.TorusGeometry(0.05, 0.008, 6, 20), chrome, side * 0.66, 0.4, fz + 0.012, false);
  }
  tube([-0.4, -0.2, 0, 0.2, 0.4].map((x) => onSurf(x, 0.71, 1, 0.004)), 0.012, chrome);
  tube([-0.36, -0.18, 0, 0.18, 0.36].map((x) => onSurf(x, 0.66, 1, 0.004)), 0.006, chrome);

  // ——— зад: вертикальные фонари на стойках, номер, ручка ———
  for (const side of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 6; k++) {
      const y = 0.68 + k * 0.06;
      const x = side * (sh.xAt(-2.37, y) - 0.03);
      pts.push(onSurf(x, y, -1, 0.004));
    }
    tube(pts, 0.035, glass);
    tube(pts.map((p) => p.clone().add(new THREE.Vector3(0, 0, -0.03))), 0.017, tailMat);
    add(new RoundedBoxGeometry(0.06, 0.07, 0.03, 2, 0.01), amber, side * (sh.xAt(-2.37, 0.62) - 0.07), 0.62, sh.surfaceZ(0.7, 0.62, -1) - 0.02, false);
  }
  {
    const y = 0.8, z = sh.surfaceZ(0.27, y, -1) - 0.012;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112),
      new THREE.MeshStandardMaterial({ map: makePlateTexture(cfg.plate), roughness: 0.4, metalness: 0.2 }));
    plate.position.set(0, y, z);
    plate.rotation.y = Math.PI;
    body.add(plate);
    add(new RoundedBoxGeometry(0.34, 0.035, 0.03, 2, 0.012), chrome, 0, 0.93, sh.surfaceZ(0.17, 0.93, -1) - 0.015, false);
  }

  // ——— бока: двери, направляющая сдвижной двери, ручки, зеркала, рейлинги ———
  const gap = new THREE.MeshBasicMaterial({ color: 0x050505 });
  for (const side of [-1, 1]) {
    const doorLine = (z: number) => {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 8; k++) {
        const y = sh.bottom(z) + 0.09 + ((sh.top(z) - 0.03 - sh.bottom(z) - 0.09) * k) / 8;
        pts.push(new THREE.Vector3(side * (sh.xAt(z, y) + 0.0015), y, z));
      }
      tube(pts, 0.0045, gap);
    };
    for (const z of [1.12, 0.17, -0.94]) doorLine(z);
    const lower: THREE.Vector3[] = [];
    for (let k = 0; k <= 12; k++) {
      const z = 1.12 - (2.06 * k) / 12, y = sh.bottom(z) + 0.09;
      lower.push(new THREE.Vector3(side * (sh.xAt(z, y) + 0.0015), y, z));
    }
    tube(lower, 0.0045, gap);
    // направляющая сдвижной двери под задним окном
    const rail: THREE.Vector3[] = [];
    for (let k = 0; k <= 8; k++) {
      const z = -0.94 - (1.1 * k) / 8, y = 1.0;
      rail.push(new THREE.Vector3(side * (sh.xAt(z, y) + 0.004), y, z));
    }
    tube(rail, 0.012, plastic);
    for (const z of [0.3, -0.78]) {
      const y = 0.92;
      add(new THREE.CapsuleGeometry(0.012, 0.14, 4, 8).rotateX(Math.PI / 2), chrome, side * (sh.xAt(z, y) + 0.006), y, z, false);
    }
    // зеркало
    // зеркало на ножке у основания стойки
    const mz = 1.12, my = sh.top(mz) + 0.08, bx = sh.xAt(mz, sh.top(mz) - 0.04), mx = side * (bx + 0.12);
    add(new RoundedBoxGeometry(0.12, 0.035, 0.05, 2, 0.012), plastic, side * (bx + 0.05), my - 0.04, mz + 0.01, false);
    const hz = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), paint);
    hz.scale.set(0.1, 0.065, 0.06);
    hz.position.set(mx, my, mz);
    hz.castShadow = true;
    body.add(hz);
    const face = new THREE.Mesh(new THREE.CircleGeometry(1, 18), chrome);
    face.scale.set(0.075, 0.055, 1);
    face.position.set(mx, my, mz - 0.058);
    face.rotation.y = Math.PI;
    body.add(face);
    // рейлинг
    // рейлинг — только над плоской частью крыши, концы опущены к ней
    const x = side * 0.64, y = 1.82;
    tube([new THREE.Vector3(x, y - 0.045, 0.3), new THREE.Vector3(x, y, 0.18), new THREE.Vector3(x, y, -1.75), new THREE.Vector3(x, y - 0.045, -1.88)], 0.016, chrome, true);
    for (const z of [0.26, -0.75, -1.84]) add(new RoundedBoxGeometry(0.05, 0.07, 0.1, 2, 0.015), plastic, x, y - 0.045, z, false);
  }

  // ——— подкрылки ———
  for (const az of [axF, axR]) {
    for (const side of [-1, 1]) {
      const liner = new THREE.CylinderGeometry(0.39, 0.39, 0.26, 28, 1, true, 0, Math.PI).rotateZ(Math.PI / 2);
      const lm = add(liner, under, side * (track - 0.08), R, az, false);
      (lm.material as THREE.Material).side = THREE.DoubleSide;
    }
  }

  // ——— колёса: 5 спиц ———
  const wheels: CarModel['wheels'] = [];
  const W = 0.23, rimR = 0.24;
  const prof: THREE.Vector2[] = [];
  const s2 = 0.04;
  prof.push(new THREE.Vector2(rimR, -W / 2 + 0.01), new THREE.Vector2(R - 0.06, -W / 2));
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(R - s2 + Math.cos(a) * s2, -W / 2 + s2 + Math.sin(a) * s2)); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(R - s2 + Math.cos(a) * s2, W / 2 - s2 + Math.sin(a) * s2)); }
  prof.push(new THREE.Vector2(R - 0.06, W / 2), new THREE.Vector2(rimR, W / 2 - 0.01));
  const tire = new THREE.LatheGeometry(prof, 64).rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.88 });
  const alloy = new THREE.MeshStandardMaterial({ color: 0xc2c6cc, metalness: 0.9, roughness: 0.28, envMapIntensity: envIntensity });
  const barrel = new THREE.CylinderGeometry(rimR, rimR, W - 0.03, 36, 1, true).rotateZ(Math.PI / 2);
  const spoke = new THREE.BoxGeometry(0.03, rimR - 0.06, 0.05).translate(0, (rimR - 0.06) / 2 + 0.05, 0);
  const lip = new THREE.TorusGeometry(rimR - 0.006, 0.012, 8, 40).rotateY(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.06, 0.065, 0.04, 20).rotateZ(Math.PI / 2);
  const disc = new THREE.CylinderGeometry(0.17, 0.17, 0.024, 32).rotateZ(Math.PI / 2);
  const discMat = new THREE.MeshStandardMaterial({ color: 0x77797c, metalness: 0.9, roughness: 0.42 });
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
      const face = side * (W / 2 - 0.035);
      const l = new THREE.Mesh(lip, alloy); l.position.x = face; spin.add(l);
      const h = new THREE.Mesh(hub, alloy); h.position.x = face - side * 0.01; spin.add(h);
      for (let k = 0; k < 5; k++) {
        const sp = new THREE.Mesh(spoke, alloy);
        sp.rotation.x = (k / 5) * Math.PI * 2;
        sp.position.x = face - side * 0.012;
        sp.castShadow = true;
        spin.add(sp);
      }
      const d = new THREE.Mesh(disc, discMat); d.position.x = -side * 0.02; steer.add(d);
      root.add(steer);
      wheels.push({ spin, steer, front });
    }
  }

  // контактная тень
  {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.8)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.45)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 5.4),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, opacity: 0.72 }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.012;
    blob.renderOrder = 1;
    root.add(blob);
  }

  return {
    root, body, wheels, paint, tailMat, headMat, length: 4.8, width: 1.9, wheelR: R,
    setBrake(on: number) { tailMat.emissiveIntensity = 2.0 + on * 5; },
    setHeadlights(on: number) { headMat.emissiveIntensity = 3.0 + on * 3; },
  };
}
