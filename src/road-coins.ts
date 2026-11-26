import * as THREE from 'three';
import { mulberry32 } from './noise';
import type { RoadPath } from './road';
import { ROAD } from './textures';

export const ROAD_COIN_VALUE = 1;
/** Сколько процентов заряда даёт подобранная батарейка. */
export const ROAD_BATTERY_AMOUNT = 5;

export type RoadPickupKind = 'coin' | 'battery';
export interface RoadPickup { kind: RoadPickupKind; amount: number; }

// В среднем ~130 м между наборами: дни идут вдвое быстрее, плотность на игровой день та же.
const MIN_GAP_M = 85;
const GAP_VARIATION_M = 90;

export class RoadCoins {
  readonly group = new THREE.Group();
  private readonly holder = new THREE.Group();
  private readonly visuals: Record<RoadPickupKind, THREE.Group> = {
    coin: coinMesh(),
    battery: batteryMesh(),
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
    return this.random() < 0.32 ? 'battery' : 'coin';
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
    const amount = this.kind === 'coin' ? ROAD_COIN_VALUE : ROAD_BATTERY_AMOUNT;
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

/** Батарейка: зелёный элемент питания в полупрозрачном шаре. */
function batteryMesh() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 0.5, 0.26),
    new THREE.MeshStandardMaterial({ color: 0x35d06b, emissive: 0x0b5a2a, emissiveIntensity: 0.6, metalness: 0.35, roughness: 0.32 }),
  );
  const plus = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 0.08, 12),
    new THREE.MeshStandardMaterial({ color: 0x0e6b34, roughness: 0.45, metalness: 0.4 }),
  );
  plus.position.y = 0.29;
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.27, 0.09, 0.27),
    new THREE.MeshBasicMaterial({ color: 0xd9ffe7 }),
  );
  stripe.position.y = 0.12;
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 24, 16),
    new THREE.MeshStandardMaterial({
      color: 0xc8ffdd, emissive: 0x2f8f52, emissiveIntensity: 0.1,
      transparent: true, opacity: 0.11, roughness: 0.08, metalness: 0,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  group.add(shell, body, plus, stripe);
  group.scale.set(1.7, 2.0, 1.7);
  return group;
}

