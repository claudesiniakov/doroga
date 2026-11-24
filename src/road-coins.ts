import * as THREE from 'three';
import { mulberry32 } from './noise';
import type { RoadPath } from './road';
import { ROAD } from './textures';

export const ROAD_COIN_VALUE = 2;

export class RoadCoins {
  readonly group = new THREE.Group();
  private readonly coin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.09, 18).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffcb38, emissive: 0xa05b0b, emissiveIntensity: 0.5, metalness: 0.5, roughness: 0.32 }),
  );
  private readonly random: () => number;
  private at = 0;
  private lane = 0;

  constructor(private readonly path: RoadPath, seed: number) {
    this.random = mulberry32(seed * 137 + 37);
    this.group.add(this.coin);
    this.group.visible = false;
  }

  reset(s: number) {
    this.schedule(s);
    this.group.visible = false;
  }

  private schedule(s: number) {
    this.at = s + 180 + this.random() * 270;
    this.lane = (Math.floor(this.random() * 3) - 1) * ROAD.laneWidth;
    const f = this.path.frame(this.at);
    this.coin.position.copy(f.pos).addScaledVector(f.right, this.lane).addScaledVector(f.up, 0.85);
  }

  update(from: number, to: number, d: number, time: number, canCollect: boolean) {
    const collected = canCollect && to > from && to >= this.at - 1.35 && from <= this.at + 1.35
      && Math.abs(d - this.lane) < 0.95;
    if (collected || to > this.at + 10) this.schedule(to);
    this.group.visible = this.at - to < 260;
    this.coin.rotation.y = time * 3.6;
    return collected ? ROAD_COIN_VALUE : 0;
  }
}
