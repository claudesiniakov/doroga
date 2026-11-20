import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { RoadWorld, RoadFrame, makeRoadMaterials, EXIT_W, Exit, ExitKind } from './road';
import { ROAD, makeRoadTextures, makeGroundTextures, makeGravelTextures, makeSandTextures } from './textures';
import { CarModel, CarConfig } from './car';
import { Traffic, PlayerState, CrashEvent } from './traffic';
import { TrafficAssets } from './traffic-models';
import { mountainRing } from './props';
import { makeWaterNormal } from './textures';
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
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 9000);
  readonly world: RoadWorld;
  readonly traffic: Traffic;
  crashes = 0;
  onCrash?: (e: CrashEvent) => void;
  private shakeAmp = 0;
  private mountains = new THREE.Group();
  private sea: THREE.Mesh;
  private waterNormal: THREE.Texture;
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
  /**
   * intro — заставка; drive — езда; pitIn — заезд к колонке; refuel — стоим у колонки;
   * pitOut — выезд со съезда; empty — бак пуст, машина катится; stopped — заезд окончен.
   */
  phase: 'intro' | 'drive' | 'pitIn' | 'refuel' | 'pitOut' | 'empty' | 'wrecked' | 'stopped' = 'intro';
  // топливо и деньги
  static readonly START_COINS = 100;
  static readonly LITERS_PER_KM = 2;
  static readonly PRICE = 1; // монет за литр
  fuel = 0;
  coins = DriveScene.START_COINS;
  get tank() { return this.cfg.tankL; }
  // здоровье и страховки
  static readonly KASKO = 40;
  static readonly OSAGO = 10;
  static readonly REPAIR_PRICE = 1; // монет за 10 %
  health = 100;
  insurance = { kasko: false, osago: false };
  /** Причина конца заезда. */
  endReason: 'fuel' | 'wreck' | null = null;
  onStation?: (kind: ExitKind) => void;
  onEmpty?: () => void;
  /** Удар: потеря здоровья и (без ОСАГО) списанные монеты. */
  onDamage?: (info: { damage: number; fine: number; covered: boolean }) => void;
  get stationKind(): ExitKind | null { return this.pitExit?.kind ?? null; }
  private pitExit: Exit | null = null;
  odometer = 0;

  constructor(envGen: THREE.PMREMGenerator, textureSize: number, anisotropy: number, seed: number) {
    this.scene.name = 'drive';
    // небо и солнце
    this.sky = new Sky();
    this.sky.scale.setScalar(12000);
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

    const fogColor = new THREE.Color(0xbfae9c);
    this.scene.fog = new THREE.FogExp2(fogColor, 0.0017);

    // дальний пояс: два кольца гор, подножие тонет в дымке цвета тумана
    this.mountains.add(
      mountainRing(2600, 40, 260, seed + 1, new THREE.Color(0x7d7890), fogColor.clone()),
      mountainRing(3600, 120, 520, seed + 2, new THREE.Color(0x9a93a8), fogColor.clone().lerp(new THREE.Color(0xc9b7a6), 0.4)),
    );
    this.mountains.children[1].renderOrder = -1;
    this.scene.add(this.mountains);

    // море: плоскость с анимированной рябью, отражает небо

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
      makeGravelTextures(256), anisotropy, makeSandTextures(textureSize >= 1024 ? 512 : 256));
    this.world = new RoadWorld(seed, mats);
    this.scene.add(this.world.group);
    this.traffic = new Traffic(this.world.path, new TrafficAssets());
    this.traffic.onCrash = (e) => this.crash(e);
    this.scene.add(this.traffic.group);

    // море: на сетке дальнего рельефа, видно только по маске (сторона моря у побережья)
    this.waterNormal = makeWaterNormal(512);
    const far = this.world.far;
    this.waterNormal.repeat.set(far.gridSize / 27, far.gridSize / 27);
    this.sea = new THREE.Mesh(new THREE.PlaneGeometry(far.gridSize, far.gridSize).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0f3346, roughness: 0.07, metalness: 0.05, normalMap: this.waterNormal,
        alphaMap: far.seaMask, alphaTest: 0.5,
        normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.25 }));
    this.sea.receiveShadow = true;
    this.sea.visible = false;
    this.scene.add(this.sea);
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
    if (this.car && this.car !== car) this.car.root.removeFromParent();
    this.car = car;
    this.player.length = car.length;
    this.player.width = car.width;
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
    this.fuel = this.cfg.tankL;
    this.health = 100;
    this.endReason = null;
    // страховки покупаются на старте из стартовых монет
    this.coins = DriveScene.START_COINS - (this.insurance.kasko ? DriveScene.KASKO : 0) - (this.insurance.osago ? DriveScene.OSAGO : 0);
    this.pitExit = null;
    this.placeCar(0);
    this.world.prime(this.s, this.car.root.position);
    this.crashes = 0;
    this.shakeAmp = 0;
    this.traffic.populate(this.playerState(), 0);
    this.placeCar(0);
    this.updateSun();
    this.snapCamera();
    this.updateFar(0);
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
    } else if (this.phase === 'pitIn') {
      // плавная остановка ровно у колонки
      const left = Math.max(0, this.pitExit!.sStop - this.s);
      const vTarget = Math.sqrt(2 * 2.6 * left);
      a = clamp((vTarget - this.v) * 3, -7, 1);
      brake = 1;
      if (left < 0.4 && this.v < 0.6) {
        this.v = 0; a = 0;
        this.phase = 'refuel';
        this.onStation?.(this.pitExit!.kind);
      }
    } else if (this.phase === 'refuel' || this.phase === 'stopped') {
      this.v = 0; a = 0; brake = 1;
    } else if (this.phase === 'empty' || this.phase === 'wrecked') {
      // бак пуст — накат; машина разбита — тормозим до остановки
      a = this.phase === 'empty' ? -1.6 - this.v * 0.02 : -6;
      brake = this.phase === 'wrecked' ? 1 : 0;
      if (this.v + a * dt <= 0.05) {
        this.v = 0; a = 0;
        this.endReason = this.phase === 'empty' ? 'fuel' : 'wreck';
        this.phase = 'stopped';
        this.onEmpty?.();
      }
    } else {
      const path = this.world.path;
      // полоса 2 — съезд: доступна, только пока он открыт впереди
      const exitOpen = this.exitOpen;
      if (input.laneShift && this.phase === 'drive') this.lane = clamp(this.lane + input.laneShift, -1, exitOpen ? 2 : 1);
      // съезд кончается — вливаемся обратно
      if (this.lane === 2 && path.extraAt(this.s + 35) < EXIT_W * 0.7) this.lane = 1;
      if (this.phase === 'pitOut' && this.lane !== 2) this.phase = 'drive';
      // в полосе съезда перед колонкой — заезд на заправку
      const ex = path.exitNear(this.s, 0);
      // заезд к колонке — только если успеваем мягко остановиться (≈2.6 м/с²)
      const need = (this.v * this.v) / (2 * 4.5) + 4;
      if (this.phase === 'drive' && this.lane === 2 && ex && this.s > ex.sStop - 140 && ex.sStop - this.s > need) {
        this.pitExit = ex;
        this.phase = 'pitIn';
      }
      if (input.throttle > 0) a = cfg.accel * Math.pow(Math.max(0, 1 - this.v / vmax), 0.6) * input.throttle;
      else if (input.brake > 0) { a = -cfg.brake * input.brake; brake = input.brake; }
      else a = clamp((CRUISE - this.v) * 0.35, this.phase === 'pitOut' ? -2.2 : -2.2, this.phase === 'pitOut' ? 3.2 : 1.8);
    }
    // тормозом ниже MIN_SPEED не сбросить, но после удара/заправки скорость может быть меньше — машина разгонится сама
    const floor = this.phase === 'drive' || this.phase === 'pitOut' ? Math.min(MIN_SPEED, this.v) : 0;
    this.v = clamp(this.v + a * dt, floor, vmax);
    if (input.brake > 0 && this.v <= MIN_SPEED + 0.01) brake = input.brake;
    this.lastBrake = brake;
    const ds = this.v * dt;
    this.s += ds;
    this.odometer += ds;
    // расход: 2 л на км
    if (this.phase !== 'intro') {
      this.fuel = Math.max(0, this.fuel - (ds / 1000) * DriveScene.LITERS_PER_KM);
      if (this.fuel <= 0 && (this.phase === 'drive' || this.phase === 'pitOut')) this.phase = 'empty';
      if (this.health <= 0 && (this.phase === 'drive' || this.phase === 'pitOut' || this.phase === 'empty')) this.phase = 'wrecked';
    }

    // смена полосы: пружина с критическим демпфированием
    const target = this.lane === 2 ? ROAD.half + EXIT_W / 2 : this.lane * ROAD.laneWidth;
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
    const soft = this.cfg.roll ?? 1;
    this.rollV += (kSp * (-latA * 0.0065 * soft - this.roll) - kDm * this.rollV) * dt;
    this.roll += this.rollV * dt;
    this.pitchV += (kSp * (-longA * 0.0042 * soft - this.pitch) - kDm * this.pitchV) * dt;
    this.pitch += this.pitchV * dt;
    this.car.body.rotation.set(this.pitch, 0, this.roll);
    // лёгкая вибрация дороги на скорости
    this.car.body.position.y = Math.sin(time * 37) * 0.0015 * (this.v / 50) + Math.sin(time * 13.3) * 0.002 * (this.v / 50);

    this.spin += ds / this.car.wheelR;
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
    this.updateFar(time);
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
    if (this.phase === 'pitIn' || this.phase === 'refuel') {
      // у колонки: камера слева-спереди и выше — видно машину, навес и колонки
      out.copy(f.fwd).multiplyScalar(13).addScaledVector(f.right, -6.5).addScaledVector(f.up, 3.4);
      look.copy(f.right).multiplyScalar(2.2).addScaledVector(f.up, 1.9).addScaledVector(f.fwd, -1);
      return;
    }
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

  /** Небо, горы и море следуют за камерой. */
  private updateFar(time: number) {
    const c = this.camera.position;
    this.sky.position.copy(c);
    this.mountains.position.set(c.x, this.car.root.position.y - 30, c.z);
    const far = this.world.far;
    this.sea.visible = !Number.isNaN(far.seaLevel);
    if (this.sea.visible) {
      const px = far.seaCenter.x, pz = far.seaCenter.y;
      this.sea.position.set(px, far.seaLevel, pz);
      // рябь неподвижна в мире при перескоках сетки + медленный дрейф
      const k = 1 / 27;
      this.waterNormal.offset.set(((px * k) % 1) + time * 0.004, ((-pz * k) % 1) + time * 0.0025);
    }
  }

  /** Залить литры (не больше, чем влезет и чем хватит монет). Возвращает фактически залитое. */
  refuel(liters: number): number {
    // литры — целые (доливка до полного — округляется вверх), цена — 1 монета за литр
    const space = Math.ceil(this.tank - this.fuel - 1e-6);
    const l = Math.max(0, Math.min(Math.floor(liters), space, Math.floor(this.coins / DriveScene.PRICE)));
    this.fuel = Math.min(this.tank, this.fuel + l);
    this.coins -= l * DriveScene.PRICE;
    return l;
  }

  /** Цена ремонта на pct процентов (с КАСКО — бесплатно). */
  repairCost(pct: number) {
    return this.insurance.kasko ? 0 : Math.ceil(pct / 10 - 1e-6) * DriveScene.REPAIR_PRICE;
  }

  /** Отремонтировать до pct процентов (шагами по 10 %, сколько хватит монет). Возвращает восстановленные %. */
  repair(pct: number): number {
    let want = Math.min(pct, 100 - this.health);
    if (want <= 0) return 0;
    if (!this.insurance.kasko) want = Math.min(want, Math.floor(this.coins / DriveScene.REPAIR_PRICE) * 10);
    if (want <= 0) return 0;
    this.coins -= this.repairCost(want);
    this.health = Math.min(100, this.health + want);
    return want;
  }

  /** Уехать от колонки/сервиса. */
  leaveStation() {
    if (this.phase !== 'refuel') return;
    if (this.fuel > 0) { this.phase = 'pitOut'; return; }
    this.endReason = 'fuel';
    this.phase = 'stopped';
    this.onEmpty?.();
  }

  /** Можно ли сейчас перестроиться на съезд (полоса открыта впереди). */
  get exitOpen() {
    const p = this.world.path;
    return p.extraAt(this.s + 40) > EXIT_W * 0.8 && p.extraAt(this.s + 90) > EXIT_W * 0.8;
  }

  /** Расстояние до ближайшей колонки впереди, м. */
  get nextStationDist() { return this.world.path.nextExit(this.s, 'fuel').sStop - this.s; }
  get nextRepairDist() { return this.world.path.nextExit(this.s, 'repair').sStop - this.s; }
  get nextExitStartDist() { return this.world.path.nextExit(this.s).s0 - this.s; }
  get nextExitKind(): ExitKind { return this.world.path.nextExit(this.s).kind; }

  private playerState(): PlayerState {
    const p = this.player;
    p.s = this.s; p.v = this.v; p.d = this.d; p.lane = this.lane;
    return p;
  }

  /** Удар о машину трафика: потеря скорости, отброс, встряска. */
  private crash(e: CrashEvent) {
    if (this.phase !== 'drive' && this.phase !== 'pitOut') return;
    this.crashes++;
    const r = this.traffic.resolve(this.playerState());
    this.s += r.ds;
    if (r.v !== null) this.v = r.v;
    if (r.lane !== null) { this.lane = r.lane; this.dv *= -0.4; }
    this.shakeAmp = 0.35 + e.severity * 0.65;
    this.pitchV += (e.side ? 0 : 1.5) * e.severity;
    this.rollV += (e.side ? 2.5 : 0.6) * (Math.random() - 0.5) * 2;
    // повреждения: 15–35 % по силе удара; без ОСАГО — платим за чужую машину
    const damage = Math.round(e.side ? 12 + 10 * e.severity : 12 + 23 * e.severity);
    this.health = Math.max(0, this.health - damage);
    let fine = 0;
    if (!this.insurance.osago) {
      fine = Math.min(this.coins, Math.round(e.side ? 4 + 10 * e.severity : 5 + 25 * e.severity));
      this.coins -= fine;
    }
    this.onDamage?.({ damage, fine, covered: this.insurance.osago });
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
