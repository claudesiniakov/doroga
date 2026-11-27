import * as THREE from 'three';
import { disposeObject } from './dispose';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { RoadWorld, RoadFrame, makeRoadMaterials, EXIT_W, Exit, ExitKind } from './road';
import { ROAD, makeRoadTextures, makeGroundTextures, makeGravelTextures, makeSandTextures } from './textures';
import { CarModel, CarConfig } from './car';
import { Traffic, PlayerState, CrashEvent } from './traffic';
import { TrafficAssets } from './traffic-models';
import { mountainRing } from './props';
import { makeWaterNormal } from './textures';
import { clamp, damp, lerp, smoothstep } from './noise';
import { RoadCoins, type RoadPickup, type RoadPickupKind } from './road-coins';
import { START_COINS, DAYS_PER_SECOND, CHARGE_PER_KM, CHARGE_PRICE, REPAIR_PRICE, POLICE_FINE, ROADSIDE_ASSISTANCE_PRICE } from './drive-rules';

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
// Одна секунда заезда соответствует одному дню невисокосного года.
const MONTH_SECONDS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const INSURANCE_YEAR_DAYS = 365;
const POLICE_APPROACH_RATE = 1.7;
const POLICE_STOP_GAP_M = 10;
const LEFT_SHOULDER = -2;
const RIGHT_SHOULDER = 4;
const SHOULDER_OFFSET = ROAD.half - 0.35;
const SHOULDER_SPEED = 15; // м/с = 54 км/ч

export class DriveScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 9000);
  readonly world: RoadWorld;
  readonly traffic: Traffic;
  crashes = 0;
  onCrash?: (e: CrashEvent) => void;
  private shakeAmp = 0;
  private shoulderRoughness = 0;
  private camLift = 0;
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
  lane = 1;            // -1 левая, 0 средняя, 1 правая, 2 съезд
  d = ROAD.half - 0.9; // поперечное смещение (вправо +), старт — с обочины
  private dv = 0;
  private roll = 0; private rollV = 0;
  private pitch = 0; private pitchV = 0;
  lastV = 0;
  private yawOff = 0;
  private spin = 0;

  // камера
  private camOffset = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camFar = false;
  introT = 0;
  readonly introDur = 4.2;
  /**
   * intro — заставка; drive — езда; pitIn — заезд к сервису; refuel — стоим у сервиса;
   * pitOut — выезд со съезда; empty — бак пуст, машина катится; stopped — заезд окончен.
   */
  phase: 'intro' | 'drive' | 'pitIn' | 'refuel' | 'pitOut' | 'policeIn' | 'protocol' | 'policeOut' | 'empty' | 'wrecked' | 'yearBreak' | 'caught' | 'stopped' = 'intro';
  month = 0;
  private insuranceDays = 0;
  private insuranceStartDay = 0;
  calendarDay = 1;
  coinsCollected = 0;
  payouts = { osago: 0, kasko: 0, ownVictims: 0, ownService: 0, hadOsago: false, hadKasko: false };
  private readonly roadCoins: RoadCoins;
  private previewing = false;
  private previewLeft?: number;
  private snowAmount = 0;
  private snowTarget = 0;
  private readonly warmSun = new THREE.Color(0xffd2a0);
  private readonly coldSun = new THREE.Color(0xe4efff);

  private updateCalendarSeason(immediate = false) {
    // Снег с ноября: месяцы 10 (ноябрь), 11 (декабрь), 0 (январь), 1 (февраль).
    const winter = this.month < 2 || this.month >= 10;
    const season = winter ? 'winter' : this.month < 5 ? 'spring' : this.month < 8 ? 'summer' : 'autumn';
    this.world.setSeason(season);
    this.snowTarget = Number(winter);
    if (immediate) this.applySnow(this.snowTarget);
    this.traffic.motoSeason = !winter;
    this.traffic.summer = season === 'summer';
  }

  /** Сколько проверок за год: с ОСАГО — одна, без полиса — четыре. */
  private schedulePoliceDays() {
    const count = this.insurance.osago ? 1 : 4;
    const marks: number[] = [];
    while (marks.length < count) {
      const day = 20 + Math.random() * 320;
      if (marks.every((m) => Math.abs(m - day) > 25)) marks.push(day);
    }
    this.policeDays = marks.sort((a, b) => a - b);
    this.policeIndex = 0;
  }

  private resetCalendar(date = new Date()) {
    this.month = date.getMonth();
    this.calendarDay = Math.min(date.getDate(), MONTH_SECONDS[this.month]);
    this.insuranceStartDay = this.calendarDay - 1;
    for (let m = 0; m < this.month; m++) this.insuranceStartDay += MONTH_SECONDS[m];
    this.insuranceDays = 0;
    this.schedulePoliceDays();
    this.updateCalendarSeason(true);
  }

  private advanceCalendar(elapsed: number) {
    const oldDay = Math.floor(this.insuranceDays);
    this.insuranceDays = Math.min(INSURANCE_YEAR_DAYS, this.insuranceDays + elapsed * DAYS_PER_SECOND);
    const newDay = Math.floor(this.insuranceDays);
    if (oldDay === newDay) return;
    let day = (this.insuranceStartDay + newDay) % INSURANCE_YEAR_DAYS;
    let month = 0;
    while (day >= MONTH_SECONDS[month]) day -= MONTH_SECONDS[month++];
    this.calendarDay = day + 1;
    if (month !== this.month) {
      this.month = month;
      this.updateCalendarSeason();
    }
  }

  renewInsurance(insurance: DriveScene['insurance'], coins: number) {
    this.insuranceDays = 0;
    this.yearNo++;
    this.traffic.yearNo = this.yearNo;
    this.roadCoins.batteryWeight = Math.max(0.08, 0.32 - 0.04 * (this.yearNo - 1));
    this.insurance = insurance;
    this.schedulePoliceDays();
    this.payouts.hadOsago ||= insurance.osago;
    this.payouts.hadKasko ||= insurance.kasko;
    this.coins = coins;
    this.startS = this.s;
    this.periodStartOdometer = this.odometer;
    this.endReason = null;
    this.crashes = 0;
    this.coinsCollected = 0;
    this.kaskoRepairUsed = false;
    this.policeFine = 0;
    this.chase.active = false;
    this.chase.offered = false;
    this.chase.peak = 0;
    this.chase.slow = 0;
    this.chase.catchT = -1;
    this.chase.done = false;
    this.chaseCrashes = 0;
    if (this.chaseCar) this.chaseCar.vis.root.visible = false;
    if (this.police) this.police.vis.root.visible = false;
    this.updatePolice(0);
    this.phase = 'drive';
  }
  startCoins = 100;
  startS = 30;
  /** Пройдено в этой поездке, м. */
  private periodStartOdometer = 0;
  get tripDone() { return this.odometer - this.periodStartOdometer; }
  /** Был бесплатный ремонт по КАСКО в этой поездке. */
  kaskoRepairUsed = false;
  // ДПС: без ОСАГО — случайная проверка, не больше одной за заезд
  /** Где стоит патруль (null — в этом заезде проверки нет). */
  /** Номер страхового года в заезде (1, 2, 3…). */
  yearNo = 1;
  policeS: number | null = null;
  policeFine = 0;
  /** Дни года (0…365), в которые патруль выходит на дорогу. */
  private policeDays: number[] = [];
  private policeIndex = 0;
  onPolice?: () => void;
  /** Подобрали монеты или батарейку. */
  onPickup?: (kind: RoadPickupKind, amount: number) => void;
  /** Первая остановка патрулём: игрок выбирает, подчиниться или уехать. */
  onPoliceCheck?: () => void;
  /** С ОСАГО инспектор просто желает счастливого пути — без протокола. */
  onPoliceOk?: () => void;
  onChase?: () => void;
  onCaught?: () => void;
  readonly chase = { active: false, offered: false, peak: 0, slow: 0, catchT: -1, done: false };
  /** Сколько ДТП случилось уже во время погони — влияет на статью при поимке. */
  chaseCrashes = 0;
  /** Скорость в момент проверки: после «Поехать дальше» её не теряем. */
  private checkSpeed = 0;
  private chaseCar?: { vis: { root: THREE.Group }; red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial };
  private police!: { vis: { root: THREE.Group }; red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial };
  // заряд и деньги
  /** Заряд батареи, 0–100 %. */
  fuel = 0;
  coins = START_COINS;
  get tank() { return 100; }
  // здоровье и страховки
  health = 100;
  insurance = { kasko: false, osago: false, osagoPrice: 10 };
  /** Причина конца заезда. */
  endReason: 'charge' | 'wreck' | 'year' | null = null;
  onStation?: (kind: ExitKind) => void;
  onEmpty?: () => void;
  onYearEnd?: () => void;
  /** Удар: потеря здоровья и (без ОСАГО) списанные монеты. */
  onDamage?: (info: { ownDamage: number; thirdPartyDamage: number; paidToVictim: number; covered: boolean }) => void;
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
    this.roadCoins = new RoadCoins(this.world.path, seed);
    this.scene.add(this.roadCoins.group);

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

  setSnow(on: boolean) {
    this.world.setSeason(on ? 'winter' : 'summer');
    this.snowTarget = Number(on);
    this.applySnow(this.snowTarget);
  }

  private applySnow(amount: number) {
    this.snowAmount = amount;
    this.world.mats.setSnow(amount);
    this.world.kit.setTreeSnow(amount);
    this.sun.color.copy(this.warmSun).lerp(this.coldSun, amount);
    this.sun.intensity = lerp(5.2, 4.2, amount);
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
    // высокие машины — камера чуть выше, чтобы корма не закрывала дорогу
    const bb = new THREE.Box3().setFromObject(car.body);
    this.camLift = Math.max(0, bb.max.y - bb.min.y - 1.3) * 1.1;
    this.player.width = car.width;
    this.cfg = cfg;
    car.root.position.set(0, 0, 0);
    car.root.rotation.set(0, 0, 0);
    car.root.quaternion.identity();
    this.scene.add(car.root);
  }

  /** Комета припаркована на обочине главного экрана. */
  previewRoad(car: CarModel, config: CarConfig, previewLeft?: number) {
    this.previewing = true;
    this.previewLeft = previewLeft;
    this.resetCalendar();
    const s = 30;
    const f = this.world.path.frame(s);
    this.attachCar(car, config);
    this.s = s;
    this.d = SHOULDER_OFFSET;
    this.v = this.dv = 0;
    car.root.visible = true;
    car.body.position.set(0, 0, 0);
    car.body.rotation.set(0, 0, 0);
    for (const { spin, steer } of car.wheels) {
      spin.rotation.x = 0;
      steer.rotation.y = 0;
    }
    car.setBrake(0);
    this.placeCar(0);
    if (this.police) this.police.vis.root.visible = false;
    this.traffic.group.visible = false;
    this.roadCoins.group.visible = false;
    this.world.prime(s, f.pos);
    this.frameRoadPreview();
    this.updateSun(f.pos);
    this.updateFar(0, f.pos.y);
  }

  private frameRoadPreview() {
    if (this.previewLeft !== undefined) {
      this.frameDesktopRoadPreview(this.previewLeft);
      return;
    }
    this.camera.clearViewOffset();
    const narrow = Math.max(0, 1.15 - this.camera.aspect);
    const wide = smoothstep(1.15, 1.45, this.camera.aspect);
    const view = this.world.path.frame(this.s - lerp(12, 8, wide));
    this.camera.position.copy(view.pos).addScaledVector(view.up, 3.2 - narrow * 1.7 - wide * 0.65)
      .addScaledVector(view.right, 1.7);
    const target = this.world.path.frame(this.s + 10);
    this.camera.lookAt(target.pos.clone()
      .addScaledVector(target.right, 4.1 + narrow * 9 + wide * 4.3)
      .addScaledVector(target.up, 1.5 - narrow * 5.4));
  }

  private frameDesktopRoadPreview(left: number) {
    const camera = this.camera;
    const aspect = camera.aspect;
    const frame = this.world.path.frame(this.s);
    const bounds = new THREE.Box3().setFromObject(this.car.root);
    const target = bounds.getCenter(new THREE.Vector3());
    const direction = frame.right.clone().multiplyScalar(-0.70)
      .addScaledVector(frame.fwd, -0.72)
      .addScaledVector(frame.up, 0.31).normalize();
    const right = 0.98;
    const centerX = (left + right) / 2;
    camera.setViewOffset(aspect, 1, (0.5 - centerX) * aspect, -0.08, aspect, 1);
    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    const projected = new THREE.Vector3();
    for (let distance = 6.5, attempt = 0; attempt < 10; attempt++, distance *= 1.15) {
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      if (corners.every(corner => {
        projected.copy(corner).project(camera);
        return projected.x >= 2 * left - 1 && projected.x <= 2 * right - 1 &&
          projected.y >= -0.82 && projected.y <= 0.62;
      })) break;
    }
  }

  /** Новый заезд: машина стоит на обочине, начинается заставка выезда. */
  reset(skipIntro = false, startS = 30) {
    this.previewing = false;
    this.camera.clearViewOffset();
    this.s = startS;
    this.yearNo = 1;
    this.traffic.yearNo = 1;
    this.roadCoins.batteryWeight = 0.32;
    this.v = skipIntro ? CRUISE : 0;
    this.lane = 1;
    this.d = skipIntro ? ROAD.laneWidth : ROAD.half - 0.9;
    this.dv = 0;
    this.roll = this.rollV = this.pitch = this.pitchV = 0;
    this.introT = skipIntro ? this.introDur : 0;
    this.phase = skipIntro ? 'drive' : 'intro';
    this.odometer = this.periodStartOdometer = 0;
    this.fuel = this.tank;
    this.health = 100;
    this.endReason = null;
    // страховки покупаются на старте из стартовых монет
    // монеты на поездку (страховки уже оплачены из кошелька)
    this.coins = this.startCoins;
    this.payouts = { osago: 0, kasko: 0, ownVictims: 0, ownService: 0, hadOsago: this.insurance.osago, hadKasko: this.insurance.kasko };
    this.startS = startS;
    this.kaskoRepairUsed = false;
    this.pitExit = null;
    this.policeFine = 0;
    // Сбрасываем погоню и патрули прошлого заезда, иначе они остаются стоять в кадре.
    this.chase.active = false;
    this.chase.offered = false;
    this.chase.peak = 0;
    this.chase.slow = 0;
    this.chase.catchT = -1;
    this.chase.done = false;
    this.chaseCrashes = 0;
    this.policeS = null;
    if (this.chaseCar) this.chaseCar.vis.root.visible = false;
    if (this.police) this.police.vis.root.visible = false;
    this.placeCar(0);
    this.car.root.visible = true;
    this.traffic.group.visible = true;
    this.roadCoins.reset(startS);
    this.coinsCollected = 0;
    this.month = 0;
    this.traffic.summer = false;
    this.traffic.motoSeason = false;
    this.resetCalendar();
    this.traffic.prepareSeasonal();
    this.world.prime(this.s, this.car.root.position);
    this.crashes = 0;
    this.shakeAmp = this.shoulderRoughness = 0;
    this.traffic.populate(this.playerState(), 0);
    this.placeCar(0);
    this.updatePolice(0);
    this.updateSun();
    this.snapCamera();
    this.updateFar(0);
  }

  toggleCamera() { this.camFar = !this.camFar; }

  private get leavingStop() { return this.phase === 'pitOut' || this.phase === 'policeOut'; }
  /** Счётчики пути — одометр, страховой календарь и таймер заезда — идут только здесь. */
  get countingProgress() {
    return this.phase === 'drive' || this.leavingStop || this.phase === 'pitIn' || this.phase === 'policeIn';
  }
  get waitingToMerge() { return this.leavingStop && this.lane !== 1; }

  get speedKmh() { return this.v * 3.6; }
  get braking() { return this.lastBrake; }
  private lastBrake = 0;

  update(dt: number, input: DriveInput, time: number, elapsed = dt) {
    if (this.phase === 'yearBreak') return;
    dt = Math.min(dt, 1 / 20);
    const policeLeft = this.policeS === null ? Infinity : this.policeS - POLICE_STOP_GAP_M - this.s;
    if (this.phase === 'drive' && this.policeS !== null && this.policeFine === 0 &&
      this.health > 0 && this.fuel > 0 && this.v > 0 && policeLeft > 0) {
      // Сжимаем прежний путь от начала манёвра до точки остановки, сохраняя зазор до патруля.
      const oldStoppingDistance = 60 + this.v ** 2 / 8 - POLICE_STOP_GAP_M;
      if (policeLeft <= oldStoppingDistance / 4) {
        if (!this.chase.active && !this.chase.offered) {
          // Спрашиваем игрока; кадр замирает, пока он выбирает.
          this.chase.offered = true;
          this.checkSpeed = this.v;
          this.onPoliceCheck?.();
          return;
        }
        if (!this.chase.active) {
          this.phase = 'policeIn';
          this.lane = RIGHT_SHOULDER;
        }
      }
    }
    const policeApproach = this.phase === 'policeIn';
    const motionDt = policeApproach ? dt * POLICE_APPROACH_RATE : dt;
    const fromS = this.s;
    if (!this.waitingToMerge && this.countingProgress) {
      this.advanceCalendar(elapsed);
    }
    if (this.phase === 'drive' && this.policeS === null && !this.chase.active && this.policeFine === 0) {
      const mark = this.policeDays[this.policeIndex];
      if (mark !== undefined && this.insuranceDays >= mark) {
        this.policeIndex++;
        // Проверка бывает и с полисом: инспектор просто сверяет документы.
        this.policeS = this.s + 240 + Math.random() * 80;
      }
    }
    if (this.snowAmount !== this.snowTarget) {
      const distance = this.snowTarget - this.snowAmount;
      this.applySnow(this.snowAmount + Math.sign(distance) * Math.min(Math.abs(distance), elapsed / 2.5));
    }
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
    } else if (this.phase === 'policeIn') {
      // Тормозим с ускорением, рассчитанным для оставшегося пути до точки остановки.
      a = policeLeft > 0 ? -(this.v ** 2) / (2 * policeLeft) : 0;
      brake = 1;
    } else if (this.phase === 'protocol') {
      this.v = 0; a = 0; brake = 1;
    } else if (this.phase === 'pitIn') {
      // плавная остановка ровно у колонки
      const left = Math.max(0, this.pitExit!.sStop - this.s);
      const vTarget = Math.sqrt(2 * 3.2 * left);
      a = clamp((vTarget - this.v) * 3, -10, 0.5);
      brake = a < -0.3 ? 1 : 0;
      // не проезжаем колонку: упор точно у неё
      if (this.s >= this.pitExit!.sStop - 0.2) { this.s = this.pitExit!.sStop; this.v = 0; }
      if ((left < 0.4 && this.v < 0.6) || this.v === 0) {
        this.v = 0; a = 0;
        this.phase = 'refuel';
        this.onStation?.(this.pitExit!.kind);
      }
    } else if (this.leavingStop) {
      if (this.waitingToMerge && this.traffic.canMerge(this.playerState(), 1)) this.lane = 1;
      if (this.waitingToMerge) {
        this.v = 0;
        brake = 1;
      } else {
        a = clamp((CRUISE - this.v) * 0.35, 0, 3.2);
        if (Math.abs(this.d - ROAD.laneWidth) < 0.4) this.phase = 'drive';
      }
    } else if (this.phase === 'caught') {
      a = -9;
      brake = 1;
      if (this.v + a * dt <= 0.05) { this.v = 0; a = 0; }
    } else if (this.phase === 'refuel' || this.phase === 'stopped') {
      this.v = 0; a = 0; brake = 1;
    } else if (this.phase === 'empty' || this.phase === 'wrecked') {
      // бак пуст — накат; машина разбита — резко тормозим; финиш — плавно тормозим
      a = this.phase === 'empty' ? -1.6 - this.v * 0.02 : -6;
      brake = this.phase === 'empty' ? 0 : 1;
      if (this.v + a * dt <= 0.05) {
        this.v = 0; a = 0;
        this.endReason = this.phase === 'empty' ? 'charge' : 'wreck';
        this.phase = 'stopped';
        this.onEmpty?.();
      }
    } else {
      const path = this.world.path;
      if (input.laneShift && this.phase === 'drive') this.shiftLane(Math.sign(input.laneShift));
      // съезд кончается — вливаемся обратно
      if (this.lane === 2 && path.extraAt(this.s + 35) < EXIT_W * 0.7) this.lane = 1;
      // в полосе съезда перед боксом — заезд в автосервис
      const ex = path.exitNear(this.s, 0);
      // в полосе съезда до колонки — сразу заезд (машина сама тормозит и встаёт у колонки)
      if (this.phase === 'drive' && this.lane === 2 && ex && this.s > ex.s0 && this.s < ex.sStop - 6) {
        this.pitExit = ex;
        this.phase = 'pitIn';
      }
      if (input.throttle > 0) {
        // газ задаёт целевую скорость: 0 % — круиз, 100 % — максимум машины, между — плавно
        const vt = CRUISE + (vmax - CRUISE) * input.throttle;
        if (this.v < vt) a = cfg.accel * Math.pow(Math.max(0, 1 - this.v / vmax), 0.6) * Math.min(1, (vt - this.v) / 3 + 0.15);
        else a = clamp((vt - this.v) * 0.35, -2.2, 0);
      }
      else if (input.brake > 0) { a = -cfg.brake * input.brake; brake = input.brake; }
      else a = clamp((CRUISE - this.v) * 0.35, -2.2, 1.8);
    }
    this.shoulderRoughness = this.phase === 'drive' && this.lane !== 2
      ? smoothstep(ROAD.half - ROAD.shoulder, SHOULDER_OFFSET, Math.abs(this.d)) : 0;
    if (this.shoulderRoughness > 0) {
      const shoulderAccel = Math.min(a, Math.max(-5, (SHOULDER_SPEED - this.v) * 0.85));
      a = lerp(a, shoulderAccel, this.shoulderRoughness);
    }
    // тормозом ниже MIN_SPEED не сбросить, но после удара/сервиса скорость может быть меньше — машина разгонится сама
    const floor = this.phase === 'drive' || this.phase === 'pitOut' || this.phase === 'policeOut' ? Math.min(MIN_SPEED, this.v) : 0;
    const previousSpeed = this.v;
    this.v = clamp(this.v + a * motionDt, floor, vmax);
    if (input.brake > 0 && this.v <= MIN_SPEED + 0.01) brake = input.brake;
    this.lastBrake = brake;
    // Для торможения к точной позиции используем среднюю скорость за шаг.
    const stoppingDistance = Math.max(0, policeLeft);
    const ds = policeApproach
      ? Math.min(stoppingDistance, this.v === 0 ? stoppingDistance : (previousSpeed + this.v) * motionDt / 2)
      : this.v * motionDt;
    const reachedPoliceStop = policeApproach && stoppingDistance - ds < 1e-6;
    if (reachedPoliceStop) this.v = 0;
    this.s += ds;
    // Одометр считает только реальный путь по дороге: без разгона, торможения
    // после аварии, пустого заряда и задержания.
    if (this.countingProgress) this.odometer += ds;
    // расход: 2 л на км
    if (this.phase !== 'intro') {
      this.fuel = Math.max(0, this.fuel - (ds / 1000) * this.chargePerKm);
      if (this.fuel <= 0 && (this.phase === 'drive' || this.phase === 'pitOut' || this.phase === 'policeOut' || this.phase === 'policeIn')) this.phase = 'empty';
      if (this.health <= 0 && (this.phase === 'drive' || this.phase === 'pitOut' || this.phase === 'policeOut' || this.phase === 'empty')) this.phase = 'wrecked';
      // финиш поездки
    }

    // смена полосы: пружина с критическим демпфированием
    const target = this.laneOffset();
    const w = (this.phase === 'intro' ? 2.2 : 4.6 / cfg.laneChangeTime) ;
    const steps = policeApproach ? 2 : 1;
    const step = motionDt / steps;
    let acc = 0;
    for (let i = 0; i < steps; i++) {
      acc = w * w * (target - this.d) - 2 * w * this.dv;
      this.dv += acc * step;
      this.d += this.dv * step;
    }

    // динамика кузова: крен от бокового ускорения, тангаж от продольного
    this.placeCar(dt);
    // ускорения для крена/клевка ограничены: мгновенная потеря скорости при ударе не должна «подбрасывать» кузов
    const latA = clamp(acc + this.v * this.v * this.frame.curvature, -14, 14);
    const longA = clamp((this.v - this.lastV) / Math.max(dt, 1e-3), -14, 10);
    this.lastV = this.v;
    const kSp = 60, kDm = 9;
    const soft = this.cfg.roll ?? 1;
    this.rollV += (kSp * (-latA * 0.0065 * soft - this.roll) - kDm * this.rollV) * dt;
    this.roll += this.rollV * dt;
    this.pitchV += (kSp * (-longA * 0.0042 * soft - this.pitch) - kDm * this.pitchV) * dt;
    this.pitch += this.pitchV * dt;
    this.car.body.rotation.set(this.pitch, 0, this.roll);
    // лёгкая вибрация дороги на скорости
    const bounce = this.shoulderRoughness * smoothstep(0, SHOULDER_SPEED, this.v) * 0.020;
    this.car.body.position.y = Math.sin(time * 37) * (0.0015 * (this.v / 50) + bounce)
      + Math.sin(time * 13.3) * (0.002 * (this.v / 50) + bounce * 0.35);

    this.spin += ds / this.car.wheelR;
    const steer = clamp(this.yawOff * 2.4 + this.frame.curvature * 2.7, -0.4, 0.4);
    for (const wh of this.car.wheels) {
      wh.spin.rotation.x = this.spin;
      if (wh.front) wh.steer.rotation.y = steer;
    }
    this.car.setBrake(brake);

    this.updateSun();
    this.world.update(this.s, this.car.root.position);
    const canCrash = this.phase === 'drive' || this.phase === 'pitOut' || this.phase === 'policeOut';
    this.traffic.update(dt, this.playerState(), this.odometer, time, canCrash);
    // Расталкивание со всеми задетыми машинами: даже после удара сквозь кузов не проехать.
    if (this.traffic.overlapping && canCrash) {
      const r = this.traffic.resolve(this.playerState());
      this.s += r.ds;
      if (r.v !== null) this.v = r.v;
      if (r.lane !== null) { this.lane = r.lane; this.dv *= -0.4; }
    }
    this.updatePolice(time);
    this.updateChase(dt, time);
    const pickup = this.roadCoins.update(fromS, this.s, this.d, time, this.phase === 'drive');
    if (pickup) this.collectPickup(pickup);
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 1.6);
    this.sky.material.uniforms.time.value = time;
    this.updateCamera(dt, time);
    this.updateFar(time);

    if (reachedPoliceStop && this.phase === 'policeIn') {
      this.phase = 'protocol';
      if (this.insurance.osago) {
        // Полис есть — протокол не составляется.
        this.policeFine = 0;
        this.onPoliceOk?.();
      } else {
        this.policeFine = Math.min(POLICE_FINE, this.coins);
        this.coins -= this.policeFine;
        this.onPolice?.();
      }
    }

    // Переоформление на годовщину после выезда с АЗС или от ДПС.
    if (this.phase === 'drive' && this.insuranceDays >= INSURANCE_YEAR_DAYS &&
      this.health > 0 && this.fuel > 0) {
      this.phase = 'yearBreak';
      this.endReason = 'year';
      // Страховой год кончился — погоня прекращается.
      this.stopChase();
      this.onYearEnd?.();
    }
  }

  private collectPickup(pickup: RoadPickup) {
    if (pickup.kind === 'coin') {
      this.coins += pickup.amount;
      this.coinsCollected++;
      return;
    }
    this.fuel = Math.min(this.tank, this.fuel + pickup.amount);
    this.onPickup?.(pickup.kind, pickup.amount);
  }

  private shiftLane(direction: number) {
    if (this.lane === RIGHT_SHOULDER) {
      if (direction < 0) this.lane = 1;
      else if (this.exitOpen) this.lane = 2;
      return;
    }
    if (this.lane === 2) {
      if (direction < 0) this.lane = 1;
      return;
    }
    const next = clamp(this.lane + direction, LEFT_SHOULDER, 2);
    this.lane = next === 2 && !this.exitOpen ? RIGHT_SHOULDER : next;
  }

  private laneOffset() {
    switch (this.lane) {
      case LEFT_SHOULDER: return -SHOULDER_OFFSET;
      case RIGHT_SHOULDER: return SHOULDER_OFFSET;
      case 2: return ROAD.half + EXIT_W / 2;
      default: return this.lane * ROAD.laneWidth;
    }
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

  private updateSun(p = this.car.root.position) {
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
    const height = (this.camFar ? 2.6 : 1.85) + k * 0.15 + this.camLift;
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
  private updateFar(time: number, groundY = this.car.root.position.y) {
    const c = this.camera.position;
    this.sky.position.copy(c);
    this.mountains.position.set(c.x, groundY - 30, c.z);
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

  /** Патрульная машина стоит на обочине, мигалка мигает. */
  private updatePolice(time: number) {
    const ps = this.policeS;
    if (!this.police) {
      if (ps === null) return;
      this.police = this.traffic.assets.createPolice() as typeof this.police;
      this.scene.add(this.police.vis.root);
    }
    const root = this.police.vis.root;
    root.visible = ps !== null && ps - this.s < 1100 && ps - this.s > -200;
    if (!root.visible) return;
    const f = this.world.path.frame(ps!);
    const crown = 0.07 * (1 - (SHOULDER_OFFSET / ROAD.half) ** 2);
    root.position.copy(f.pos).addScaledVector(f.right, SHOULDER_OFFSET).addScaledVector(f.up, crown);
    this._x.crossVectors(f.up, f.fwd).normalize();
    this._m.makeBasis(this._x, f.up, f.fwd);
    root.quaternion.setFromRotationMatrix(this._m);
    const on = Math.floor(time * 6) % 2 === 0;
    this.police.red.emissiveIntensity = on ? 6 : 0.2;
    this.police.blue.emissiveIntensity = on ? 0.2 : 6;
  }

  /** Подписать протокол и уехать. */
  leavePolice() {
    if (this.phase !== 'protocol') return;
    this.phase = 'policeOut';
    this.policeS = null;
    this.policeFine = 0;
  }

  /** Погоня прекращается, когда заканчивается страховой год. */
  stopChase() {
    if (!this.chase.active && this.chase.catchT < 0) return;
    this.chase.active = false;
    this.chase.catchT = -1;
    if (this.chaseCar) this.chaseCar.vis.root.visible = false;
  }

  /** Игрок решил остановиться: плавно съезжаем на обочину за патрулём, затем протокол. */
  stopAtPolice() {
    if (this.phase === 'protocol' || this.phase === 'policeIn') return;
    this.chase.offered = true;
    const left = this.policeS === null ? Infinity : this.policeS - POLICE_STOP_GAP_M - this.s;
    if (left > 2 && this.v > 1) {
      this.phase = 'policeIn';
      this.lane = RIGHT_SHOULDER;
      return;
    }
    // Уже у патруля или стоим — встаём на обочину сразу.
    this.lane = RIGHT_SHOULDER;
    this.d = SHOULDER_OFFSET;
    this.dv = 0;
    this.v = 0;
    this.phase = 'protocol';
    if (this.insurance.osago) {
      // Полис есть — даже остановившись у патруля, слышим «счастливого пути».
      this.policeFine = 0;
      this.onPoliceOk?.();
    } else {
      this.policeFine = Math.min(POLICE_FINE, this.coins);
      this.coins -= this.policeFine;
      this.onPolice?.();
    }
  }

  /** Игрок решил уехать: патруль бросается вдогонку. */
  startChase() {
    if (this.chase.active) return;
    this.chase.active = true;
    this.chase.offered = true;
    // Сохраняем скорость, с которой игрок подъехал к патрулю.
    this.v = Math.max(this.v, this.checkSpeed);
    this.chase.peak = this.v;
    this.chase.slow = 0;
    this.chaseCrashes = 0;
    this.chase.catchT = -1;
    this.chase.done = false;
    if (!this.chaseCar) {
      this.chaseCar = this.traffic.assets.createPolice() as typeof this.police;
      this.scene.add(this.chaseCar!.vis.root);
    }
    this.chaseCar!.vis.root.visible = true;
    this.onChase?.();
  }

  private updateChase(dt: number, time: number) {
    const c = this.chase;
    if (this.phase === 'yearBreak' && c.active) {
      this.stopChase();
      return;
    }
    if (c.catchT >= 0) {
      c.catchT += dt;
      this.placeChaseCar(this.s + 7, 0, true, time);
      if (c.catchT > 1.1 && !c.done) {
        c.done = true;
        this.onCaught?.();
      }
      return;
    }
    if (!c.active) return;
    // Проехали стоящий патруль — убираем его из кадра.
    if (this.policeS !== null && this.s > this.policeS + 40) this.policeS = null;
    // Догнали, если скорость просела больше чем на 10 % от лучшей в погоне.
    c.peak = Math.max(c.peak, this.v);
    c.slow = this.v < c.peak * 0.9 ? c.slow + dt : 0;
    if (c.slow > 0.55) {
      c.catchT = 0;
      this.phase = 'caught';
      this.v = 0;
      this.placeChaseCar(this.s + 7, 0, true, time);
      return;
    }
    this.placeChaseCar(Math.max(0, this.s - 14), -ROAD.laneWidth * 0.55, false, time);
  }

  private placeChaseCar(s: number, lateral: number, blocking: boolean, time: number) {
    const car = this.chaseCar;
    if (!car) return;
    const f = this.world.path.frame(s);
    const crown = 0.07 * (1 - (lateral / ROAD.half) ** 2);
    car.vis.root.position.copy(f.pos).addScaledVector(f.right, lateral).addScaledVector(f.up, crown);
    const forward = blocking ? f.right : f.fwd;
    this._x.crossVectors(f.up, forward).normalize();
    this._m.makeBasis(this._x, f.up, forward);
    car.vis.root.quaternion.setFromRotationMatrix(this._m);
    const on = Math.floor(time * 8) % 2 === 0;
    car.red.emissiveIntensity = on ? 7 : 0.2;
    car.blue.emissiveIntensity = on ? 0.2 : 7;
  }

  private repairValue(pct: number) { return Math.ceil(pct / 10 - 1e-6) * this.repairPrice; }

  /** Цена ремонта на pct процентов (с КАСКО — бесплатно). */
  repairCost(pct: number) {
    return this.insurance.kasko ? 0 : this.repairValue(pct);
  }

  /** Расход заряда на км с учётом скорости: выше 90 км/ч — дороже. */
  get chargePerKm() {
    return CHARGE_PER_KM + Math.max(0, this.v * 3.6 - 90) * 0.02;
  }

  /** Цена ремонта за 10 % с учётом года: с каждым годом дороже. */
  get repairPrice() {
    return REPAIR_PRICE + (this.yearNo - 1);
  }

  /** Цена зарядки на pct процентов в автосервисе. */
  chargeCost(pct: number) { return Math.ceil(pct / 10 - 1e-6) * CHARGE_PRICE; }

  /** Зарядить батарею до pct процентов (шагами по 10 %, сколько хватит монет). Возвращает добавленные %. */
  charge(pct: number): number {
    let want = Math.min(pct, 100 - this.fuel);
    if (want <= 0) return 0;
    want = Math.min(want, Math.floor(this.coins / CHARGE_PRICE) * 10);
    if (want <= 0) return 0;
    const value = this.chargeCost(want);
    this.coins -= value;
    this.payouts.ownService += value;
    this.fuel = Math.min(100, this.fuel + want);
    return want;
  }

  /** Отремонтировать до pct процентов (шагами по 10 %, сколько хватит монет). Возвращает восстановленные %. */
  repair(pct: number): number {
    let want = Math.min(pct, 100 - this.health);
    if (want <= 0) return 0;
    if (!this.insurance.kasko) want = Math.min(want, Math.floor(this.coins / this.repairPrice) * 10);
    if (want <= 0) return 0;
    const value = this.repairValue(want);
    if (this.insurance.kasko) {
      this.payouts.kasko += value;
      this.kaskoRepairUsed = true;
    } else {
      this.coins -= value;
      this.payouts.ownService += value;
    }
    this.health = Math.min(100, this.health + want);
    return want;
  }

  get assistanceCost() { return this.insurance.kasko ? 0 : ROADSIDE_ASSISTANCE_PRICE; }

  get assistanceMinimumCost() {
    return this.assistanceCost + this.repairCost(10);
  }

  get assistanceDestination() { return this.world.path.nearestExit(this.s); }

  /** Эвакуация не добавляет километраж и сохраняет состояние машины. */
  towToService(): boolean {
    if (this.phase !== 'stopped' || this.endReason !== 'wreck' || this.coins < this.assistanceMinimumCost) return false;
    const exit = this.assistanceDestination;
    if (this.insurance.kasko) {
      this.payouts.kasko += ROADSIDE_ASSISTANCE_PRICE;
      this.kaskoRepairUsed = true;
    } else {
      this.coins -= ROADSIDE_ASSISTANCE_PRICE;
      this.payouts.ownService += ROADSIDE_ASSISTANCE_PRICE;
    }
    this.pitExit = exit;
    this.s = exit.sStop;
    this.lane = 2;
    this.d = this.laneOffset();
    this.v = this.dv = 0;
    this.phase = 'refuel';
    this.placeCar(0);
    this.world.prime(this.s, this.car.root.position);
    this.traffic.populate(this.playerState(), this.odometer);
    this.updateSun();
    this.snapCamera();
    this.updateFar(0);
    this.onStation?.(exit.kind);
    return true;
  }

  /** Уехать от колонки/сервиса. */
  leaveStation() {
    if (this.phase !== 'refuel' || this.fuel <= 0 || this.health <= 0) return false;
    this.endReason = null;
    this.phase = 'pitOut';
    return true;
  }

  /** Можно ли сейчас перестроиться на съезд (полоса открыта впереди). */
  get exitOpen() {
    const p = this.world.path;
    return p.extraAt(this.s + 40) > EXIT_W * 0.8 && p.extraAt(this.s + 90) > EXIT_W * 0.8;
  }

  /** Расстояние до ближайшей колонки впереди, м. */
  get nextServiceDist() { return this.world.path.nextExit(this.s).sStop - this.s; }
  get nextExitStartDist() { return this.world.path.nextExit(this.s).s0 - this.s; }
  get nextExitKind(): ExitKind { return this.world.path.nextExit(this.s).kind; }

  private playerState(): PlayerState {
    const p = this.player;
    p.s = this.s; p.v = this.v; p.d = this.d; p.lane = this.lane;
    p.mergeLane = this.leavingStop && this.lane === 1 ? 1 : undefined;
    return p;
  }

  /** Удар о машину трафика: потеря скорости, отброс, встряска. */
  private crash(e: CrashEvent) {
    if (this.phase !== 'drive' && this.phase !== 'pitOut' && this.phase !== 'policeOut') return;
    this.crashes++;
    if (this.chase.active) this.chaseCrashes++;
    this.shakeAmp = 0.35 + e.severity * 0.65;
    this.pitchV += (e.side ? 0 : 0.5) * e.severity;
    this.rollV += (e.side ? 0.9 : 0.25) * (Math.random() - 0.5) * 2;
    const ownDamage = Math.min(this.health, Math.round(e.side ? 12 + 10 * e.severity : 12 + 23 * e.severity));
    this.health -= ownDamage;
    const thirdPartyDamage = Math.round(e.side ? 4 + 10 * e.severity : 5 + 25 * e.severity);
    const covered = this.insurance.osago;
    const paidToVictim = covered ? thirdPartyDamage : Math.min(this.coins, thirdPartyDamage);
    if (covered) this.payouts.osago += paidToVictim;
    else {
      this.coins -= paidToVictim;
      this.payouts.ownVictims += paidToVictim;
    }
    this.onDamage?.({ ownDamage, thirdPartyDamage, paidToVictim, covered });
    this.onCrash?.(e);
  }

  private applyCamera(time: number) {
    const p = this.car.root.position;
    // камера немного отстаёт по поперечному смещению машины
    this.camera.position.copy(p).add(this.camOffset);
    const shake = smoothstep(35, 58, this.v) * 0.012 + this.shakeAmp * 0.08
      + this.shoulderRoughness * smoothstep(0, SHOULDER_SPEED, this.v) * 0.014;
    this.camera.position.y += Math.sin(time * 23.1) * shake + Math.sin(time * 31.7) * shake * 0.6;
    this.camera.position.x += Math.sin(time * 19.3) * shake * 0.5;
    this.camera.lookAt(this._look.copy(p).add(this.camLook));
  }

  resize(aspect: number, previewLeft?: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (this.previewing) {
      this.previewLeft = previewLeft;
      this.frameRoadPreview();
    }
  }

  /** Освобождает ресурсы сцены: выгрузка страницы или пересоздание заезда. */
  dispose() {
    this.world.dispose();
    disposeObject(this.scene);
    this.scene.clear();
    this.waterNormal.dispose();
  }
}
