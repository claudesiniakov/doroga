import * as THREE from 'three';
import { mulberry32 } from './noise';
import type { RoadPath } from './road';
import { ROAD } from './textures';

export const ROAD_COIN_VALUE = 1;
/** Сколько литров и процентов ремонта даёт подобранный набор. */
export const ROAD_FUEL_AMOUNT = 12;
export const ROAD_REPAIR_AMOUNT = 18;

export type RoadPickupKind = 'coin' | 'fuel' | 'repair';
export interface RoadPickup { kind: RoadPickupKind; amount: number; }

// В среднем ~390 м между наборами: при 90 км/ч сбор покрывает топливо и часть штрафов ДПС.
const MIN_GAP_M = 240;
const GAP_VARIATION_M = 250;

export class RoadCoins {
  readonly group = new THREE.Group();
  private readonly holder = new THREE.Group();
  private readonly visuals: Record<RoadPickupKind, THREE.Group> = {
    coin: coinMesh(),
    fuel: fuelMesh(),
    repair: repairMesh(),
  };
  private readonly random: () => number;
  private kind: RoadPickupKind = 'coin';
  private at = 0;
  private lane = 0;

  constructor(private readonly path: RoadPath, seed: number) {
    this.random = mulberry32(seed * 137 + 37);
    for (const visual of Object.values(this.visuals)) this.holder.add(visual);
    this.group.add(this.holder);
    this.group.visible = false;
  }

  reset(s: number) {
    this.schedule(s);
    this.group.visible = false;
  }

  private pickKind(): RoadPickupKind {
    const roll = this.random();
    if (roll < 0.1) return 'fuel';
    if (roll < 0.2) return 'repair';
    return 'coin';
  }

  private schedule(s: number) {
    this.at = s + MIN_GAP_M + this.random() * GAP_VARIATION_M;
    this.lane = (Math.floor(this.random() * 3) - 1) * ROAD.laneWidth;
    this.kind = this.pickKind();
    for (const [kind, visual] of Object.entries(this.visuals)) visual.visible = kind === this.kind;
    const f = this.path.frame(this.at);
    this.holder.position.copy(f.pos).addScaledVector(f.right, this.lane).addScaledVector(f.up, 0.85);
  }

  update(from: number, to: number, d: number, time: number, canCollect: boolean): RoadPickup | null {
    const collected = canCollect && to > from && to >= this.at - 1.35 && from <= this.at + 1.35
      && Math.abs(d - this.lane) < 0.95;
    const amount = this.kind === 'coin' ? ROAD_COIN_VALUE : this.kind === 'fuel' ? ROAD_FUEL_AMOUNT : ROAD_REPAIR_AMOUNT;
    const pickup = collected ? { kind: this.kind, amount } : null;
    if (collected || to > this.at + 10) this.schedule(to);
    this.group.visible = this.at - to < 260;
    this.holder.rotation.y = time * 3.6;
    this.holder.position.y += Math.sin(time * 2.2) * 0.0008;
    return pickup;
  }
}

function coinMesh() {
  const group = new THREE.Group();
  const coin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.09, 18).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffcb38, emissive: 0xa05b0b, emissiveIntensity: 0.5, metalness: 0.5, roughness: 0.32 }),
  );
  group.add(coin);
  return group;
}

/** Канистра с топливом. */
function fuelMesh() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.44, 0.24),
    new THREE.MeshStandardMaterial({ color: 0xd6322c, emissive: 0x4a0a06, emissiveIntensity: 0.45, roughness: 0.45, metalness: 0.25 }),
  );
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.08, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 }),
  );
  cap.position.set(0.09, 0.26, 0);
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.04, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 }),
  );
  handle.position.set(-0.06, 0.25, 0);
  group.add(body, cap, handle);
  group.scale.setScalar(1.35);
  return group;
}

/** Ремкомплект: синий ящик с белым крестом. */
function repairMesh() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.26, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x1f6fd0, emissive: 0x0a2547, emissiveIntensity: 0.5, roughness: 0.4, metalness: 0.3 }),
  );
  const cross = new THREE.MeshBasicMaterial({ color: 0xf4f8ff });
  const vertical = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.02, 0.2), cross);
  const horizontal = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.07), cross);
  vertical.position.y = 0.14;
  horizontal.position.y = 0.14;
  group.add(body, vertical, horizontal);
  group.scale.setScalar(1.35);
  return group;
}
