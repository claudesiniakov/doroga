import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CarModel } from './car';
import { damp } from './noise';

/** Студия-гараж: подиум, световые панели, отражения. Камера медленно облетает машину, можно вращать. */
export class GarageScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  private turntable = new THREE.Group();
  private car?: CarModel;
  yaw = -0.65;
  private yawVel = 0.12;
  private dragging = false;
  private lastX = 0;
  private idle = 0;

  constructor(envGen: THREE.PMREMGenerator, private dom: HTMLElement) {
    this.scene.name = 'garage';
    this.scene.background = new THREE.Color(0x07080a);
    this.scene.fog = new THREE.Fog(0x07080a, 14, 38);
    this.scene.environment = envGen.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.42;

    // пол: тёмный полуглянец
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 96),
      new THREE.MeshPhysicalMaterial({ color: 0x060607, roughness: 0.55, metalness: 0.0, clearcoat: 0.5, clearcoatRoughness: 0.18 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // подиум с подсвеченной кромкой
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.45, 0.09, 128),
      new THREE.MeshPhysicalMaterial({ color: 0x101113, roughness: 0.38, metalness: 0.4, clearcoat: 1, clearcoatRoughness: 0.1 }));
    plate.position.y = 0.045;
    plate.receiveShadow = true;
    this.turntable.add(plate);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.43, 0.012, 8, 160),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd9a8, emissiveIntensity: 2.2 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.075;
    this.scene.add(ring);
    this.turntable.position.y = 0.09;
    this.scene.add(this.turntable);

    // световые панели над машиной и по бокам — видны в отражениях лака
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 2.6, side: THREE.DoubleSide });
    for (let i = -1; i <= 1; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 7), panelMat);
      p.rotation.x = Math.PI / 2;
      p.position.set(i * 1.3, 5.2, 0);
      this.scene.add(p);
    }

    const key = new THREE.SpotLight(0xfff4e8, 45, 30, 0.42, 0.85, 1.6);
    key.position.set(2.5, 7.5, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 6;
    this.scene.add(key, key.target);
    const rimL = new THREE.SpotLight(0xffc89a, 60, 30, 0.5, 0.8, 1.8);
    rimL.position.set(-6, 3, -5);
    this.scene.add(rimL, rimL.target);
    const rimR = new THREE.SpotLight(0x9fc1ff, 45, 30, 0.5, 0.8, 1.8);
    rimR.position.set(6, 2.5, -4);
    this.scene.add(rimR, rimR.target);

    this.bindDrag();
  }

  private bindDrag() {
    const el = this.dom;
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button, .panel')) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.idle = 0;
    });
    addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      this.lastX = e.clientX;
      this.yawVel = dx * 0.35;
      this.yaw += dx * 0.006;
    });
    addEventListener('pointerup', () => { this.dragging = false; });
  }

  attachCar(car: CarModel) {
    if (this.car && this.car !== car) this.car.root.removeFromParent();
    this.car = car;
    car.root.position.set(0, 0, 0);
    car.root.quaternion.identity();
    car.body.rotation.set(0, 0, 0);
    car.body.position.set(0, 0, 0);
    for (const w of car.wheels) { w.spin.rotation.x = 0; w.steer.rotation.y = w.front ? 0.28 : 0; }
    car.setBrake(0);
    this.turntable.add(car.root);
  }

  update(dt: number) {
    this.idle += dt;
    if (!this.dragging) {
      const target = this.idle > 2 ? 0.12 : 0;
      this.yawVel = damp(this.yawVel, target, 2, dt);
      this.yaw += this.yawVel * dt;
    }
    this.turntable.rotation.y = this.yaw;
    // камера: чуть сверху, три четверти
    const t = performance.now() / 1000;
    const r = innerWidth < innerHeight ? 11.5 : 8.6;
    this.camera.position.set(Math.sin(0.35) * r, 1.55 + Math.sin(t * 0.2) * 0.05, Math.cos(0.35) * r);
    this.camera.lookAt(0, 0.62, 0);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    // на широком экране машина правее центра — слева карточка
    const w = innerWidth, h = innerHeight;
    if (w > 900 && w > h) this.camera.setViewOffset(w, h, -w * 0.14, 0, w, h);
    else if (w > 900) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, 0, h * 0.16, w, h);
    this.camera.updateProjectionMatrix();
  }

  get hasCar() { return !!this.car; }
}
