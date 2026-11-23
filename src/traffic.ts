import * as THREE from 'three';
import { RoadPath, RoadFrame } from './road';
import { ROAD } from './textures';
import { TrafficAssets, TrafficKind, TrafficVisual } from './traffic-models';
import { clamp, mulberry32 } from './noise';

const LANE = ROAD.laneWidth;
const SPAWN_MIN = 520, SPAWN_MAX = 820;   // впереди, за пределами чёткой видимости
const DESPAWN_BEHIND = 160, DESPAWN_AHEAD = 1100;

export interface PlayerState {
  s: number; v: number; d: number; lane: number; length: number; width: number;
}

class Vehicle {
  s = 0; v = 0; v0 = 0;
  lane = 0; d = 0; dv = 0;
  targetLane = 0;
  blinker = 0;        // -1/0/+1
  blinkT = 0;         // время с включения поворотника
  cooldown = 0;
  braking = false;
  spin = 0;
  roll = 0;
  latAcc = 0;
  lean = 0;
  constructor(readonly kind: TrafficKind, readonly vis: TrafficVisual) {}
  get length() { return this.vis.template.length; }
  get width() { return this.vis.template.width; }
  /** Полосы, которые машина занимает сейчас (во время перестроения — две). */
  occupies(l: number) {
    return this.lane === l || this.targetLane === l || Math.abs(this.d - l * LANE) < LANE * 0.75;
  }
}

export interface CrashEvent { severity: number; side: boolean; }

export class Traffic {
  readonly group = new THREE.Group();
  private list: Vehicle[] = [];
  private pool: Record<TrafficKind, TrafficVisual[]> = { sedan: [], truck: [], moto: [], van: [], tiller: [], tow: [], limo: [], classic: [] };
  /** Сбитые мотоциклы: летят по баллистике с кувырком в сторону от трассы, потом исчезают. */
  private flying: { v: Vehicle; s: number; d: number; h: number; vs: number; vd: number; vh: number; t: number; rot: THREE.Euler; w: THREE.Vector3 }[] = [];
  private rnd = mulberry32(4242);
  private frame: RoadFrame;
  private spawnTimer = 0;
  private crashCooldown = 0;
  onCrash?: (e: CrashEvent) => void;

  constructor(private path: RoadPath, readonly assets: TrafficAssets) {
    this.group.name = 'traffic';
    this.frame = path.frame(0);
  }

  get count() { return this.list.length; }
  /** Для проверок: машины трафика (только чтение). */
  get vehicles(): readonly { s: number; d: number; v: number; lane: number; length: number; width: number; kind: TrafficKind }[] { return this.list; }

  clear() {
    for (const v of this.list) this.release(v);
    for (const f of this.flying) this.release(f.v);
    this.list = [];
    this.flying = [];
  }

  /** Плотность растёт с пройденным расстоянием: от ~11 до ~22 машин в зоне. */
  private targetCount(odo: number) { return Math.round(clamp(11 + odo / 500, 11, 22)); }

  private acquire(kind: TrafficKind) {
    const vis = this.pool[kind].pop() ?? this.assets.create(kind);
    this.group.add(vis.root);
    return vis;
  }

  private release(v: Vehicle) {
    v.vis.root.removeFromParent();
    this.pool[v.kind].push(v.vis);
  }

  /** Заполнить дорогу сразу (старт заезда): машины впереди на разных дистанциях. */
  populate(p: PlayerState, odo: number) {
    this.clear();
    const n = this.targetCount(odo);
    for (let i = 0; i < n * 3 && this.list.length < n; i++) {
      // половина — близко, чтобы дорога не выглядела пустой с первых секунд
      const near = this.list.length < n / 2;
      this.trySpawn(p, p.s + (near ? 70 + this.rnd() * 280 : 350 + this.rnd() * (SPAWN_MAX - 350)));
    }
  }

  /** Для снимков: поставить машину в конкретное место. */
  debugPlace(kind: TrafficKind, s: number, lane: number, kmh: number) {
    const v = new Vehicle(kind, this.acquire(kind));
    v.s = s; v.lane = v.targetLane = lane; v.d = lane * LANE;
    v.v0 = v.v = kmh / 3.6;
    v.cooldown = 999;
    this.list.push(v);
    this.place(v, 0, 0);
  }

  private laneFree(lane: number, s: number, gapAhead: number, gapBehind: number, p: PlayerState, except?: Vehicle) {
    for (const o of this.list) {
      if (o === except || !o.occupies(lane)) continue;
      const ds = o.s - s;
      if (ds > -gapBehind && ds < gapAhead) return false;
    }
    if (Math.abs(p.d - lane * LANE) < LANE * 0.6) {
      const ds = p.s - s;
      if (ds > -gapBehind && ds < gapAhead) return false;
    }
    return true;
  }

  /** Не допускаем «стены»: в окне ±win по s хотя бы одна полоса должна оставаться свободной. */
  private wouldBlockAll(lane: number, s: number, win: number, except?: Vehicle) {
    const used = new Set<number>([lane]);
    for (const o of this.list) {
      if (o === except || Math.abs(o.s - s) > win) continue;
      used.add(o.lane);
      used.add(o.targetLane);
    }
    return used.size >= 3;
  }

  private trySpawn(p: PlayerState, s: number) {
    const r = this.rnd();
    const ahead = s > p.s;
    const tow = ahead && r < 0.015 && !this.list.some((o) => o.kind === 'tow');
    const limo = ahead && r >= 0.36 && r < 0.39 && !this.list.some((o) => o.kind === 'limo');
    const kind: TrafficKind = tow ? 'tow' : limo ? 'limo' : r < 0.22 ? 'truck' : r < 0.36 ? 'van' : r >= 0.39 && r < 0.51 ? 'classic' : 'sedan';
    // Крупные машины появляются в правой и средней полосах, легковые — по всей трассе.
    const truck = kind === 'truck' || tow;
    const lanes = truck || limo ? [1, 1, 0] : [-1, 0, 0, 1, 1];
    const lane = lanes[Math.floor(this.rnd() * lanes.length)];
    const gap = limo ? 55 : 45;
    if (!this.laneFree(lane, s, gap, gap, p)) return false;
    if (this.wouldBlockAll(lane, s, 40)) return false;
    const v = new Vehicle(kind, this.acquire(kind));
    v.s = s;
    v.lane = v.targetLane = lane;
    v.d = lane * LANE;
    // желаемая скорость: левее — быстрее; грузовики медленнее
    const base = truck ? (tow ? 65 : 72) + this.rnd() * 14
      : [102, 88, 76][lane + 1] + (this.rnd() - 0.5) * 18 - (kind === 'classic' ? 9 : kind === 'van' || limo ? 5 : 0);
    v.v0 = v.v = base / 3.6;
    v.cooldown = 3 + this.rnd() * 5;
    this.list.push(v);
    this.place(v, 0, 0);
    return true;
  }

  update(dt: number, p: PlayerState, odo: number, time: number) {
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);
    // выгрузка далёких
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i];
      if (v.s < p.s - DESPAWN_BEHIND || v.s > p.s + DESPAWN_AHEAD) { this.release(v); this.list.splice(i, 1); }
    }
    // появление новых впереди (и изредка сзади, если игрок медленный)
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.list.length < this.targetCount(odo)) {
      this.spawnTimer = 0.25;
      if (p.v < 19 && this.rnd() < 0.35) this.trySpawn(p, p.s - 140 - this.rnd() * 30);
      else this.trySpawn(p, p.s + SPAWN_MIN + this.rnd() * (SPAWN_MAX - SPAWN_MIN));
    }

    this.list.sort((a, b) => a.s - b.s);
    for (const v of this.list) this.drive(v, dt, p);
    for (const v of this.list) this.place(v, dt, time);
    this.updateFlying(dt, p);
    this.collide(p);
  }

  /** Ближайший впереди в полосе lane: дистанция (между бамперами) и скорость. */
  private leader(v: Vehicle, lane: number, p: PlayerState): { gap: number; v: number } {
    let gap = Infinity, lv = 0;
    for (const o of this.list) {
      if (o === v || o.s <= v.s || !o.occupies(lane)) continue;
      const g = o.s - v.s - (o.length + v.length) / 2;
      if (g < gap) { gap = g; lv = o.v; }
    }
    if (p.s > v.s && Math.abs(p.d - lane * LANE) < LANE * 0.6) {
      const g = p.s - v.s - (p.length + v.length) / 2;
      if (g < gap) { gap = g; lv = p.v; }
    }
    return { gap, v: lv };
  }

  /** Модель следования IDM + решения о перестроении. */
  private drive(v: Vehicle, dt: number, p: PlayerState) {
    const truck = v.kind === 'truck' || v.kind === 'tow', moto = v.kind === 'moto';
    const tiller = v.kind === 'tiller';
    const long = truck || v.kind === 'limo';
    const aMax = tiller ? 0.4 : truck ? 0.9 : moto ? 2.6 : 1.6, bComf = truck || tiller ? 1.8 : moto ? 3.2 : 2.6;
    const s0 = long ? 9 : moto ? 4 : 6, T = long ? 1.8 : moto ? 0.9 : 1.3;
    const idm = (gap: number, lv: number) => {
      const dvl = v.v - lv;
      const sStar = s0 + Math.max(0, v.v * T + (v.v * dvl) / (2 * Math.sqrt(aMax * bComf)));
      const free = 1 - Math.pow(v.v / v.v0, 4);
      const inter = gap === Infinity ? 0 : (sStar / Math.max(gap, 0.5)) ** 2;
      return aMax * (free - inter);
    };
    const cur = this.leader(v, v.lane, p);
    let a = idm(cur.gap, cur.v);
    if (v.targetLane !== v.lane) a = Math.min(a, idm(this.leader(v, v.targetLane, p).gap, this.leader(v, v.targetLane, p).v));
    // не перекрывать последнюю свободную полосу: если обе соседние заняты рядом впереди — пропустить их
    {
      let busy = 0;
      for (const l of [-1, 0, 1]) {
        if (l === v.lane) continue;
        if (this.list.some((o) => o !== v && o.occupies(l) && o.s > v.s - 3 && o.s < v.s + o.length / 2 + v.length / 2 + 6)) busy++;
      }
      if (busy >= 2) a = Math.min(a, -1.8);
    }
    a = clamp(a, -8, aMax);
    if (tiller) a = Math.min(a, (v.v0 - v.v) * 2);    // не быстрее 30 км/ч даже после толчка
    v.braking = a < -0.9;
    v.v = Math.max(0, v.v + a * dt);
    v.s += v.v * dt;

    // перестроение
    v.cooldown -= dt;
    if (v.blinker !== 0) {
      v.blinkT += dt;
      if (v.targetLane === v.lane && v.blinkT > 1.3) {
        const to = v.lane + v.blinker;
        // повторная проверка перед манёвром
        if (this.laneFree(to, v.s, 25, 22, p, v) && !this.wouldBlockAll(to, v.s, 30, v)) v.targetLane = to;
        else { v.blinker = 0; v.cooldown = 4; }
      }
      if (v.targetLane !== v.lane && Math.abs(v.d - v.targetLane * LANE) < 0.25) {
        v.lane = v.targetLane;
        v.blinker = 0;
        v.cooldown = 6 + this.rnd() * 8;
      }
    } else if (v.cooldown <= 0) {
      v.cooldown = 1.5;
      const slowAhead = cur.gap < 70 && cur.v < v.v0 - 2.5;
      const options: number[] = [];
      if (slowAhead) options.push(v.lane - 1, v.lane + 1);          // обгон
      else if (this.rnd() < 0.25) options.push(v.lane + 1);          // вернуться правее
      for (const to of options) {
        if (to < -1 || to > 1) continue;
        if (truck && to < 0) continue;
        const lead = this.leader(v, to, p);
        if (slowAhead && lead.gap < cur.gap + 15) continue;
        if (!this.laneFree(to, v.s, 30, 28, p, v) || this.wouldBlockAll(to, v.s, 30, v)) continue;
        v.blinker = Math.sign(to - v.lane);
        v.blinkT = 0;
        break;
      }
    }
    // плавное смещение к полосе (перестроение ~3 c у легковых, ~4.5 c у грузовиков)
    const w = long ? 1.0 : moto ? 2.1 : 1.4;
    const target = v.targetLane * LANE;
    const acc = w * w * (target - v.d) - 2 * w * v.dv;
    v.dv += acc * dt;
    v.d += v.dv * dt;
    v.roll = clamp(-acc * (truck ? 0.012 : 0.008), -0.05, 0.05);
    v.latAcc = acc;
  }

  private _m = new THREE.Matrix4();
  private _x = new THREE.Vector3();
  private _f = new THREE.Vector3();

  private place(v: Vehicle, dt: number, time: number) {
    const f = this.path.frame(v.s, this.frame);
    const crown = 0.07 * (1 - Math.min(1, (v.d / ROAD.half) ** 2));
    const root = v.vis.root;
    root.position.copy(f.pos).addScaledVector(f.right, v.d).addScaledVector(f.up, crown);
    const yaw = Math.atan2(v.dv, Math.max(v.v, 3));
    this._f.copy(f.fwd).applyAxisAngle(f.up, -yaw);
    this._x.crossVectors(f.up, this._f).normalize();
    this._m.makeBasis(this._x, f.up, this._f);
    root.quaternion.setFromRotationMatrix(this._m);
    if (v.kind === 'moto') {
      // мотоцикл наклоняется внутрь поворота/перестроения: tg(наклона) = боковое ускорение / g
      const lat = v.latAcc - v.v * v.v * f.curvature;
      const target = clamp(Math.atan2(lat, 9.81), -0.55, 0.55);
      v.lean += (target - v.lean) * Math.min(1, dt * 6);
      v.vis.body.rotation.z = v.lean;
    } else v.vis.body.rotation.z = v.roll;
    v.vis.body.rotation.x = v.braking ? 0.008 : 0;
    v.spin += (v.v * dt) / v.vis.template.wheelR;
    for (const a of v.vis.axles) a.rotation.x = v.spin;
    const assets = this.assets;
    v.vis.tail.material = v.braking ? assets.tailOn : assets.tailOff;
    const on = v.blinker !== 0 && Math.floor(time * 3) % 2 === 0;
    v.vis.blinkL.material = on && v.blinker < 0 ? assets.blinkOn : assets.blinkOff;
    v.vis.blinkR.material = on && v.blinker > 0 ? assets.blinkOn : assets.blinkOff;
  }

  /** Столкновения игрока с трафиком в координатах дороги (s, d). */
  private collide(p: PlayerState) {
    if (this.crashCooldown > 0) return;
    for (const v of this.list) {
      const ds = v.s - p.s, dd = v.d - p.d;
      const ox = (v.length + p.length) / 2 - Math.abs(ds);
      const oy = (v.width + p.width) / 2 - 0.12 - Math.abs(dd);
      if (ox <= 0 || oy <= 0) continue;
      const side = oy < ox * 0.6;
      if (v.kind === 'moto') { this.knockOff(v, p); this.onCrash?.({ severity: 0.2, side }); this.crashCooldown = 0.6; return; }
      const severity = side ? 0.35 : clamp(Math.abs(p.v - v.v) / 15, 0.25, 1);
      this.crashCooldown = 1.0;
      // удар передаёт немного скорости машине трафика
      if (!side && ds > 0) v.v = Math.min(v.v0 + 3, v.v + (p.v - v.v) * 0.35);
      this.onCrash?.({ severity, side });
      return;
    }
  }

  /** Сбить мотоцикл: снять с потока и отправить в полёт с кувырком прочь от трассы. */
  private knockOff(v: Vehicle, p: PlayerState) {
    this.list.splice(this.list.indexOf(v), 1);
    const away = Math.abs(v.d - p.d) > 0.3 ? Math.sign(v.d - p.d) : v.d >= 0 ? 1 : -1;   // в сторону ближайшей обочины
    const push = Math.max(6, Math.abs(p.v - v.v));
    const r = () => this.rnd() - 0.5;
    this.flying.push({
      v, s: v.s, d: v.d, h: 0,
      // вперёд — быстрее машины игрока (летит перед капотом, его видно), вбок — ровно за обочину
      vs: p.v + 3 + push * 0.3, vd: away * (ROAD.half + 3 + this.rnd() * 4 - away * v.d) / 1.7, vh: 6 + this.rnd() * 1.5,
      t: 0, rot: new THREE.Euler(0, 0, v.lean, 'YXZ'),
      w: new THREE.Vector3(r() * 9 - 3, r() * 6, away * (5 + this.rnd() * 5)),
    });
  }

  private _q = new THREE.Quaternion();
  private updateFlying(dt: number, p: PlayerState) {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.t += dt;
      f.vh -= 9.81 * dt;
      f.s += f.vs * dt; f.d += f.vd * dt; f.h += f.vh * dt;
      if (f.h <= 0) {                                  // удар о землю: отскок и трение, кувырок затухает
        f.h = 0;
        if (f.vh < -2) { f.vh *= -0.32; f.w.multiplyScalar(0.55); } else { f.vh = 0; f.w.multiplyScalar(Math.max(0, 1 - dt * 5)); }
        const k = Math.max(0, 1 - dt * 2.5);
        f.vs *= k; f.vd *= k;
      }
      f.rot.x += f.w.x * dt; f.rot.y += f.w.y * dt; f.rot.z += f.w.z * dt;
      const fr = this.path.frame(f.s, this.frame);
      const root = f.v.vis.root;
      root.position.copy(fr.pos).addScaledVector(fr.right, f.d).addScaledVector(fr.up, f.h);
      this._x.crossVectors(fr.up, fr.fwd).normalize();
      this._m.makeBasis(this._x, fr.up, fr.fwd);
      root.quaternion.setFromRotationMatrix(this._m).multiply(this._q.setFromEuler(f.rot));
      f.v.vis.body.rotation.set(0, 0, 0);
      f.v.vis.blinkL.material = f.v.vis.blinkR.material = this.assets.blinkOff;
      if (f.t > 9 || f.s < p.s - DESPAWN_BEHIND) { this.release(f.v); this.flying.splice(i, 1); }
    }
  }

  /** Расталкивание после удара: возвращает поправку для игрока. */
  resolve(p: PlayerState): { ds: number; v: number | null; lane: number | null } {
    for (const v of this.list) {
      const ds = v.s - p.s, dd = v.d - p.d;
      const ox = (v.length + p.length) / 2 - Math.abs(ds);
      const oy = (v.width + p.width) / 2 - 0.12 - Math.abs(dd);
      if (ox <= 0 || oy <= 0) continue;
      if (oy < ox * 0.6) {
        // боковой контакт — отбрасывает обратно в свою полосу
        const back = Math.round(p.d / LANE) - Math.sign(dd);
        return { ds: 0, v: p.v * 0.85, lane: clamp(back, -1, 1) };
      }
      if (ds > 0) return { ds: -ox - 0.3, v: Math.max(0, v.v - 3), lane: null };
      return { ds: ox + 0.3, v: v.v + 2, lane: null };
    }
    return { ds: 0, v: null, lane: null };
  }
}
