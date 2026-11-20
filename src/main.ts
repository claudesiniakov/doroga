import * as THREE from 'three';
import './style.css';
import cars from './cars.json';
import { Renderer, detectQuality, QualityName } from './render';
import { buildCar, CarConfig, CarModel } from './car';
import { GarageScene } from './garage';
import { DriveScene } from './drive';
import { Input } from './input';

type State = 'loading' | 'garage' | 'drive' | 'pause';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // служебный режим для автоматических снимков
if (SHOT) document.documentElement.classList.add('shot');

const screens = ['loading', 'garage', 'hud', 'pause'] as const;
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

  const cfg = (cars as CarConfig[])[0];
  const car: CarModel = buildCar(cfg);
  const garage = new GarageScene(pmrem, document.body);
  garage.attachCar(car);
  loadBar(0.35, 'Прокладываем трассу…');
  await nextFrame();

  const drive = new DriveScene(pmrem, renderer.quality.textureSize, renderer.anisotropy, Number(params.get('seed') || 1337));
  drive.setShadowMapSize(renderer.quality.shadowMap);
  loadBar(0.8, 'Прогреваем шейдеры…');
  await nextFrame();

  // UI гаража
  $('carName').textContent = cfg.name;
  $('carTag').textContent = cfg.tagline;
  $('slotColor').style.background = cfg.color;
  const statNames: [keyof CarConfig['stats'], string][] = [['speed', 'Скорость'], ['accel', 'Разгон'], ['handling', 'Управление'], ['brakes', 'Тормоза']];
  $('carStats').innerHTML = statNames.map(([k, n]) =>
    `<li>${n}<span class="b"><i style="width:${cfg.stats[k] * 100}%"></i></span><em>${Math.round(cfg.stats[k] * 100)}</em></li>`).join('');
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
  addEventListener('keydown', (e) => {
    if (state === 'pause' && (e.code === 'Escape' || e.code === 'KeyP')) resume();
    if (state === 'garage' && (e.code === 'Enter' || e.code === 'Space')) $('go').click();
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

  const frame = (dt: number) => {
    time += dt;
    if (state === 'garage' || state === 'loading') {
      garage.update(dt);
      renderer.render(garage.scene, garage.camera, time);
      return;
    }
    if (state === 'drive') {
      input.poll();
      drive.update(dt, { throttle: input.throttle, brake: input.brake, laneShift: input.take() }, time);
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
  if (kind === 'tex') {
    const map = (ctx.drive.world as any).mats.road.map as THREE.DataTexture;
    const { data, width, height } = map.image as { data: Uint8Array; width: number; height: number };
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    c.style.cssText = 'position:fixed;inset:0;height:100%;z-index:99;image-rendering:auto;background:#000';
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    document.body.appendChild(c);
  } else if (kind === 'garage') {
    ctx.enterGarage();
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
    for (let i = 0; i < steps; i++) {
      if (v) ctx.drive.v = Number(v) / 3.6;
      ctx.frame(1 / 60);
    }
  }
  (window as any).__ready = true;
}

main().catch((e) => {
  console.error(e);
  loadBar(1, 'Ошибка: ' + (e?.message || e));
});
