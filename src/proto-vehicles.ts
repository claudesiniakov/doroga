import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { axleGeometry, Builder, type MatKey, type TrafficAssets, type TrafficTemplate } from './traffic-models';

/** Спортбайк с мотоциклистом. Колёса — отдельные «оси» по центру (наклоняются вместе с кузовом). */
function buildMoto(): TrafficTemplate<'moto'> {
  const b = new Builder();
  const R = 0.31, zF = 0.72, zR = -0.7;
  const between = (a: THREE.Vector3, c: THREE.Vector3, r: number, key: MatKey) => {
    const len = a.distanceTo(c);
    const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 2 + r * 0.6), 4, 10);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize());
    g.applyQuaternion(q);
    const m = a.clone().add(c).multiplyScalar(0.5);
    return b.add(g, key, m);
  };
  const blob = (r: number, s: [number, number, number], pos: THREE.Vector3Like, key: MatKey, rx = 0) =>
    b.add(new THREE.SphereGeometry(r, 18, 12), key, pos, new THREE.Euler(rx, 0, 0), { x: s[0], y: s[1], z: s[2] });
  // мотоцикл
  b.box(0.3, 0.36, 0.5, 'grey', { x: 0, y: 0.47, z: -0.02 }, 0.05);                 // двигатель
  for (let k = 0; k < 4; k++) b.box(0.34, 0.015, 0.2, 'grey', { x: 0, y: 0.58 + k * 0.035, z: 0.12 }, 0);
  b.box(0.26, 0.16, 0.56, 'black', { x: 0, y: 0.34, z: 0.06 }, 0.06);                // брюхо
  blob(1, [0.2, 0.15, 0.32], { x: 0, y: 0.88, z: 0.1 }, 'paint');                    // бак
  blob(1, [0.19, 0.2, 0.3], { x: 0, y: 0.84, z: 0.47 }, 'paint', 0.35);             // обтекатель
  b.add(new THREE.PlaneGeometry(0.3, 0.26), 'glass', { x: 0, y: 1.1, z: 0.6 }, new THREE.Euler(-0.75, 0, 0));
  b.box(0.25, 0.08, 0.5, 'black', { x: 0, y: 0.87, z: -0.28 }, 0.035);               // седло
  blob(1, [0.13, 0.09, 0.34], { x: 0, y: 0.9, z: -0.6 }, 'paint', -0.18);           // хвост
  for (const side of [-1, 1]) {
    b.box(0.04, 0.06, 0.62, 'grey', { x: side * 0.1, y: 0.36, z: -0.38 }, 0, new THREE.Euler(0.08, 0, 0)); // маятник
    between(new THREE.Vector3(side * 0.085, R, zF), new THREE.Vector3(side * 0.085, 1.0, 0.5), 0.024, 'chrome'); // вилка
    b.box(0.06, 0.03, 0.06, 'black', { x: side * 0.29, y: 1.04, z: 0.4 }, 0.01);     // ручки
    b.box(0.03, 0.12, 0.03, 'black', { x: side * 0.22, y: 1.12, z: 0.47 });          // кронштейн зеркала
    b.box(0.1, 0.05, 0.02, 'chrome', { x: side * 0.25, y: 1.18, z: 0.47 }, 0.01);
  }
  const bar = new THREE.CylinderGeometry(0.015, 0.015, 0.58, 8).rotateZ(Math.PI / 2);
  b.add(bar, 'black', { x: 0, y: 1.03, z: 0.42 });
  const pipe = new THREE.CylinderGeometry(0.05, 0.06, 0.5, 14).rotateX(Math.PI / 2 - 0.25);
  b.add(pipe, 'chrome', { x: 0.15, y: 0.5, z: -0.55 });
  b.box(0.16, 0.05, 0.3, 'black', { x: 0, y: R + 0.27, z: zF + 0.02 }, 0.02, new THREE.Euler(0.15, 0, 0)); // крыло
  b.box(0.16, 0.07, 0.04, 'head', { x: 0, y: 0.84, z: 0.79 }, 0.02);                  // фара
  b.box(0.17, 0.12, 0.01, 'plate', { x: 0, y: 0.68, z: -0.86 }, 0, new THREE.Euler(0.3, Math.PI, 0));
  // мотоциклист: наклонён к рулю
  const hip = new THREE.Vector3(0, 0.98, -0.24), sh = new THREE.Vector3(0, 1.32, 0.08);
  between(hip, sh, 0.15, 'black');                                                    // куртка
  b.add(new THREE.SphereGeometry(0.125, 18, 12), 'paint2', { x: 0, y: 1.46, z: 0.19 }, undefined, { x: 1, y: 1, z: 1.12 });  // шлем
  b.add(new THREE.SphereGeometry(0.128, 16, 10, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.35, Math.PI * 0.25), 'glass', { x: 0, y: 1.46, z: 0.205 }, undefined, { x: 1, y: 1, z: 1.12 });
  for (const side of [-1, 1]) {
    const s = new THREE.Vector3(side * 0.17, 1.3, 0.06), el = new THREE.Vector3(side * 0.24, 1.12, 0.24), gr = new THREE.Vector3(side * 0.29, 1.04, 0.4);
    between(s, el, 0.055, 'black');
    between(el, gr, 0.048, 'black');
    const hp = new THREE.Vector3(side * 0.12, 0.95, -0.22), kn = new THREE.Vector3(side * 0.21, 0.83, 0.13), ft = new THREE.Vector3(side * 0.19, 0.5, -0.04);
    between(hp, kn, 0.075, 'grey');
    between(kn, ft, 0.06, 'grey');
    b.box(0.09, 0.08, 0.2, 'black', { x: side * 0.19, y: 0.47, z: 0.0 }, 0.02);         // ботинок
  }
  // колёса: шина + диск + тормозной диск, по центру
  const wheel = (z: number) => {
    const rub = new Builder(), rim = new Builder();
    const W = 0.13, rimR = 0.22;
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI;
      prof.push(new THREE.Vector2(rimR + (R - rimR) * (0.55 + 0.45 * Math.cos(a)), (W / 2) * Math.sin(a)));
    }
    const tire = new THREE.LatheGeometry(prof, 32).rotateZ(Math.PI / 2);
    rub.add(tire, 'rubber');
    rim.add(new THREE.CylinderGeometry(rimR, rimR, 0.05, 24).rotateZ(Math.PI / 2), 'rim');
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      rub.add(new THREE.BoxGeometry(0.06, rimR * 0.5, rimR * 0.18), 'rubber', { x: 0, y: Math.cos(a) * rimR * 0.55, z: Math.sin(a) * rimR * 0.55 }, new THREE.Euler(a, 0, 0));
    }
    rim.add(new THREE.CylinderGeometry(0.15, 0.15, 0.012, 24).rotateZ(Math.PI / 2), 'rim', { x: 0.045, y: 0, z: 0 });
    return { z, y: R, rubber: rub.build().get('rubber')!, rim: rim.build().get('rim')! };
  };
  const tail = new Builder(), bl = new Builder(), br = new Builder();
  tail.box(0.12, 0.05, 0.03, 'head', { x: 0, y: 0.92, z: -0.93 }, 0.012);
  bl.box(0.05, 0.035, 0.035, 'head', { x: 0.12, y: 0.82, z: -0.86 }, 0.01);
  br.box(0.05, 0.035, 0.035, 'head', { x: -0.12, y: 0.82, z: -0.86 }, 0.01);
  return {
    kind: 'moto', length: 2.15, width: 0.85, parts: b.build(), wheelR: R, axles: [wheel(zF), wheel(zR)],
    tail: tail.build().get('head')!, blinkL: bl.build().get('head')!, blinkR: br.build().get('head')!,
  };
}

/**
 * Мотоблок с повозкой: мотоблок впереди (две колёсные «грунтозацепы», мотор, длинные ручки),
 * за ним — дощатая тележка на одной оси, на передке сидит водитель и держит ручки.
 */
function buildTiller(): TrafficTemplate<'tiller'> {
  const b = new Builder();
  const between = (a: THREE.Vector3, c: THREE.Vector3, r: number, key: MatKey) => {
    const len = a.distanceTo(c);
    const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 2 + r * 0.6), 4, 10);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize()));
    return b.add(g, key, a.clone().add(c).multiplyScalar(0.5));
  };
  const RT = 0.3, zT = 1.42;          // ось мотоблока
  const RC = 0.27, zC = -0.55;        // ось тележки
  // ——— мотоблок ———
  b.box(0.3, 0.2, 0.34, 'grey', { x: 0, y: RT + 0.02, z: zT }, 0.04);                       // редуктор
  b.box(0.12, 0.34, 0.14, 'grey', { x: 0, y: RT + 0.26, z: zT - 0.1 }, 0.03);               // колонна
  b.box(0.36, 0.26, 0.4, 'paint', { x: 0, y: 0.78, z: zT - 0.02 }, 0.05);                   // кожух двигателя
  b.box(0.3, 0.12, 0.26, 'paint', { x: 0.02, y: 0.97, z: zT + 0.04 }, 0.05);               // бак
  b.add(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 12), 'black', { x: 0.02, y: 1.05, z: zT + 0.04 }); // пробка
  b.add(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 16).rotateZ(Math.PI / 2), 'black', { x: -0.24, y: 0.82, z: zT + 0.02 }); // воздушный фильтр
  b.add(new THREE.CylinderGeometry(0.04, 0.045, 0.22, 12).rotateX(Math.PI / 2), 'chrome', { x: 0.2, y: 0.74, z: zT + 0.2 }); // глушитель
  for (let k = 0; k < 4; k++) b.box(0.38, 0.012, 0.03, 'black', { x: 0, y: 0.7 + k * 0.045, z: zT + 0.19 }); // решётка
  b.box(0.12, 0.07, 0.05, 'head', { x: 0, y: 0.62, z: zT + 0.23 }, 0.02);                  // фара
  b.box(0.7, 0.04, 0.24, 'black', { x: 0, y: RT * 2 + 0.06, z: zT }, 0.015);               // крылья над колёсами
  b.box(0.1, 0.06, 0.22, 'black', { x: 0, y: 0.26, z: zT - 0.32 }, 0.02);                  // сцепка
  b.box(0.08, 0.05, 0.5, 'grey', { x: 0, y: 0.28, z: zT - 0.62 }, 0.02);                   // дышло к тележке
  // Положение рукояток задаёт и точки хвата водителя.
  const grip = new THREE.Vector3(0.31, 1.30, zT - 0.83);
  for (const side of [-1, 1]) {
    const a = new THREE.Vector3(side * 0.12, 0.92, zT - 0.15);
    const m = new THREE.Vector3(side * 0.23, 1.20, zT - 0.54);
    const inner = new THREE.Vector3(side * (grip.x - 0.055), grip.y, grip.z + 0.02);
    const outer = new THREE.Vector3(side * (grip.x + 0.055), grip.y, grip.z - 0.02);
    between(a, m, 0.018, 'grey');
    between(m, inner, 0.018, 'grey');
    between(inner, outer, 0.024, 'black');
  }
  // ——— тележка: дощатый кузов на раме ———
  const bedF = 0.62, bedB = -1.25, bedW = 1.24, floorY = 0.58, sideH = 0.34;
  const bedL = bedF - bedB, bedZ = (bedF + bedB) / 2;
  b.box(0.08, 0.08, bedL + 0.1, 'grey', { x: 0.42, y: floorY - 0.08, z: bedZ });             // лонжероны
  b.box(0.08, 0.08, bedL + 0.1, 'grey', { x: -0.42, y: floorY - 0.08, z: bedZ });
  b.box(bedW, 0.04, bedL, 'wood', { x: 0, y: floorY, z: bedZ });                            // пол
  const planks = 3, ph = sideH / planks;
  for (let k = 0; k < planks; k++) {
    const y = floorY + 0.02 + ph * (k + 0.5);
    for (const side of [-1, 1]) b.box(0.035, ph - 0.012, bedL, 'wood', { x: side * (bedW / 2 - 0.018), y, z: bedZ });
    b.box(bedW, ph - 0.012, 0.035, 'wood', { x: 0, y, z: bedB + 0.018 });                    // задний борт
    b.box(bedW, ph - 0.012, 0.035, 'wood', { x: 0, y, z: bedF - 0.018 });                    // передний борт
  }
  for (const z of [bedF - 0.02, bedZ, bedB + 0.02]) for (const side of [-1, 1])
    b.box(0.05, sideH + 0.04, 0.05, 'grey', { x: side * (bedW / 2 + 0.005), y: floorY + sideH / 2 + 0.02, z });   // стойки
  // груз: мешки с картошкой и бидон
  for (const [x, z, r] of [[0.25, -0.3, 0.2], [-0.2, -0.45, 0.22], [0.05, -0.85, 0.21], [-0.3, -0.95, 0.19]] as const)
    b.add(new THREE.SphereGeometry(1, 14, 10), 'paint2', { x, y: floorY + 0.17, z }, new THREE.Euler(0, x * 3, 0.2), { x: r * 1.15, y: 0.17, z: r * 1.4 });
  b.add(new THREE.CylinderGeometry(0.13, 0.15, 0.42, 18), 'chrome', { x: 0.35, y: floorY + 0.23, z: 0.15 });
  b.add(new THREE.CylinderGeometry(0.07, 0.11, 0.1, 18), 'chrome', { x: 0.35, y: floorY + 0.49, z: 0.15 });
  // сиденье-доска на переднем борту и водитель
  b.box(0.7, 0.05, 0.3, 'wood', { x: 0, y: floorY + sideH + 0.04, z: bedF - 0.2 });
  const hip = new THREE.Vector3(0, floorY + sideH + 0.17, bedF - 0.22), sh = new THREE.Vector3(0, hip.y + 0.5, bedF - 0.12);
  between(hip, sh, 0.17, 'paint2');                                                         // ватник
  b.add(new THREE.SphereGeometry(0.11, 16, 12), 'wood', { x: 0, y: sh.y + 0.2, z: sh.z + 0.02 }, undefined, { x: 1, y: 1.08, z: 1 }); // голова
  b.add(new THREE.SphereGeometry(0.125, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), 'black', { x: 0, y: sh.y + 0.24, z: sh.z + 0.01 }); // кепка
  b.box(0.2, 0.025, 0.12, 'black', { x: 0, y: sh.y + 0.25, z: sh.z + 0.14 });             // козырёк
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(side * 0.16, sh.y - 0.04, sh.z);
    const elbow = new THREE.Vector3(side * 0.29, grip.y - 0.04, sh.z - 0.10);
    const hand = new THREE.Vector3(side * grip.x, grip.y, grip.z);
    between(shoulder, elbow, 0.055, 'paint2');
    between(elbow, hand, 0.045, 'paint2');
    b.add(new THREE.SphereGeometry(0.047, 12, 8), 'wood', hand);
    const hp = new THREE.Vector3(side * 0.12, hip.y, hip.z), kn = new THREE.Vector3(side * 0.17, hip.y + 0.04, hip.z + 0.42);
    between(hp, kn, 0.075, 'black');
    between(kn, new THREE.Vector3(side * 0.17, floorY + 0.12, bedF + 0.35), 0.065, 'black'); // ноги на дышле
    b.box(0.1, 0.08, 0.22, 'black', { x: side * 0.17, y: floorY + 0.06, z: bedF + 0.4 }, 0.02);
  }
  // колёса: мотоблок — «грунтозацепы» (ёлочка), тележка — обычные
  const tiller = axleGeometry(RT, 0.16, 0.17, 0.36, false);
  const lugs = new Builder();
  for (const side of [-1, 1]) for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    for (const h of [-1, 1])
      lugs.add(new THREE.BoxGeometry(0.075, 0.04, 0.05), 'rubber', { x: side * 0.36 + h * 0.04, y: Math.cos(a) * (RT + 0.01), z: Math.sin(a) * (RT + 0.01) }, new THREE.Euler(a, h * 0.5, 0));
  }
  const tillerRubber = mergeGeometries([tiller.rubber, lugs.build().get('rubber')!], false)!;
  const cart = axleGeometry(RC, 0.15, 0.13, 0.5, false);   // колёса под кузовом
  const tail = new Builder(), bl = new Builder(), br = new Builder();
  for (const side of [-1, 1]) tail.box(0.1, 0.06, 0.02, 'head', { x: side * 0.5, y: floorY + 0.14, z: bedB - 0.01 }, 0.01); // катафоты
  b.add(new THREE.CircleGeometry(0.16, 3).rotateY(Math.PI), 'chevron', { x: 0, y: floorY + 0.2, z: bedB - 0.02 });         // «тихоходный» знак
  bl.box(0.04, 0.03, 0.02, 'head', { x: 0.6, y: floorY + 0.3, z: bedB - 0.01 }, 0.008);
  br.box(0.04, 0.03, 0.02, 'head', { x: -0.6, y: floorY + 0.3, z: bedB - 0.01 }, 0.008);
  return {
    kind: 'tiller', length: zT + RT + 0.25 - bedB, width: 1.3, parts: b.build(), wheelR: 0.28,
    axles: [{ z: zT, y: RT, rubber: tillerRubber, rim: tiller.rim }, { z: zC, y: RC, rubber: cart.rubber, rim: cart.rim }],
    tail: tail.build().get('head')!, blinkL: bl.build().get('head')!, blinkR: br.build().get('head')!,
  };
}

const MOTO_COLORS: [string, number][] = [['#c4101a', 3], ['#1f4f9c', 2], ['#111214', 3], ['#f2f2f0', 2], ['#f5c518', 1], ['#2e8b3e', 1], ['#e06a12', 1]];
const TILLER_COLORS: [string, number][] = [['#c4251c', 3], ['#e06a12', 2], ['#2e7d3a', 1], ['#1f4f9c', 1]];

export function createMotoPreview(assets: TrafficAssets) {
  return assets.createPrototype(buildMoto(), MOTO_COLORS, { wheelsOnBody: true });
}

export function createTillerPreview(assets: TrafficAssets) {
  const cloth = new THREE.MeshStandardMaterial({ color: 0x5d5a4a, roughness: 0.95 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.85 });
  return assets.createPrototype(buildTiller(), TILLER_COLORS, { secondary: cloth, wood });
}
