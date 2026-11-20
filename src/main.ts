import * as THREE from 'three';
import './style.css';
import cars from './cars.json';
import { Renderer, detectQuality, QualityName } from './render';
import { buildCar, CarConfig, CarModel } from './car';
import { buildKedr } from './car-kedr';
import { TrafficAssets } from './traffic-models';
import { GarageScene } from './garage';
import { DriveScene } from './drive';
import { Input } from './input';

type State = 'loading' | 'garage' | 'drive' | 'pause' | 'station' | 'over';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // служебный режим для автоматических снимков
if (SHOT) document.documentElement.classList.add('shot');

const screens = ['loading', 'garage', 'hud', 'pause', 'station', 'over'] as const;
function show(...ids: string[]) {
  for (const s of screens) $(s).classList.toggle('show', ids.includes(s));
}
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function loadBar(p: number, text?: string) {
  $('loadbar').style.width = `${Math.round(p * 100)}%`;
  if (text) $('loadtext').textContent = text;
}

function getRecord(): number {
  try { return Number(localStorage.getItem('doroga.best') || 0); } catch { return 0; }
}
function setRecord(km: number) {
  try { localStorage.setItem('doroga.best', String(km)); } catch { /* нет хранилища */ }
}

async function main() {
  const canvas = $<HTMLCanvasElement>('gl');
  const quality: QualityName = detectQuality();
  const renderer = new Renderer(canvas, quality);
  const pmrem = new THREE.PMREMGenerator(renderer.gl);
  loadBar(0.1, 'Собираем машину…');
  await nextFrame();

  const configs = cars as CarConfig[];
  const models: CarModel[] = configs.map((c) => (c.body === 'suv' ? buildKedr(c) : buildCar(c)));
  let sel = 0;
  try {
    const saved = localStorage.getItem('doroga.car');
    const i = configs.findIndex((c) => c.id === saved);
    if (i >= 0) sel = i;
  } catch { /* нет хранилища */ }
  const qCar = params.get('car');
  if (qCar) sel = Math.max(0, configs.findIndex((c) => c.id === qCar));
  let cfg = configs[sel];
  let car: CarModel = models[sel];
  const garage = new GarageScene(pmrem, document.body);
  garage.attachCar(car);
  loadBar(0.35, 'Прокладываем трассу…');
  await nextFrame();

  const drive = new DriveScene(pmrem, renderer.quality.textureSize, renderer.anisotropy, Number(params.get('seed') || 1337));
  drive.setShadowMapSize(renderer.quality.shadowMap);
  loadBar(0.8, 'Прогреваем шейдеры…');
  await nextFrame();

  // UI гаража
  const statNames: [keyof CarConfig['stats'], string][] = [['speed', 'Скорость'], ['accel', 'Разгон'], ['handling', 'Управление'], ['brakes', 'Тормоза']];
  const SLOTS = 3;
  const renderCard = () => {
    $('carEyebrow').textContent = `Гараж · машина ${sel + 1} из ${configs.length}`;
    $('carName').textContent = cfg.name;
    $('carTag').textContent = cfg.tagline;
    $('carTank').textContent = `Бак ${cfg.tankL} л · расход ${DriveScene.LITERS_PER_KM} л/км · запас хода ${Math.round(cfg.tankL / DriveScene.LITERS_PER_KM)} км`;
    $('carStats').innerHTML = statNames.map(([k, n]) =>
      `<li>${n}<span class="b"><i style="width:${cfg.stats[k] * 100}%"></i></span><em>${Math.round(cfg.stats[k] * 100)}</em></li>`).join('');
    const slots = configs.map((c, i) =>
      `<button class="slot${i === sel ? ' active' : ''}" data-i="${i}" aria-label="${c.name}"><span class="sw" style="background:${c.color}"></span><span class="nm">${c.name}</span></button>`);
    for (let i = configs.length; i < SLOTS; i++) slots.push('<button class="slot locked" disabled><span>Скоро</span></button>');
    $('slots').innerHTML = slots.join('');
  };
  const selectCar = (i: number) => {
    i = (i + configs.length) % configs.length;
    if (i === sel && car === models[i]) return;
    sel = i; cfg = configs[i]; car = models[i];
    try { localStorage.setItem('doroga.car', cfg.id); } catch { /* нет хранилища */ }
    garage.attachCar(car);
    renderCard();
  };
  renderCard();
  $('slots').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-i]') as HTMLElement | null;
    if (b) selectCar(Number(b.dataset.i));
  });
  const updateRecord = () => {
    const r = getRecord();
    $('record').textContent = r > 0 ? `Рекорд: ${r.toFixed(1)} км` : '';
  };
  updateRecord();

  const input = new Input($('touch'), $('pedGas'), $('pedBrake'));
  let state: State = 'loading';
  const clock = new THREE.Timer();
  clock.connect(document);
  let time = 0;
  let hintTimer = 0;

  const resize = () => {
    renderer.resize();
    garage.resize(innerWidth / innerHeight);
    drive.resize(innerWidth / innerHeight);
    $('rotate').classList.toggle('show', state === 'drive' && innerHeight > innerWidth);
  };
  addEventListener('resize', resize);
  resize();

  const fade = async (on: boolean) => {
    $('fade').classList.toggle('on', on);
    await sleep(SHOT ? 0 : 620);
  };

  const enterGarage = () => {
    garage.attachCar(car);
    renderer.setExposure(1.0);
    renderer.setBloom(0.22, 3.0, 0.4);
    renderer.setVignette(0.45);
    input.enabled = false;
    state = 'garage';
    updateRecord();
    show('garage');
  };

  const startDrive = async (skipIntro = false, startS = 30) => {
    input.enabled = false;
    await fade(true);
    drive.attachCar(car, cfg);
    drive.insurance = { ...ins };
    drive.reset(skipIntro, startS);
    renderer.setExposure(0.6);
    renderer.setBloom(0.18, 4.5, 0.35);
    renderer.setVignette(0.3);
    state = 'drive';
    show('hud');
    $('ctrlHint').classList.remove('hide');
    hintTimer = 0;
    clock.update();
    await fade(false);
  };

  const finishRun = () => {
    const km = drive.odometer / 1000;
    if (km > getRecord()) setRecord(Math.round(km * 10) / 10);
  };

  const pause = () => {
    if (state !== 'drive') return;
    state = 'pause';
    input.enabled = false;
    show('hud', 'pause');
    markQuality();
  };
  const resume = () => {
    if (state !== 'pause') return;
    state = 'drive';
    input.clear();
    input.enabled = drive.phase === 'drive';
    show('hud');
    clock.update();
  };
  input.onPause = () => (state === 'drive' ? pause() : resume());
  input.onCamera = () => drive.toggleCamera();

  // ——— страховки (покупаются перед заездом из стартовых монет) ———
  const ins = { kasko: false, osago: false };
  try { Object.assign(ins, JSON.parse(localStorage.getItem('doroga.ins') || '{}')); } catch { /* нет хранилища */ }
  const renderIns = () => {
    $('insKasko').classList.toggle('on', ins.kasko);
    $('insOsago').classList.toggle('on', ins.osago);
    $('startCoins').textContent = String(DriveScene.START_COINS - (ins.kasko ? DriveScene.KASKO : 0) - (ins.osago ? DriveScene.OSAGO : 0));
    try { localStorage.setItem('doroga.ins', JSON.stringify(ins)); } catch { /* нет хранилища */ }
  };
  $('insKasko').addEventListener('click', () => { ins.kasko = !ins.kasko; renderIns(); });
  $('insOsago').addEventListener('click', () => { ins.osago = !ins.osago; renderIns(); });
  renderIns();

  // ——— заправка и автосервис: одна панель ———
  const updateStation = () => {
    const repair = drive.stationKind === 'repair';
    const full = $<HTMLButtonElement>('stFull'), ten = $<HTMLButtonElement>('stTen');
    $('stCoins').textContent = String(drive.coins);
    if (!repair) {
      $('stEyebrow').textContent = 'Заправка «Топливо 24»';
      $('stTitle').textContent = 'Заправиться?';
      $('stTank').textContent = String(Math.ceil(drive.fuel - 1e-6));
      $('stUnit').textContent = `/ ${drive.tank} л`;
      $('stTankBar').style.width = `${(drive.fuel / drive.tank) * 100}%`;
      $('stBarWrap').classList.remove('hp');
      $('stPrice').textContent = '1 монета за литр';
      const need = Math.ceil(drive.tank - drive.fuel - 1e-6);
      const can = Math.min(need, Math.floor(drive.coins / DriveScene.PRICE));
      full.disabled = can <= 0;
      full.textContent = can <= 0 ? (need <= 0 ? 'Бак полный' : 'Не хватает монет')
        : can < need ? `На все монеты · ${can} л` : `Полный бак · ${need} л за ${need * DriveScene.PRICE}`;
      ten.disabled = can <= 0;
      ten.textContent = '+10 л · 10 монет';
      ten.style.display = can > 10 ? '' : 'none';
    } else {
      $('stEyebrow').textContent = 'Автосервис';
      $('stTitle').textContent = 'Отремонтировать?';
      $('stTank').textContent = String(Math.round(drive.health));
      $('stUnit').textContent = '%';
      $('stTankBar').style.width = `${drive.health}%`;
      $('stBarWrap').classList.add('hp');
      const kasko = drive.insurance.kasko;
      $('stPrice').textContent = kasko ? 'по КАСКО — бесплатно' : '1 монета за 10 %';
      const need = Math.max(0, 100 - drive.health);
      const canPct = kasko ? need : Math.min(need, Math.floor(drive.coins / DriveScene.REPAIR_PRICE) * 10);
      full.disabled = canPct <= 0;
      full.textContent = need <= 0 ? 'Машина целая'
        : canPct <= 0 ? 'Не хватает монет'
          : canPct < need ? `На все монеты · +${canPct} %`
            : `Полный ремонт · ${kasko ? 'бесплатно' : `${drive.repairCost(need)} монет`}`;
      ten.disabled = canPct <= 0;
      ten.textContent = `+10 % · ${kasko ? 'бесплатно' : `${DriveScene.REPAIR_PRICE} монета`}`;
      ten.style.display = need > 10 && canPct > 0 ? '' : 'none';
    }
  };
  drive.onStation = () => {
    state = 'station';
    input.enabled = false;
    updateStation();
    show('hud', 'station');
  };
  $('stFull').addEventListener('click', () => {
    if (drive.stationKind === 'repair') drive.repair(100); else drive.refuel(drive.tank);
    updateStation();
  });
  $('stTen').addEventListener('click', () => {
    if (drive.stationKind === 'repair') drive.repair(10); else drive.refuel(10);
    updateStation();
  });
  // ——— удары: здоровье и ОСАГО ———
  let toastTimer = 0;
  drive.onDamage = ({ damage, fine, covered }) => {
    const t = $('toast');
    t.innerHTML = `−${damage} % здоровья` + (covered ? ' · ущерб покрыло ОСАГО' : fine > 0 ? ` · ущерб другой машине <span class="coin"></span>−${fine}` : '');
    t.classList.toggle('ok', covered);
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.classList.remove('on'), 2600);
  };
  $('stLeave').addEventListener('click', () => {
    if (state !== 'station') return;
    drive.leaveStation();
    if (state !== 'station') return; // уже конец заезда
    state = 'drive';
    input.clear();
    input.enabled = true;
    show('hud');
  });
  // ——— бак пуст ———
  drive.onEmpty = () => {
    finishRun();
    state = 'over';
    input.enabled = false;
    $('ovTitle').textContent = drive.endReason === 'wreck' ? 'Машина разбита' : 'Топливо кончилось';
    $('ovKm').textContent = `${(drive.odometer / 1000).toFixed(1)} км`;
    $('ovCoins').textContent = String(drive.coins);
    $('ovBest').textContent = `${getRecord().toFixed(1)} км`;
    show('hud', 'over');
  };
  $('ovAgain').addEventListener('click', () => { if (state === 'over') startDrive(); });
  $('ovGarage').addEventListener('click', async () => {
    if (state !== 'over') return;
    await fade(true);
    enterGarage();
    await fade(false);
  });
  drive.onCrash = (e) => {
    const hit = $('hit');
    hit.style.setProperty('--k', String(e.severity));
    hit.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => hit.classList.remove('on')));
    if (navigator.vibrate) navigator.vibrate(e.side ? 60 : 120);
  };
  addEventListener('keydown', (e) => {
    if (state === 'pause' && (e.code === 'Escape' || e.code === 'KeyP')) resume();
    if (state === 'station') {
      if (e.code === 'Enter') $('stFull').click();
      if (e.code === 'Escape' || e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') $('stLeave').click();
    }
    if (state === 'over' && e.code === 'Enter') $('ovAgain').click();
    if (state === 'garage' && (e.code === 'Enter' || e.code === 'Space')) $('go').click();
    if (state === 'garage' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) selectCar(sel + (e.code === 'ArrowLeft' ? -1 : 1));
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  $('go').addEventListener('click', () => { if (state === 'garage') startDrive(); });
  $('pauseBtn').addEventListener('click', pause);
  $('resume').addEventListener('click', resume);
  $('restart').addEventListener('click', async () => { finishRun(); await startDrive(); });
  $('toGarage').addEventListener('click', async () => {
    finishRun();
    await fade(true);
    enterGarage();
    await fade(false);
  });

  const markQuality = () => {
    for (const b of $('qualitySeg').querySelectorAll('button')) {
      b.classList.toggle('on', (b as HTMLElement).dataset.q === renderer.quality.name);
    }
  };
  $('qualitySeg').addEventListener('click', (e) => {
    const q = (e.target as HTMLElement).dataset.q as QualityName | undefined;
    if (!q) return;
    renderer.setQuality(q);
    drive.setShadowMapSize(renderer.quality.shadowMap);
    markQuality();
  });

  // прогрев: компиляция шейдеров обеих сцен до показа
  for (let i = 0; i < models.length; i++) {
    drive.attachCar(models[i], configs[i]);
    renderer.gl.compile(drive.scene, drive.camera);
  }
  drive.attachCar(car, cfg);
  drive.reset(true);
  renderer.gl.compile(drive.scene, drive.camera);
  renderer.render(drive.scene, drive.camera, 0);
  garage.attachCar(car);
  loadBar(1, 'Готово');
  await sleep(SHOT ? 0 : 250);

  const SPEEDO_LEN = 252;
  const speedEl = $('speed'), arcEl = $('speedArc'), odoEl = $('odo');
  let lastSpeed = -1;

  const fuelBox = $('fuelBox'), fuelBar = $('fuelBar'), fuelL = $('fuelL'), coinsEl = $('coins'), banner = $('banner');
  const hpBox = $('hpBox'), hpBar = $('hpBar'), hpVal = $('hpVal');
  let chipsKey = '';
  let bannerKey = '';
  const setBanner = (html: string, warn = false) => {
    const key = html + warn;
    if (key === bannerKey) return;
    bannerKey = key;
    banner.classList.toggle('on', !!html);
    banner.classList.toggle('warn', warn);
    if (html) banner.innerHTML = html;
  };
  const updateHud = () => {
    const f = drive.fuel / drive.tank;
    fuelBar.style.width = `${f * 100}%`;
    fuelL.textContent = String(Math.ceil(drive.fuel));
    fuelBox.classList.toggle('low', f < 0.2);
    coinsEl.textContent = String(drive.coins);
    const hp = drive.health / 100;
    hpBar.style.width = `${hp * 100}%`;
    hpVal.textContent = String(Math.round(drive.health));
    hpBox.classList.toggle('low', hp < 0.35);
    const ck = `${drive.insurance.kasko}${drive.insurance.osago}`;
    if (ck !== chipsKey) {
      chipsKey = ck;
      $('insChips').innerHTML = (drive.insurance.kasko ? '<i>КАСКО</i>' : '') + (drive.insurance.osago ? '<i>ОСАГО</i>' : '');
    }
    const ph = drive.phase;
    const toExit = drive.nextExitStartDist, toStation = drive.nextStationDist;
    const r50 = (m: number) => Math.max(50, Math.round(m / 50) * 50);
    const kind = drive.nextExitKind;
    const place = kind === 'repair' ? '🔧 Автосервис' : '⛽ Заправка';
    const toPlace = kind === 'repair' ? drive.nextRepairDist : toStation;
    if (ph === 'pitIn' || ph === 'refuel') setBanner(drive.stationKind === 'repair' ? '🔧 Заезжаем в автосервис' : '⛽ Заезжаем на заправку');
    else if (ph === 'empty') setBanner('Топливо кончилось', true);
    else if (ph === 'wrecked') setBanner('Машина разбита', true);
    else if (ph === 'drive' && drive.lane === 2) setBanner(`${place}<small>${kind === 'repair' ? 'бокс' : 'колонка'} через ${r50(toPlace)} м</small>`);
    else if (ph === 'drive' && toExit < 700 && toPlace > 30) {
      const urgent = kind === 'repair' ? hp < 0.35 : f < 0.2;
      setBanner(!drive.exitOpen
        ? `${place} через ${r50(toExit)} м<small>перестройтесь в правую полосу</small>`
        : `${place}: съезд открыт<small>${innerWidth < 720 ? 'свайп' : '→'} — съехать</small>`, urgent);
    } else if (hp < 0.35 && ph === 'drive') {
      setBanner(`Машина повреждена: ${Math.round(drive.health)} %<small>автосервис через ${(drive.nextRepairDist / 1000).toFixed(1)} км</small>`, true);
    } else if (f < 0.2 && ph === 'drive') {
      setBanner(`Мало топлива: ${Math.ceil(drive.fuel)} л<small>до заправки ${(toStation / 1000).toFixed(1)} км · хватит на ${(drive.fuel / DriveScene.LITERS_PER_KM).toFixed(1)} км</small>`, true);
    } else setBanner('');
  };

  const frame = (dt: number) => {
    time += dt;
    if (state === 'garage' || state === 'loading') {
      garage.update(dt);
      renderer.render(garage.scene, garage.camera, time);
      return;
    }
    if (state === 'station' || state === 'over') {
      // мир живёт: трафик едет мимо, машина стоит
      drive.update(dt, { throttle: 0, brake: 0, laneShift: 0 }, time);
      updateHud();
    }
    if (state === 'drive') {
      input.poll();
      drive.update(dt, { throttle: input.throttle, brake: input.brake, laneShift: input.take() }, time);
      updateHud();
      if (drive.phase === 'drive' && !input.enabled) input.enabled = true;
      hintTimer += dt;
      if (hintTimer > 7) $('ctrlHint').classList.add('hide');
      const kmh = Math.round(drive.speedKmh);
      if (kmh !== lastSpeed) {
        lastSpeed = kmh;
        speedEl.textContent = String(kmh);
        arcEl.style.strokeDashoffset = String(SPEEDO_LEN * (1 - Math.min(1, kmh / cfg.maxSpeedKmh)));
      }
      odoEl.textContent = (drive.odometer / 1000).toFixed(1);
    }
    renderer.render(drive.scene, drive.camera, time);
  };

  if (SHOT) {
    await runShot(SHOT, { renderer, garage, drive, frame, startDrive, enterGarage, setState: (s: State) => (state = s) });
    return;
  }

  enterGarage();
  renderer.gl.setAnimationLoop((t) => { clock.update(t); frame(Math.min(clock.getDelta(), 0.1)); });
}

/** Детерминированные кадры для автоматических снимков (scripts/shot.mjs). */
async function runShot(kind: string, ctx: {
  renderer: Renderer; garage: GarageScene; drive: DriveScene; frame: (dt: number) => void;
  startDrive: (skip?: boolean, s?: number) => Promise<void>; enterGarage: () => void; setState: (s: State) => void;
}) {
  const p = new URLSearchParams(location.search);
  const steps = Number(p.get('steps') || 90);
  if (kind === 'sim') (ctx.drive.world.constructor as any).stats = { base: [], scatter: [], far: [] };
  if (kind === 'repair') {
    const d = ctx.drive;
    const log: string[] = [];
    const ex = d.world.path.nextExit(0, 'repair');
    log.push(`сервис: s0=${Math.round(ex.s0)} kind=${ex.kind}`);
    let t = 0;
    const step = (shift = 0) => { t += 1 / 60; d.update(1 / 60, { throttle: 0, brake: 0, laneShift: shift }, t); };
    // страховки — как игрок: переключатели в гараже
    const setIns = (k: boolean, o: boolean) => {
      for (const [id, want] of [['insKasko', k], ['insOsago', o]] as const) {
        const b = document.getElementById(id)!;
        if (b.classList.contains('on') !== want) b.click();
      }
    };
    for (const kasko of [false, true]) {
      setIns(kasko, false);
      await ctx.startDrive(true, ex.s0 - 150);
      d.fuel = 50;
      log.push(`старт (КАСКО=${kasko}): монет ${d.coins}`);
      d.health = 40;
      const c0 = d.coins;
      while (!d.exitOpen && t < 400) step();
      step(1);
      while (d.phase !== 'refuel' && t < 600) step();
      log.push(`у бокса: phase=${d.phase} kind=${d.stationKind} панель=${document.querySelector('#station')!.classList.contains('show')} текст="${document.querySelector('#stFull')!.textContent}"`);
      const got = d.repair(100);
      log.push(`ремонт +${got}%: здоровье ${d.health}, списано ${c0 - d.coins}`);
      ctx.drive.leaveStation();
      (document.querySelector('#stLeave') as HTMLElement).click();
    }
    // удары: без ОСАГО и с ОСАГО — случайная езда до 6 ударов
    for (const osago of [false, true]) {
      setIns(false, osago);
      await ctx.startDrive(true, 300);
      d.fuel = 60;
      const fines: number[] = [];
      d.onDamage = (inf) => fines.push(inf.fine);
      let nextShift = 0;
      while (d.crashes < 6 && d.phase !== 'stopped' && t < 3000) {
        let sh = 0;
        if (t > nextShift) { sh = Math.random() < 0.5 ? -1 : 1; nextShift = t + 0.7 + Math.random(); }
        t += 1 / 60;
        d.update(1 / 60, { throttle: 1, brake: 0, laneShift: sh }, t);
      }
      log.push(`ОСАГО=${osago}: ударов ${d.crashes}, штрафы [${fines.join(',')}], монет ${d.coins}, здоровье ${d.health}, phase=${d.phase}, причина=${d.endReason}`);
    }
    console.warn('REPAIR ' + log.join(' | '));
  } else if (kind === 'pit') {
    // сценарий заправки: съезд → колонка → полный бак → выезд → пустой бак
    const d = ctx.drive;
    const ex = d.world.path.nextExit(0);
    await ctx.startDrive(true, ex.s0 - 200);
    const log: string[] = [`exit s0=${Math.round(ex.s0)} stop=${Math.round(ex.sStop)}`];
    d.fuel = 9;
    let t = 0;
    const step = (shift = 0) => { t += 1 / 60; d.update(1 / 60, { throttle: 0, brake: 0, laneShift: shift }, t); };
    for (let i = 0; i < 60 * 3; i++) step();
    log.push(`до съезда: lane=${d.lane} s=${Math.round(d.s)} extra=${d.world.path.extraAt(d.s + 12).toFixed(2)}`);
    step(1); // попытка в полосу 2 до открытия съезда
    log.push(`рано вправо: lane=${d.lane}`);
    while (!d.exitOpen && t < 60) step();
    step(1);
    log.push(`съезд открыт: lane=${d.lane} s=${Math.round(d.s)}`);
    while (d.phase !== 'refuel' && t < 90) step();
    {
      const path = d.world.path, ii = Math.round(ex.sStop / 2);
      const st = path.point(ii, 6.75 + 1.75, 0, new THREE.Vector3());
      const car = (d.scene.getObjectByName('car') as THREE.Object3D).position;
      log.push(`колонка↔машина: ${st.distanceTo(car).toFixed(2)} м`);
    }
    log.push(`у колонки: phase=${d.phase} s=${Math.round(d.s)} (stop ${Math.round(ex.sStop)}) v=${d.v.toFixed(2)} fuel=${d.fuel.toFixed(1)} coins=${d.coins}`);
    const got = d.refuel(d.tank);
    log.push(`залили ${got} л: fuel=${d.fuel.toFixed(1)} coins=${d.coins}`);
    for (let i = 0; i < 60 * 2; i++) step();
    log.push(`стоим: v=${d.v.toFixed(2)} phase=${d.phase}`);
    d.leaveStation();
    for (let i = 0; i < 60 * 15; i++) step();
    log.push(`после выезда: phase=${d.phase} lane=${d.lane} d=${d.d.toFixed(2)} v=${(d.v * 3.6).toFixed(0)} км/ч`);
    d.fuel = 0.02;
    while (d.phase !== 'stopped' && t < 200) step();
    log.push(`пустой бак: phase=${d.phase} v=${d.v.toFixed(2)} state=${document.querySelector('#over')!.classList.contains('show')}`);
    console.warn('PIT ' + log.join(' | '));
  } else if (kind === 'segs') {
    const b = ctx.drive.world.path.biomes;
    b.segmentAt(20000);
    console.warn('SEGS', b.segments.map((s) => `${s.id}:${Math.round(s.start)}-${Math.round(s.end)}:${s.seaSide}`).join(' '));
  } else if (kind === 'sim') {
    // логика без отрисовки: N секунд езды со случайными перестроениями
    await ctx.startDrive(true, Number(p.get('s') || 200));
    const d = ctx.drive;
    let tMax = 0, tSum = 0;
    const secs = Number(p.get('secs') || 120);
    let overlaps = 0, walls = 0, maxCount = 0, minV = 1e9, laneShift = 0, nextShift = 2;
    let tSim = 0;
    const stats = { sedan: 0, truck: 0, moto: 0 };
    for (let i = 0; i < secs * 60; i++) {
      tSim += 1 / 60;
      if (tSim > nextShift) { laneShift = Math.random() < 0.5 ? -1 : 1; nextShift = tSim + 1 + Math.random() * 3; }
      const t0 = performance.now();
      d.update(1 / 60, { throttle: Math.random() < 0.3 ? 1 : 0, brake: 0, laneShift }, tSim);
      const dtu = performance.now() - t0; tSum += dtu; tMax = Math.max(tMax, dtu);
      laneShift = 0;
      const vs = d.traffic.vehicles;
      maxCount = Math.max(maxCount, vs.length);
      for (const a of vs) {
        minV = Math.min(minV, a.v);
        for (const b of vs) {
          if (a === b || b.s < a.s) continue;
          if (b.s - a.s < (a.length + b.length) / 2 && Math.abs(a.d - b.d) < (a.width + b.width) / 2 - 0.1) overlaps++;
        }
        const near = vs.filter((o) => Math.abs(o.s - a.s) < 6);
        if (new Set(near.map((o) => o.lane)).size >= 3) walls++;
      }
      if (i % 600 === 0) for (const a of vs) stats[a.kind]++;
    }
    const RW = (d.world.constructor as any).stats as Record<string, number[]>;
    const st = (a: number[]) => { const b = a.slice(-400).sort((x, y) => x - y); return b.length ? `n${b.length} med ${b[b.length >> 1].toFixed(1)} max ${b[b.length - 1].toFixed(1)}` : '-'; };
    console.warn('STAGES', 'base', st(RW.base), '| scatter', st(RW.scatter), '| far', st(RW.far));
    console.warn('SIM', JSON.stringify({ km: (d.odometer / 1000).toFixed(2), crashes: d.crashes, overlaps, walls, maxCount, minKmh: (minV * 3.6).toFixed(0), avgMs: (tSum / (secs * 60)).toFixed(2), maxMs: tMax.toFixed(1), now: d.traffic.count, stats }));
  } else if (kind === 'tex') {
    const map = (ctx.drive.world as any).mats.road.map as THREE.DataTexture;
    const { data, width, height } = map.image as { data: Uint8Array; width: number; height: number };
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    c.style.cssText = 'position:fixed;inset:0;height:100%;z-index:99;image-rendering:auto;background:#000';
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    document.body.appendChild(c);
  } else if (kind === 'garage') {
    ctx.enterGarage();
    const tm = p.get('tm');
    if (tm === 'sedan' || tm === 'truck' || tm === 'moto') {
      const vis = new TrafficAssets().create(tm);
      const car = ctx.garage.scene.getObjectByName('car');
      if (car) car.visible = false;
      ctx.garage.scene.add(vis.root);
    }
    if (p.get('yaw')) ctx.garage.yaw = Number(p.get('yaw'));
    for (let i = 0; i < steps; i++) ctx.frame(1 / 60);
    const cv = p.get('cam');
    if (cv) {
      const cam = ctx.garage.camera;
      cam.clearViewOffset();
      const [x, y, z, tx, ty, tz] = cv === 'top' ? [0, 9, 0.001, 0, 0, 0] : cv.split('_').map(Number);
      cam.position.set(x, y, z);
      cam.lookAt(tx, ty, tz);
      cam.updateProjectionMatrix();
      ctx.renderer.render(ctx.garage.scene, cam, 0);
    }
  } else {
    const intro = kind === 'intro';
    await ctx.startDrive(!intro, Number(p.get('s') || 200));
    if (p.get('cam') === 'far') ctx.drive.toggleCamera();
    const lane = Number(p.get('lane') || 1);
    ctx.drive.lane = lane;
    if (!intro) ctx.drive.d = lane * 3.5;
    const v = p.get('v');
    if (p.get('near')) {
      ctx.drive.traffic.clear();
      const s0 = ctx.drive.s;
      const nearS = Number(p.get('near'));
      ctx.drive.traffic.debugPlace('truck', s0 + 40, lane + (lane < 1 ? 1 : -1) * 1, 90);
      ctx.drive.traffic.debugPlace(p.get('mk') === 'moto' ? 'moto' : 'sedan', s0 + nearS, lane + (lane < 1 ? 1 : -1) * 1, 88);
      ctx.drive.traffic.debugPlace('sedan', s0 + 60, lane === -1 ? 1 : -1, 90);
    }
    for (let i = 0; i < steps; i++) {
      if (v) ctx.drive.v = Number(v) / 3.6;
      ctx.frame(1 / 60);
    }
    const topH = Number(p.get('top') || 0);
    if (topH) {
      const cam = ctx.drive.camera, c = (ctx.drive.scene.getObjectByName('car') as THREE.Object3D).position;
      cam.position.set(c.x, c.y + topH, c.z - topH * 0.35);
      cam.lookAt(c.x, c.y, c.z + 4);
      ctx.renderer.render(ctx.drive.scene, cam, 0);
    }
  }
  (window as any).__ready = true;
}

main().catch((e) => {
  console.error(e);
  loadBar(1, 'Ошибка: ' + (e?.message || e));
});
