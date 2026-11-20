import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { RoadWorld, RoadFrame, makeRoadMaterials } from './road';
import { ROAD, makeRoadTextures, makeGroundTextures, makeGravelTextures } from './textures';
import { CarModel, CarConfig, DIM } from './car';
import { Traffic, PlayerState, CrashEvent } from './traffic';
import { TrafficAssets } from './traffic-models';
import { clamp, damp, lerp, smoothstep } from './noise';

export interface DriveInput {
  throttle: number;
  brake: number;
  /** -1 / +1 — однократная смена полосы влево/вправо в этом кадре. */
  laneShift: number;
}

const SUN_ELEVATION = 6.5;   // градусы — «золотой час»
const SUN_AZIMUTH = 62;
const CRUISE = 25;           // м/с = 90 км/ч
const MIN_SPEED = 11;

export class DriveScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
  readonly world: RoadWorld;
  readonly traffic: Traffic;
  crashes = 0;
  onCrash?: (e: CrashEvent) => void;
  private shakeAmp = 0;
  private player: PlayerState = { s: 0, v: 0, d: 0, lane: 0, length: 4.5, width: 1.9 };
  private sky: Sky;
  private sun = new THREE.DirectionalLight(0xffd2a0, 5.2);
  private sunDir = new THREE.Vector3();
  private car!: CarModel;
  private cfg!: CarConfig;
  private frame: RoadFrame;

  // состояние машины
  s = 30;
  v = 0;
  lane = 1;            // -1 левая, 0 средняя, 1 правая
  d = ROAD.half - 0.9; // поперечное смещение (вправо +), старт — с обочины
  private dv = 0;
  private roll = 0; private rollV = 0;
  private pitch = 0; private pitchV = 0;
  private lastV = 0;
  private yawOff = 0;
  private spin = 0;

  // камера
  private camOffset = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camFar = false;
  introT = 0;
  readonly introDur = 4.2;
  phase: 'intro' | 'drive' = 'intro';
  odometer = 0;

  constructor(envGen: THREE.PMREMGenerator, textureSize: number, anisotropy: number, seed: number) {
    this.scene.name = 'drive';
    // небо и солнце
    this.sky = new Sky();
    this.sky.scale.setScalar(3500);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3.2;
    u.rayleigh.value = 2.2;
    u.mieCoefficient.value = 0.0045;
    u.mieDirectionalG.value = 0.84;
    u.cloudCoverage.value = 0.38;
    u.cloudDensity.value = 0.55;
    u.cloudScale.value = 0.00022;
    u.cloudElevation.value = 0.45;
    const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION);
    const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.scene.add(this.sky);

    // окружение для отражений и рассеянного света — из того же неба
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(1000);
    for (const k of Object.keys(u)) (envSky.material.uniforms as any)[k].value = (u as any)[k].value;
    envSky.material.uniforms.showSunDisc.value = 0;
    envScene.add(envSky);
    // тёплая «земля» в отражениях вместо пустоты под горизонтом
    const groundHemi = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x2e2a1f, side: THREE.BackSide }));
    envScene.add(groundHemi);
    this.scene.environment = envGen.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = 0.75;

    this.scene.fog = new THREE.FogExp2(0xbfae9c, 0.0017);

    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.left = -28; sh.camera.right = 28; sh.camera.top = 28; sh.camera.bottom = -28;
    sh.camera.near = 1; sh.camera.far = 400;
    sh.bias = -0.00025;
    sh.normalBias = 0.025;
    this.scene.add(this.sun, this.sun.target);
    // голубоватая подсветка теней от неба
    this.scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x3a3326, 0.5));

    const mats = makeRoadMaterials(makeRoadTextures(textureSize), makeGroundTextures(textureSize >= 1024 ? 512 : 256),
      makeGravelTextures(256), anisotropy);
    this.world = new RoadWorld(seed, mats);
    this.scene.add(this.world.group);
    this.traffic = new Traffic(this.world.path, new TrafficAssets());
    this.traffic.onCrash = (e) => this.crash(e);
    this.scene.add(this.traffic.group);
    this.frame = this.world.path.frame(0);
  }

  setShadowMapSize(n: number) {
    const sh = this.sun.shadow;
    if (sh.mapSize.x === n) return;
    sh.mapSize.set(n, n);
    sh.map?.dispose();
    sh.map = null as unknown as THREE.WebGLRenderTarget;
  }

  attachCar(car: CarModel, cfg: CarConfig) {
    this.car = car;
    this.cfg = cfg;
    car.root.position.set(0, 0, 0);
    car.root.rotation.set(0, 0, 0);
    car.root.quaternion.identity();
    this.scene.add(car.root);
  }

  /** Новый заезд: машина стоит на обочине, начинается заставка выезда. */
  reset(skipIntro = false, startS = 30) {
    this.s = startS;
    this.v = skipIntro ? CRUISE : 0;
    this.lane = 1;
    this.d = skipIntro ? ROAD.laneWidth : ROAD.half - 0.9;
    this.dv = 0;
    this.roll = this.rollV = this.pitch = this.pitchV = 0;
    this.introT = skipIntro ? this.introDur : 0;
    this.phase = skipIntro ? 'drive' : 'intro';
    this.odometer = 0;
    this.placeCar(0);
    this.world.prime(this.s, this.car.root.position);
    this.crashes = 0;
    this.shakeAmp = 0;
    this.traffic.populate(this.playerState(), 0);
    this.placeCar(0);
    this.updateSun();
    this.snapCamera();
    this.sky.position.copy(this.camera.position);
  }

  toggleCamera() { this.camFar = !this.camFar; }

  get speedKmh() { return this.v * 3.6; }
  get braking() { return this.lastBrake; }
  private lastBrake = 0;

  update(dt: number, input: DriveInput, time: number) {
    dt = Math.min(dt, 1 / 20);
    const cfg = this.cfg;
    const vmax = cfg.maxSpeedKmh / 3.6;
    let a = 0;
    let brake = 0;
    if (this.phase === 'intro') {
      this.introT += dt;
      // разгон с обочины и перестроение в правую полосу
      const t = this.introT;
      a = t < 0.6 ? 0 : (CRUISE - this.v) * 0.9 + 2.5;
      if (t > 1.2) this.lane = 1;
      if (this.introT >= this.introDur) this.phase = 'drive';
    } else {
      if (input.laneShift) this.lane = clamp(this.lane + input.laneShift, -1, 1);
      if (input.throttle > 0) a = cfg.accel * Math.pow(Math.max(0, 1 - this.v / vmax), 0.6) * input.throttle;
      else if (input.brake > 0) { a = -cfg.brake * input.brake; brake = input.brake; }
      else a = clamp((CRUISE - this.v) * 0.35, -2.2, 1.8);
    }
    // тормозом ниже MIN_SPEED не сбросить, но после удара скорость может быть меньше — машина разгонится сама
    const floor = this.phase === 'intro' ? 0 : Math.min(MIN_SPEED, this.v);
    this.v = clamp(this.v + a * dt, floor, vmax);
    if (input.brake > 0 && this.v <= MIN_SPEED + 0.01) brake = input.brake;
    this.lastBrake = brake;
    const ds = this.v * dt;
    this.s += ds;
    this.odometer += ds;

    // смена полосы: пружина с критическим демпфированием
    const target = this.lane * ROAD.laneWidth;
    const w = (this.phase === 'intro' ? 2.2 : 4.6 / cfg.laneChangeTime) ;
    const acc = w * w * (target - this.d) - 2 * w * this.dv;
    this.dv += acc * dt;
    this.d += this.dv * dt;

    // динамика кузова: крен от бокового ускорения, тангаж от продольного
    this.placeCar(dt);
    const latA = acc + this.v * this.v * this.frame.curvature;
    const longA = (this.v - this.lastV) / Math.max(dt, 1e-3);
    this.lastV = this.v;
    const kSp = 60, kDm = 9;
    this.rollV += (kSp * (-latA * 0.0065 - this.roll) - kDm * this.rollV) * dt;
    this.roll += this.rollV * dt;
    this.pitchV += (kSp * (-longA * 0.0042 - this.pitch) - kDm * this.pitchV) * dt;
    this.pitch += this.pitchV * dt;
    this.car.body.rotation.set(this.pitch, 0, this.roll);
    // лёгкая вибрация дороги на скорости
    this.car.body.position.y = Math.sin(time * 37) * 0.0015 * (this.v / 50) + Math.sin(time * 13.3) * 0.002 * (this.v / 50);

    this.spin += ds / DIM.wheelR;
    const steer = clamp(this.yawOff * 2.4 + this.frame.curvature * 2.7, -0.4, 0.4);
    for (const wh of this.car.wheels) {
      wh.spin.rotation.x = this.spin;
      if (wh.front) wh.steer.rotation.y = steer;
    }
    this.car.setBrake(brake);

    this.updateSun();
    this.world.update(this.s, this.car.root.position);
    this.traffic.update(dt, this.playerState(), this.odometer, time);
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 1.6);
    this.sky.material.uniforms.time.value = time;
    this.updateCamera(dt, time);
    this.sky.position.copy(this.camera.position);
  }

  private _q = new THREE.Quaternion();
  private _m = new THREE.Matrix4();
  private _x = new THREE.Vector3();
  private _f = new THREE.Vector3();

  private placeCar(_dt: number) {
    const f = this.world.path.frame(this.s, this.frame);
    const half = ROAD.half;
    const crown = 0.07 * (1 - Math.min(1, (this.d / half) ** 2));
    this.car.root.position.copy(f.pos).addScaledVector(f.right, this.d).addScaledVector(f.up, crown);
    this.yawOff = Math.atan2(this.dv, Math.max(this.v, 3));
    // курс машины = направление дороги + угол перестроения
    this._f.copy(f.fwd).applyAxisAngle(f.up, -this.yawOff);
    this._x.crossVectors(f.up, this._f).normalize();
    this._m.makeBasis(this._x, f.up, this._f);
    this._q.setFromRotationMatrix(this._m);
    this.car.root.quaternion.copy(this._q);
  }

  private updateSun() {
    const p = this.car.root.position;
    this.sun.position.copy(p).addScaledVector(this.sunDir, 200);
    this.sun.target.position.copy(p);
    // привязка к текселям теневой карты — без «дрожания» теней
    const sh = this.sun.shadow;
    const texel = (sh.camera.right - sh.camera.left) / sh.mapSize.x;
    this.sun.target.position.x = Math.round(p.x / texel) * texel;
    this.sun.target.position.z = Math.round(p.z / texel) * texel;
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 200);
  }

  private chaseOffset(out: THREE.Vector3, look: THREE.Vector3) {
    const f = this.frame;
    const k = smoothstep(CRUISE * 0.6, 55, this.v);
    const dist = (this.camFar ? 8.4 : 6.3) + k * 0.8;
    const height = (this.camFar ? 2.6 : 1.85) + k * 0.15;
    // камера смотрит вдоль дороги, а не строго за кузовом — плавнее на перестроениях
    out.copy(f.fwd).multiplyScalar(-dist).addScaledVector(f.up, height).addScaledVector(f.right, -this.d * 0.08);
    out.y = Math.max(out.y, height * 0.75);
    look.copy(f.fwd).multiplyScalar(5.5).addScaledVector(f.up, 0.95);
  }

  private snapCamera() {
    if (this.phase === 'intro') this.introOffset(0, this.camOffset, this.camLook);
    else this.chaseOffset(this.camOffset, this.camLook);
    this.applyCamera(0);
  }

  /** Заставка: облёт от переднего крыла к месту за машиной. */
  private introOffset(t: number, out: THREE.Vector3, look: THREE.Vector3) {
    const f = this.frame;
    const e = smoothstep(0.8, this.introDur, t);
    const ang = lerp(0.62, Math.PI, e); // от ~35° (спереди, со стороны дороги) к 180° (сзади)
    const r = lerp(5.6, 6.1, e);
    const h = lerp(0.7, 1.85, e);
    const carRight = this._x.crossVectors(f.fwd, f.up).normalize();
    out.copy(f.fwd).multiplyScalar(Math.cos(ang) * r)
      .addScaledVector(carRight, -Math.sin(ang) * r)
      .addScaledVector(f.up, h);
    look.copy(f.fwd).multiplyScalar(lerp(0.4, 5.5, e)).addScaledVector(f.up, lerp(0.55, 0.95, e));
  }

  private _off = new THREE.Vector3();
  private _look = new THREE.Vector3();

  private updateCamera(dt: number, time: number) {
    if (this.phase === 'intro') {
      this.introOffset(this.introT, this._off, this._look);
      this.camOffset.copy(this._off);
      this.camLook.copy(this._look);
    } else {
      this.chaseOffset(this._off, this._look);
      this.camOffset.x = damp(this.camOffset.x, this._off.x, 5, dt);
      this.camOffset.y = damp(this.camOffset.y, this._off.y, 5, dt);
      this.camOffset.z = damp(this.camOffset.z, this._off.z, 5, dt);
      this.camLook.x = damp(this.camLook.x, this._look.x, 7, dt);
      this.camLook.y = damp(this.camLook.y, this._look.y, 7, dt);
      this.camLook.z = damp(this.camLook.z, this._look.z, 7, dt);
    }
    this.applyCamera(time);
    const k = smoothstep(CRUISE, 58, this.v);
    const fov = 52 + k * 13;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, fov, 3, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  private playerState(): PlayerState {
    const p = this.player;
    p.s = this.s; p.v = this.v; p.d = this.d; p.lane = this.lane;
    return p;
  }

  /** Удар о машину трафика: потеря скорости, отброс, встряска. */
  private crash(e: CrashEvent) {
    if (this.phase !== 'drive') return;
    this.crashes++;
    const r = this.traffic.resolve(this.playerState());
    this.s += r.ds;
    if (r.v !== null) this.v = r.v;
    if (r.lane !== null) { this.lane = r.lane; this.dv *= -0.4; }
    this.shakeAmp = 0.35 + e.severity * 0.65;
    this.pitchV += (e.side ? 0 : 1.5) * e.severity;
    this.rollV += (e.side ? 2.5 : 0.6) * (Math.random() - 0.5) * 2;
    this.onCrash?.(e);
  }

  private applyCamera(time: number) {
    const p = this.car.root.position;
    // камера немного отстаёт по поперечному смещению машины
    this.camera.position.copy(p).add(this.camOffset);
    const shake = smoothstep(35, 58, this.v) * 0.012 + this.shakeAmp * 0.08;
    this.camera.position.y += Math.sin(time * 23.1) * shake + Math.sin(time * 31.7) * shake * 0.6;
    this.camera.position.x += Math.sin(time * 19.3) * shake * 0.5;
    this.camera.lookAt(this._look.copy(p).add(this.camLook));
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
