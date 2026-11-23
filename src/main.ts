import * as THREE from 'three';
import './style.css';
import cars from './cars.json';
import { Renderer, detectQuality, QualityName } from './render';
import type { CarConfig, CarModel } from './car';
import { buildPlayerCar } from './player-car';
import { TrafficAssets } from './traffic-models';
import { KBM, loadKbm, saveKbm, osagoPrice, kbmNext, fmtK } from './kbm';
import { GarageScene } from './garage';
import { DriveScene } from './drive';
import { Input } from './input';

type State = 'loading' | 'garage' | 'drive' | 'pause' | 'station' | 'over' | 'protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const snowOverride = params.get('snow');
const SNOW_CHANCE = 0.25;
const SHOT = params.get('shot'); // служебный режим для автоматических снимков
if (SHOT) document.documentElement.classList.add('shot');

const screens = ['loading', 'garage', 'hud', 'pause', 'station', 'over', 'kbm', 'protocol'] as const;
function show(...ids: string[]) {
  for (const s of screens) $(s).classList.toggle('show', ids.includes(s));
}
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function loadBar(p: number, text?: string) {
  $('loadbar').style.width = `${Math.round(p * 100)}%`;
  if (text) $('loadtext').textContent = text;
}


async function main() {
  const canvas = $<HTMLCanvasElement>('gl');
  const quality: QualityName = detectQuality();
  const renderer = new Renderer(canvas, quality);
  const pmrem = new THREE.PMREMGenerator(renderer.gl);
  loadBar(0.1, 'Собираем машину…');
  await nextFrame();

  const configs = cars as CarConfig[];
  const models = configs.map(buildPlayerCar);
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
  // ——— кошелёк, поездки, статистика (сохраняются между поездками) ———
  const lsNum = (k: string, d: number) => {
    try { const raw = localStorage.getItem(k); const v = Number(raw); return raw !== null && Number.isFinite(v) ? v : d; } catch { return d; }
  };
  const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* нет хранилища */ } };
  let wallet = lsNum('doroga.wallet', DriveScene.START_COINS);
  let trip = lsNum('doroga.trip', 1);
  let kaskoPrice = lsNum('doroga.kaskoPrice', DriveScene.KASKO);
  const TRIP_REWARD = 100;
  /** Первая поездка — 4 км, каждая следующая на 2 км длиннее. */
  const tripKm = (n: number) => 4 + 2 * (n - 1);
  const gstats = { km: 0, crashes: 0, done: 0, last: '' };
  try { Object.assign(gstats, JSON.parse(localStorage.getItem('doroga.stats') || '{}')); } catch { /* нет хранилища */ }
  const fmtKm = (km: number) => `${km.toFixed(1).replace('.', ',')} км`;
  const updateEconomyUI = () => {
    $('walletTop').textContent = String(wallet);
    $('walletCard').textContent = String(wallet);
    $('gsTrip').textContent = `№${trip} · ${tripKm(trip)} км`;
    $('gsKm').textContent = fmtKm(gstats.km);
    $('gsCrashes').textContent = String(gstats.crashes);
    $('gsDone').textContent = String(gstats.done);
    $('gsLast').textContent = gstats.last || '—';
    $('go').textContent = `Поехать · поездка №${trip}, ${tripKm(trip)} км`;
  };

  // ——— начать сначала: полный сброс прогресса (в два нажатия) ———
  {
    const btn = $('resetAll');
    let armed = 0;
    btn.addEventListener('click', () => {
      if (!armed) {
        btn.classList.add('confirm');
        btn.textContent = 'Точно сбросить? Кошелёк, поездки, статистика, КБМ — к началу. Нажмите ещё раз';
        armed = window.setTimeout(() => { armed = 0; btn.classList.remove('confirm'); btn.textContent = 'Начать сначала'; }, 5000);
        return;
      }
      clearTimeout(armed);
      for (const k of ['doroga.wallet', 'doroga.trip', 'doroga.stats', 'doroga.kaskoPrice', 'doroga.kbm', 'doroga.ins', 'doroga.car']) {
        try { localStorage.removeItem(k); } catch { /* нет хранилища */ }
      }
      location.reload();
    });
  }

  // На десктопе вкладки переключают панели, на сенсорном экране доступен свайп.
  {
    const slidesEl = $('slides');
    const slides = [...slidesEl.querySelectorAll<HTMLElement>('.slide')];
    const tabsEl = $('tabs');
    const desktop = matchMedia('(pointer: fine)');
    tabsEl.innerHTML = slides.map((slide, i) =>
      `<button type="button" data-i="${i}" aria-pressed="false">${slide.dataset.name}</button>`).join('');
    const tabs = [...tabsEl.querySelectorAll('button')];
    const markSlide = (index: number) => {
      tabs.forEach((tab, i) => {
        tab.classList.toggle('on', i === index);
        tab.setAttribute('aria-pressed', String(i === index));
        slides[i].classList.toggle('active', i === index);
      });
    };
    markSlide(0);
    tabsEl.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button) return;
      const index = Number(button.dataset.i);
      if (desktop.matches) markSlide(index);
      else slidesEl.scrollTo({ left: index * slidesEl.clientWidth, behavior: SHOT ? 'instant' : 'smooth' });
    });
    slidesEl.addEventListener('scroll', () => {
      if (desktop.matches) return;
      const index = Math.round(slidesEl.scrollLeft / Math.max(1, slidesEl.clientWidth));
      markSlide(index);
    }, { passive: true });
  }

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
    updateEconomyUI();
    show('garage');
  };

  const startDrive = async (skipIntro = false, startS = 30) => {
    input.enabled = false;
    await fade(true);
    const snowy = snowOverride === '1' || (!SHOT && snowOverride !== '0' && Math.random() < SNOW_CHANCE);
    drive.setSnow(snowy);
    drive.attachCar(car, cfg);
    // страховки оплачиваются из кошелька, остальное — на поездку
    const cost = insCost();
    wallet = Math.max(0, wallet - cost);
    lsSet('doroga.wallet', wallet);
    drive.insurance = { ...ins, osagoPrice: osagoPrice(kbm) };
    drive.tripKm = tripKm(trip);
    drive.startCoins = wallet;
    runClosed = false;
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

  // каждый заезд — год: с ОСАГО класс КБМ меняется по числу ДТП (страховых случаев)
  let kbm = loadKbm();
  let runClosed = true;
  let lastKbmChange: { from: number; to: number } | null = null;
  let lastTrip = { finished: false, km: 0, crashes: 0, reward: 0, num: 1 };
  const finishRun = () => {
    if (runClosed) return;
    runClosed = true;
    // итог поездки: награда за финиш, кошелёк, статистика
    const finished = drive.endReason === 'finish';
    const reward = finished ? TRIP_REWARD : 0;
    const km = drive.tripDone / 1000;
    lastTrip = { finished, km, crashes: drive.crashes, reward, num: trip };
    wallet = Math.max(0, drive.coins) + reward;
    gstats.km += km;
    gstats.crashes += drive.crashes;
    if (finished) { gstats.done++; trip++; }
    gstats.last = `№${lastTrip.num}: ${fmtKm(km)}, столкновений ${drive.crashes}${finished ? ', завершена' : ''}`;
    if (drive.insurance.kasko) {
      kaskoPrice = Math.round(Math.min(200, Math.max(10, kaskoPrice * (drive.kaskoRepairUsed ? 1.1 + Math.random() * 0.2 : 0.95 - Math.random() * 0.15))));
    }
    lsSet('doroga.wallet', wallet); lsSet('doroga.trip', trip); lsSet('doroga.kaskoPrice', kaskoPrice); lsSet('doroga.stats', gstats);
    lastKbmChange = null;
    if (drive.insurance.osago) {
      const to = kbmNext(kbm, drive.crashes);
      lastKbmChange = { from: kbm, to };
      kbm = to;
      saveKbm(kbm);
    }
    renderIns();
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
  input.onCamera = () => drive.toggleCamera();

  // ——— страховки (покупаются перед заездом из стартовых монет) ———
  const ins = { kasko: false, osago: false };
  try { Object.assign(ins, JSON.parse(localStorage.getItem('doroga.ins') || '{}')); } catch { /* нет хранилища */ }
  function insCost() { return (ins.kasko ? kaskoPrice : 0) + (ins.osago ? osagoPrice(kbm) : 0); }
  // ливрея страховщика — при любой купленной страховке (видна сразу в гараже и в поездке)
  function applyLivery() { const on = ins.kasko || ins.osago; for (const m of models) m.setLivery?.(on); }
  function renderIns() {
    // не дороже кошелька: лишнее снимается
    if (insCost() > wallet && ins.kasko) ins.kasko = false;
    if (insCost() > wallet && ins.osago) ins.osago = false;
    ($('insKasko') as HTMLButtonElement).disabled = !ins.kasko && insCost() + kaskoPrice > wallet;
    $('kaskoPrice').textContent = String(kaskoPrice);
    $('insKasko').classList.toggle('on', ins.kasko);
    $('insOsago').classList.toggle('on', ins.osago);
    $('osagoPrice').textContent = String(osagoPrice(kbm));
    $('kbmNow').textContent = fmtK(KBM[kbm].k);
    $('kbmCls').textContent = KBM[kbm].cls;
    $('startCoins').textContent = String(wallet - insCost());
    applyLivery();
    updateEconomyUI();
    try { localStorage.setItem('doroga.ins', JSON.stringify({ kasko: ins.kasko, osago: ins.osago })); } catch { /* нет хранилища */ }
  }
  // всплывающее окно с таблицей КБМ: текущий класс подсвечен, рядом — куда попадёте через год
  const renderKbmTable = () => {
    const nxt = new Set(KBM[kbm].next);
    $('kbmBody').innerHTML = KBM.map((r, i) =>
      `<tr class="${i === kbm ? 'cur' : ''}"><td class="c">${r.cls}</td><td>${fmtK(r.k)}</td><td>${osagoPrice(i)}</td>` +
      r.next.map((n) => `<td class="n${i === kbm && nxt.has(n) ? '' : ''}">${KBM[n].cls}</td>`).join('') + '</tr>').join('');
    const afford = insCost() + osagoPrice(kbm) <= wallet;
    $('kbmBuy').textContent = ins.osago ? 'ОСАГО уже выбрано' : afford ? `Купить ОСАГО за ${osagoPrice(kbm)}` : 'Не хватает монет';
    ($('kbmBuy') as HTMLButtonElement).disabled = ins.osago || !afford;
  };
  let kbmBack: string[] = ['garage'];
  const openKbm = () => { renderKbmTable(); kbmBack = ['garage']; show('garage', 'kbm'); };
  const closeKbm = () => show(...kbmBack);
  $('insKasko').addEventListener('click', () => { ins.kasko = !ins.kasko; renderIns(); });
  $('insOsago').addEventListener('click', () => {
    if (ins.osago) { ins.osago = false; renderIns(); return; }
    openKbm(); // покупка — из окна с таблицей
  });
  $('kbmLink').addEventListener('click', openKbm);
  $('kbmBuy').addEventListener('click', () => { ins.osago = true; renderIns(); closeKbm(); });
  $('kbmClose').addEventListener('click', closeKbm);
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
  // ——— ДПС: протокол за езду без ОСАГО ———
  drive.onPolice = () => {
    state = 'protocol';
    input.enabled = false;
    const n = String(Math.floor(1000000 + Math.random() * 8999999));
    $('prNum').textContent = `77 ДР № ${n}`;
    $('prPlace').textContent = `трасса, ${(drive.odometer / 1000).toFixed(1).replace('.', ',')} км`;
    $('prCar').textContent = `${cfg.name}, г/н ${cfg.plate}`;
    $('prFine').textContent = drive.policeFine >= DriveScene.POLICE_FINE ? `штраф ${drive.policeFine} монет`
      : `штраф ${DriveScene.POLICE_FINE} монет (списано ${drive.policeFine} — больше нет)`;
    $('prSign').textContent = `Подписать · −${drive.policeFine} монет`;
    show('hud', 'protocol');
  };
  $('prSign').addEventListener('click', () => {
    if (state !== 'protocol') return;
    drive.leavePolice();
    state = 'drive';
    input.clear();
    input.enabled = true;
    show('hud');
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
    const t = lastTrip;
    $('ovEyebrow').textContent = `Поездка №${t.num} · ${tripKm(t.num)} км`;
    $('ovTitle').textContent = t.finished ? 'Поездка завершена' : drive.endReason === 'wreck' ? 'Машина разбита' : 'Топливо кончилось';
    $('ovKm').textContent = fmtKm(t.km);
    $('ovRewardRow').style.display = t.finished ? '' : 'none';
    $('ovReward').textContent = String(t.reward);
    $('ovCrashes').textContent = String(t.crashes);
    $('ovCoins').textContent = String(wallet);
    $('ovAgain').textContent = t.finished ? `Следующая поездка · ${tripKm(trip)} км` : `Повторить поездку · ${tripKm(trip)} км`;
    const ch = lastKbmChange;
    $('ovKbmRow').style.display = ch ? '' : 'none';
    if (ch) $('ovKbm').textContent = ch.from === ch.to ? `класс ${KBM[ch.to].cls} (без изменений)`
      : `класс ${KBM[ch.from].cls} → ${KBM[ch.to].cls} · ОСАГО ${osagoPrice(ch.from)} → ${osagoPrice(ch.to)}`;
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
    if ((state === 'drive' || state === 'pause') && (e.code === 'Escape' || e.code === 'KeyP')) {
      e.preventDefault();
      if (!e.repeat) {
        if (state === 'drive') pause();
        else resume();
      }
      return;
    }
    if (state === 'station') {
      if (e.code === 'Enter') $('stFull').click();
      if (e.code === 'Escape' || e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') $('stLeave').click();
    }
    if (state === 'over' && e.code === 'Enter') $('ovAgain').click();
    if (state === 'protocol' && (e.code === 'Enter' || e.code === 'Space')) $('prSign').click();
    if (state === 'garage') {
      if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea, [contenteditable]')) return;
      if (e.code === 'Enter' || e.code === 'Space') $('go').click();
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') selectCar(sel + (e.code === 'ArrowLeft' ? -1 : 1));
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  // ——— полный экран и веб-приложение ———
  const docEl = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  const fsEnabled = !!(document.fullscreenEnabled || (document as any).webkitFullscreenEnabled);
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as any).standalone === true;
  const isFs = () => !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
  const enterFs = async (landscape: boolean) => {
    if (!fsEnabled || isFs()) return;
    try {
      await (docEl.requestFullscreen ? docEl.requestFullscreen({ navigationUI: 'hide' }) : docEl.webkitRequestFullscreen?.());
      if (landscape) await (screen.orientation as any)?.lock?.('landscape').catch(() => undefined);
    } catch { /* браузер отказал — играем в окне */ }
  };
  if (fsEnabled && !standalone && !SHOT) {
    $('fsBtn').hidden = false;
    $('fsBtn').addEventListener('click', () => (isFs() ? document.exitFullscreen?.() : enterFs(false)));
  }
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => setTimeout(resize, 50));
  // iPhone: страница не может скрыть Safari — подсказка «на экран Домой» (один раз, можно закрыть)
  const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let tipSeen = false;
  try { tipSeen = localStorage.getItem('doroga.iosTip') === '1'; } catch { /* нет хранилища */ }
  if (isIOS && !standalone && !tipSeen && !SHOT) $('iosTip').hidden = false;
  $('iosTipClose').addEventListener('click', () => {
    $('iosTip').hidden = true;
    try { localStorage.setItem('doroga.iosTip', '1'); } catch { /* нет хранилища */ }
  });
  if ('serviceWorker' in navigator && !SHOT && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => undefined);

  $('go').addEventListener('click', () => {
    if (state !== 'garage') return;
    // на телефоне — сразу на весь экран и горизонтально (нажатие — жест пользователя, браузер разрешит)
    if (matchMedia('(pointer: coarse)').matches) enterFs(true);
    startDrive();
  });
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
  // одометр: барабаны крутятся как настоящие — десятые плавно, старшие разряды докручиваются при переносе
  const drums = [...odoEl.querySelectorAll<HTMLElement>('.drum')].reverse();   // [десятые, единицы, десятки, сотни]
  const drumPos = drums.map(() => -1);
  function setOdo(tenths: number) {
    const v = Math.max(0, tenths);
    const frac = v % 1;
    for (let i = 0; i < drums.length; i++) {
      const unit = 10 ** i;
      const digit = Math.floor(v / unit) % 10;
      const rolling = i === 0 ? frac : (v % unit) >= unit - 1 ? frac : 0;   // все младшие на «9» — переносим
      const p = Math.round((digit + rolling) * 100) / 100;
      if (p !== drumPos[i]) { drumPos[i] = p; drums[i].style.setProperty('--p', String(p)); }
    }
  }
  setOdo(0);
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
    const toPolice = drive.policeS !== null && drive.policeFine === 0 ? drive.policeS - drive.s : Infinity;
    const toFinish = drive.finishS - drive.s;
    if (ph === 'finish') setBanner('🏁 Финиш!');
    else if (ph === 'drive' && toFinish > 0 && toFinish < 500) setBanner(`🏁 Финиш через ${r50(toFinish)} м`);
    else if (ph === 'policeIn' || ph === 'protocol') setBanner('🚓 Остановка ДПС<small>проверка документов</small>', true);
    else if (ph === 'drive' && toPolice > 0 && toPolice < 450) setBanner(`🚓 Впереди пост ДПС<small>через ${r50(toPolice)} м · полиса ОСАГО нет</small>`, true);
    else if (ph === 'pitIn' || ph === 'refuel') setBanner(drive.stationKind === 'repair' ? '🔧 Заезжаем в автосервис' : '⛽ Заезжаем на заправку');
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
    if (state === 'station' || state === 'over' || state === 'protocol') {
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
      setOdo(drive.tripDone / 100);
      $('odoGoal').textContent = `/ ${drive.tripKm} км`;
      $('tripBar').style.width = `${Math.min(100, (drive.tripDone / (drive.tripKm * 1000)) * 100)}%`;
    }
    renderer.render(drive.scene, drive.camera, time);
  };

  if (SHOT) {
    await runShot(SHOT, { renderer, garage, drive, frame, startDrive, enterGarage, setState: (s: State) => (state = s) });
    return;
  }

  enterGarage();
  // первый кадр таймера может дать отрицательный интервал — ограничиваем снизу нулём
  renderer.gl.setAnimationLoop((t) => { clock.update(t); frame(Math.max(0, Math.min(clock.getDelta(), 0.1))); });
}

/** Детерминированные кадры для автоматических снимков (scripts/shot.mjs). */
async function runShot(kind: string, ctx: {
  renderer: Renderer; garage: GarageScene; drive: DriveScene; frame: (dt: number) => void;
  startDrive: (skip?: boolean, s?: number) => Promise<void>; enterGarage: () => void; setState: (s: State) => void;
}) {
  const p = new URLSearchParams(location.search);
  const steps = Number(p.get('steps') || 90);
  if (kind === 'sim') (ctx.drive.world.constructor as any).stats = { base: [], scatter: [], far: [] };
  if (kind === 'nanall') {
    const d = ctx.drive, out: string[] = [];
    let t = 0;
    for (const at of [500, 1500, 4000, 6800, 8500, 11000]) {
      await ctx.startDrive(true, at);
      for (let i = 0; i < 260; i++) { t += 1 / 60; d.update(1 / 60, { throttle: 0, brake: 0, laneShift: 0 }, t); }
      let zero = 0, nan = 0;
      d.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        const n = m.isMesh ? m.geometry?.getAttribute('normal') : null;
        if (n) for (let k = 0; k < n.count; k++) { const q = n.getX(k) ** 2 + n.getY(k) ** 2 + n.getZ(k) ** 2; if (!Number.isFinite(q)) nan++; else if (q < 1e-10) zero++; }
      });
      out.push(`${at}м ${d.world.path.biomes.segmentAt(at).id}: нулевых ${zero}, NaN ${nan}`);
    }
    console.warn('NANALL ' + out.join(' | '));
  } else if (kind === 'nan') {
    const d = ctx.drive;
    await ctx.startDrive(true, 30);
    const ex = d.world.path.nextExit(0, 'repair');
    d.s = ex.s0 - 150;
    let t = 0;
    for (let i = 0; i < 200; i++) { t += 1 / 60; d.update(1 / 60, { throttle: 0, brake: 0, laneShift: 0 }, t); }
    let nanN = 0, zeroN = 0, nanP = 0, meshes = 0;
    d.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      meshes++;
      const n = m.geometry.getAttribute('normal'), p2 = m.geometry.getAttribute('position');
      let zHere = 0;
      if (n) for (let k = 0; k < n.count; k++) {
        const x = n.getX(k), y = n.getY(k), z = n.getZ(k);
        if (!Number.isFinite(x + y + z)) nanN++; else if (x * x + y * y + z * z < 1e-10) { zeroN++; zHere++; }
      }
      if (zHere) {
        const mat = m.material as any;
        m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox!;
        let ex = '';
        for (let k = 0; k < n.count && !ex; k++) if (n.getX(k) ** 2 + n.getY(k) ** 2 + n.getZ(k) ** 2 < 1e-10) ex = `${p2.getX(k).toFixed(2)},${p2.getY(k).toFixed(2)},${p2.getZ(k).toFixed(2)}`;
        console.warn('ZERO', zHere, n.count, 'map', !!mat.map, 'vc', !!mat.vertexColors, 'rough', mat.roughness, 'metal', mat.metalness, 'size', bb.max.clone().sub(bb.min).toArray().map((v: number) => v.toFixed(1)).join('x'), 'pos', ex, 'attrs', Object.keys(m.geometry.attributes).join(','));
      }
      if (p2) for (let k = 0; k < p2.count; k++) if (!Number.isFinite(p2.getX(k) + p2.getY(k) + p2.getZ(k))) nanP++;
    });
    // удар на 220 км/ч: наибольший наклон кузова
    d.s = ex.sEnd + 400; d.v = 61; d.lastV = 61;
    let maxPitch = 0, maxRoll = 0;
    (d as any).crash({ severity: 1, side: false });
    d.v = 27;
    for (let i = 0; i < 120; i++) { t += 1 / 60; d.update(1 / 60, { throttle: 0, brake: 0, laneShift: 0 }, t); maxPitch = Math.max(maxPitch, Math.abs((d as any).pitch)); maxRoll = Math.max(maxRoll, Math.abs((d as any).roll)); }
    {
      const A = d.traffic.assets as any;
      const zc = (g: THREE.BufferGeometry) => { const n = g.getAttribute('normal'); let z = 0; for (let k = 0; k < n.count; k++) if (n.getX(k) ** 2 + n.getY(k) ** 2 + n.getZ(k) ** 2 < 1e-10) z++; return z; };
      const out: string[] = [];
      for (const k of ['sedan', 'truck', 'moto', 'van']) {
        const t = A[k];
        for (const [key, g] of t.parts) { const z = zc(g); if (z) out.push(`${k}.${key}:${z}/${g.getAttribute('normal').count}`); }
        for (const key of ['tail', 'blinkL', 'blinkR']) { const z = zc(t[key]); if (z) out.push(`${k}.${key}:${z}`); }
        t.axles.forEach((a: any, i: number) => { const z = zc(a.rubber) + zc(a.rim); if (z) out.push(`${k}.axle${i}:${z}`); });
      }
      console.warn('ZEROPARTS', out.join(' '));
    }
    console.warn('NAN', JSON.stringify({ meshes, nanN, zeroN, nanP, maxPitchDeg: (maxPitch * 57.3).toFixed(1), maxRollDeg: (maxRoll * 57.3).toFixed(1) }));
  } else if (kind === 'gate') {
    const d = ctx.drive;
    await ctx.startDrive(true, 30);
    d.s = d.finishS - 120;
    let t = 0;
    for (let i = 0; i < 5; i++) { t += 1 / 60; d.update(1 / 60, { throttle: 0, brake: 0, laneShift: 0 }, t); }
    const g = (d as any).finishGate as THREE.Group;
    const car = (d.scene.getObjectByName('car') as THREE.Object3D).position;
    console.warn('GATE', JSON.stringify({ exists: !!g, visible: g?.visible, inScene: !!g?.parent, dist: g ? g.position.distanceTo(car).toFixed(1) : null, finishS: d.finishS, s: d.s.toFixed(0), children: g?.children.length, y: g?.position.y.toFixed(1), carY: car.y.toFixed(1) }));
  } else if (kind === 'exitsim') {
    const d = ctx.drive, log: string[] = [];
    let t = 0;
    for (const kind2 of ['repair', 'fuel'] as const) {
      for (const kmh of [90, 130, 170, 200]) {
        await ctx.startDrive(true, 30);
        d.policeS = null; d.fuel = 60;
        const ex = d.world.path.nextExit(0, kind2);
        d.s = ex.s0 - 300; d.v = kmh / 3.6;
        let shifted = false, result = 'проехал мимо';
        const t0 = t;
        while (t - t0 < 60) {
          t += 1 / 60;
          let sh = 0;
          if (!shifted && d.exitOpen && d.phase === 'drive') { sh = 1; shifted = true; }
          if (d.phase === 'drive' && !shifted) d.v = kmh / 3.6;
          d.update(1 / 60, { throttle: d.phase === 'drive' ? 1 : 0, brake: 0, laneShift: sh }, t);
          if (d.phase === 'refuel') { result = `встал у колонки (${(ex.sStop - d.s).toFixed(1)} м)`; break; }
          if (d.s > ex.sEnd + 20) break;
        }
        log.push(`${kind2} ${kmh} км/ч: ${result}`);
      }
    }
    console.warn('EXITSIM ' + log.join(' | '));
  } else if (kind === 'stops') {
    const d = ctx.drive, log: string[] = [];
    let t = 0;
    const run = (cond: () => boolean, kmh?: number, max = 90) => {
      const t0 = t;
      while (!cond() && t - t0 < max) { t += 1 / 60; if (kmh && d.phase === 'drive') d.v = kmh / 3.6; d.update(1 / 60, { throttle: kmh ? 1 : 0, brake: 0, laneShift: 0 }, t); }
    };
    const osago = document.getElementById('insOsago')!;
    if (osago.classList.contains('on')) osago.click();
    for (const kmh of [90, 200]) {
      await ctx.startDrive(true, 30);
      d.policeS = d.s + 900; d.fuel = 60;
      let minGap = Infinity;
      const t0 = t;
      while (d.phase !== 'protocol' && t - t0 < 90) {
        t += 1 / 60; if (d.phase === 'drive') d.v = kmh / 3.6;
        d.update(1 / 60, { throttle: 1, brake: 0, laneShift: 0 }, t);
        minGap = Math.min(minGap, d.policeS! - d.s);
      }
      log.push(`ДПС на ${kmh} км/ч: phase=${d.phase}, встал за ${(d.policeS! - d.s).toFixed(1)} м, ближе всего ${minGap.toFixed(1)} м`);
    }
    for (const kmh of [90, 200]) {
      await ctx.startDrive(true, 30);
      d.policeS = null; d.fuel = 60;
      d.s = d.finishS - 300;
      run(() => d.phase === 'finish', kmh);
      const sF = d.s;
      run(() => d.phase === 'stopped');
      log.push(`финиш на ${kmh} км/ч: остановка через ${(d.s - sF).toFixed(0)} м после линии`);
    }
    for (const km of [4, 6, 10, 20]) {
      d.world.path.planTrip(30, 30 + km * 1000);
      const ex = d.world.path.exits.filter((e) => e.sStop > 30 && e.sStop < 30 + km * 1000);
      log.push(`${km} км: ` + ex.map((e) => `${e.kind === 'repair' ? 'сервис' : 'заправка'} ${((e.sStop - 30) / 1000).toFixed(1)}`).join(', '));
    }
    const rb = document.getElementById('resetAll')!;
    rb.click();
    log.push(`сброс, 1-е нажатие: «${rb.textContent}»`);
    console.warn('STOPS ' + log.join(' | '));
  } else if (kind === 'trip') {
    for (const k of ['doroga.wallet', 'doroga.trip', 'doroga.kaskoPrice', 'doroga.stats', 'doroga.ins']) localStorage.removeItem(k);
    location.search.includes('reloaded') || null;
    const d = ctx.drive, log: string[] = [];
    const txt = (id: string) => document.getElementById(id)!.textContent;
    const kasko = document.getElementById('insKasko')!;
    let t = 0;
    const runTo = (cond: () => boolean, max = 120) => { const t0 = t; while (!cond() && t - t0 < max) { t += 1 / 60; d.update(1 / 60, { throttle: 1, brake: 0, laneShift: 0 }, t); } };
    log.push(`старт: кошелёк ${txt('walletTop')}, кнопка «${txt('go')}», КАСКО ${txt('kaskoPrice')}`);
    // 1) поездка с КАСКО без ремонта → финиш
    if (!kasko.classList.contains('on')) kasko.click();
    await ctx.startDrive(true, 30);
    log.push(`поездка 1: цель ${d.tripKm} км, на поездку ${d.coins} монет, патруль ${d.policeS === null ? 'нет' : `на ${((d.policeS - d.startS) / 1000).toFixed(1)} км`}`);
    d.s = d.finishS - 250; d.fuel = 50;
    runTo(() => d.phase === 'stopped');
    log.push(`  финиш: причина=${d.endReason}, экран «${txt('ovTitle')}», награда +${txt('ovReward')}, кошелёк ${txt('ovCoins')}, кнопка «${txt('ovAgain')}»`);
    log.push(`  КАСКО без ремонта → ${txt('kaskoPrice')}`);
    // 2) поездка с КАСКО и бесплатным ремонтом → финиш
    if (!kasko.classList.contains('on')) kasko.click();
    await ctx.startDrive(true, 30);
    d.health = 50; d.repair(100);
    log.push(`поездка 2: цель ${d.tripKm} км, ремонт по КАСКО списал ${d.startCoins - d.coins}`);
    d.s = d.finishS - 250; d.fuel = 50;
    runTo(() => d.phase === 'stopped');
    log.push(`  КАСКО после ремонта → ${txt('kaskoPrice')}, кошелёк ${txt('ovCoins')}`);
    // 3) неудача: бак пуст → та же дистанция
    await ctx.startDrive(true, 30);
    d.fuel = 0.01;
    runTo(() => d.phase === 'stopped');
    log.push(`поездка 3: «${txt('ovTitle')}», кнопка «${txt('ovAgain')}»`);
    log.push(`статистика: следующая ${txt('gsTrip')}, всего ${txt('gsKm')}, столкновений ${txt('gsCrashes')}, завершено ${txt('gsDone')}, последняя «${txt('gsLast')}»`);
    // ДПС — внутри поездки
    const kasko2 = document.getElementById('insOsago')!;
    if (kasko2.classList.contains('on')) kasko2.click();
    let inside = 0, any = 0;
    for (let k = 0; k < 20; k++) { await ctx.startDrive(true, 30); if (d.policeS !== null) { any++; if (d.policeS > d.startS + 999 && d.policeS < d.finishS - 799) inside++; } }
    log.push(`ДПС без ОСАГО: в ${any} из 20 поездок, внутри поездки ${inside}`);
    console.warn('TRIP ' + log.join(' | '));
  } else if (kind === 'police') {
    const d = ctx.drive, log: string[] = [];
    const osago = document.getElementById('insOsago')!;
    // с ОСАГО — патруля нет ни в одном заезде
    if (!osago.classList.contains('on')) { osago.click(); document.getElementById('kbmBuy')!.click(); }
    let withOsago = 0;
    for (let k = 0; k < 30; k++) { await ctx.startDrive(true, 300); if (d.policeS !== null) withOsago++; }
    log.push(`с ОСАГО: патрулей в 30 заездах = ${withOsago}`);
    osago.click(); // снять ОСАГО
    let without = 0;
    for (let k = 0; k < 30; k++) { await ctx.startDrive(true, 300); if (d.policeS !== null) without++; }
    log.push(`без ОСАГО: патрулей в 30 заездах = ${without}`);
    await ctx.startDrive(true, 300);
    d.policeS = d.s + 400;
    const c0 = d.coins;
    let t = 0;
    const step = () => { t += 1 / 60; d.update(1 / 60, { throttle: 0, brake: 0, laneShift: 0 }, t); };
    while (d.phase !== 'protocol' && t < 60) step();
    const car = (d.scene.getObjectByName('car') as THREE.Object3D).position;
    const pf = d.world.path.frame(d.policeS!);
    log.push(`остановка: phase=${d.phase}, до патруля ${(d.policeS! - d.s).toFixed(1)} м, обочина d=${d.d.toFixed(2)}, списано ${c0 - d.coins}, протокол=${document.getElementById('protocol')!.classList.contains('show')}, видно патруль=${car.distanceTo(pf.pos) < 20}`);
    ctx.frame(1 / 60);
    if (p.get('stay')) { (window as any).__ready = true; return; }
    (document.getElementById('prSign') as HTMLElement).click();
    for (let i = 0; i < 60 * 12; i++) step();
    log.push(`после: phase=${d.phase}, полоса ${d.lane}, ${(d.v * 3.6).toFixed(0)} км/ч`);
    const c1 = d.coins;
    d.policeS = d.s + 400;   // повторная попытка в том же заезде
    for (let i = 0; i < 60 * 30; i++) step();
    log.push(`повторно в том же заезде: phase=${d.phase}, списано ${c1 - d.coins}`);
    console.warn('POLICE ' + log.join(' | '));
  } else if (kind === 'kbmtest') {
    // годы: без ДТП с ОСАГО → с 2 ДТП с ОСАГО → 3 ДТП без ОСАГО (класс не меняется)
    localStorage.removeItem('doroga.kbm');
    const log: string[] = [];
    const cls = () => document.getElementById('kbmCls')!.textContent + ' (ОСАГО ' + document.getElementById('osagoPrice')!.textContent + ')';
    log.push('старт: класс ' + cls());
    const osago = document.getElementById('insOsago')!;
    if (osago.classList.contains('on')) osago.click();
    osago.click();
    log.push(`окно КБМ: ${document.getElementById('kbm')!.classList.contains('show')}, подсвечен класс ${document.querySelector('#kbmBody tr.cur td')!.textContent}`);
    document.getElementById('kbmBuy')!.click();
    for (const [crashes, withOsago] of [[0, true], [2, true], [3, false]] as const) {
      if (osago.classList.contains('on') !== withOsago) { osago.click(); if (withOsago) document.getElementById('kbmBuy')!.click(); }
      await ctx.startDrive(true, 300);
      log.push(`год: ОСАГО=${withOsago}, взнос ${ctx.drive.insurance.osago ? ctx.drive.insurance.osagoPrice : 0}, монет на старте ${ctx.drive.coins}`);
      ctx.drive.crashes = crashes;
      (document.getElementById('restart') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 50));
      log.push(`  ДТП ${crashes} → класс ${cls()}`);
    }
    console.warn('KBM ' + log.join(' | '));
  } else if (kind === 'knock') {
    // сбить мотоцикл: он должен улететь с трассы (|d| за край дороги), а не остаться на полосе
    const d = ctx.drive;
    await ctx.startDrive(true, 1290);
    d.traffic.clear();
    d.lane = 0; d.d = 0;
    d.traffic.debugPlace('moto', d.s + 9, 0, 60);
    const tr = d.traffic as any;
    const out: string[] = [];
    for (let i = 0; i < 300; i++) {
      d.v = 110 / 3.6;
      ctx.frame(1 / 60);
      const f = tr.flying[0];
      if (f && i % 25 === 0) out.push(`t=${f.t.toFixed(2)} ds=${(f.s - d.s).toFixed(1)} d=${f.d.toFixed(1)} h=${f.h.toFixed(1)} vis=${f.v.vis.root.parent ? 'да' : 'нет'}`);
    }
    console.warn('KNOCK crashes=' + d.crashes + ' moto в потоке=' + d.traffic.vehicles.filter((v) => v.kind === 'moto').length + ' | ' + out.join(' | '));
  } else if (kind === 'blink') {
    // левый поворотник должен быть слева по ходу: проверяем в мировых координатах
    const d = ctx.drive;
    await ctx.startDrive(true, 900);
    const tr = d.traffic;
    tr.clear();
    const out: string[] = [];
    for (const k of ['sedan', 'truck', 'moto', 'van', 'tiller'] as const) {
      tr.debugPlace(k, d.s + 30, 0, 90);
      const vis = (tr.group.children[tr.group.children.length - 1]) as THREE.Group;
      vis.updateMatrixWorld(true);
      const f = d.world.path.frame(d.s + 30);
      const centerOf = (name: 'blinkL' | 'blinkR') => {
        const m = (vis.children[0].children as THREE.Mesh[]).find((c) => c.geometry === (tr as any).assets[k][name]);
        const bb = new THREE.Box3().setFromObject(m!);
        return bb.getCenter(new THREE.Vector3()).sub(f.pos).dot(f.right);
      };
      const l = centerOf('blinkL'), r = centerOf('blinkR');
      out.push(`${k}: левый ${l < 0 ? 'слева ✓' : 'СПРАВА ✗'} (${l.toFixed(2)}), правый ${r > 0 ? 'справа ✓' : 'СЛЕВА ✗'} (${r.toFixed(2)})`);
    }
    console.warn('BLINK ' + out.join(' | '));
  } else if (kind === 'repair') {
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
        if (b.classList.contains('on') !== want) {
          b.click();
          if (id === 'insOsago' && want) document.getElementById('kbmBuy')!.click(); // покупка — из окна КБМ
        }
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
    // план съездов строится при старте поездки — берём заправку из него и подъезжаем к ней
    await ctx.startDrive(true, 30);
    const ex = d.world.path.nextExit(0, 'fuel');
    d.s = ex.s0 - 200;
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
    const pth = ctx.drive.world.path;
    pth.ensure(60000);
    let minGap = Infinity, worstS = 0, coastSamples = 0;
    for (let i = 0; i < pth.y.length - 1; i++) {
      if (pth.weightsAt(i).coast < 0.02 || Number.isNaN(pth.sea[i])) continue;
      coastSamples++;
      const g = pth.y[i] - pth.sea[i];
      if (g < minGap) { minGap = g; worstS = i * 2; }
    }
    console.warn('SEAGAP', `точек у моря ${coastSamples}, мин. высота дороги над водой ${minGap.toFixed(2)} м (s=${worstS})`);
    console.warn('SEGS', b.segments.map((s) => `${s.id}:${Math.round(s.start)}-${Math.round(s.end)}:${s.seaSide}`).join(' '));
  } else if (kind === 'sim') {
    // логика без отрисовки: N секунд езды со случайными перестроениями
    await ctx.startDrive(true, Number(p.get('s') || 200));
    const d = ctx.drive;
    let tMax = 0, tSum = 0;
    const secs = Number(p.get('secs') || 120);
    let overlaps = 0, walls = 0, maxCount = 0, minV = 1e9, laneShift = 0, nextShift = 2;
    let tSim = 0;
    const stats = { sedan: 0, truck: 0, moto: 0, van: 0, tiller: 0 };
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
    if (tm === 'sedan' || tm === 'truck' || tm === 'moto' || tm === 'van') {
      const vis = new TrafficAssets().create(tm);
      const car = ctx.garage.scene.getObjectByName('car');
      if (car) car.visible = false;
      ctx.garage.scene.add(vis.root);
    }
    if (p.get('yaw')) ctx.garage.yaw = Number(p.get('yaw'));
    if (p.get('click')) document.getElementById(p.get('click')!)?.click();
    const slide = p.get('slide');
    if (slide !== null) document.querySelectorAll<HTMLButtonElement>('#tabs button')[Number(slide)]?.click();
    if (p.get('dbg') === 'gh') {
      // отладка: «аквариум» — красный кузов / зелёное стекло / синий пластик, обе стороны; задние грани — жёлтые
      ctx.garage.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && Array.isArray(m.material) && m.material.length === 3) {
          m.material = [0xff2020, 0x20ff40, 0x2040ff].map((c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.FrontSide }));
          const back = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ color: 0xffee00, side: THREE.BackSide }));
          m.add(back);
        }
      });
    }
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
    if (p.get('police')) ctx.drive.policeS = ctx.drive.s + Number(p.get('police'));
    if (p.get('at')) { ctx.drive.s = Number(p.get('at')); ctx.drive.policeS = null; }
    if (p.get('near')) {
      ctx.drive.traffic.clear();
      const s0 = ctx.drive.s;
      const nearS = Number(p.get('near'));
      ctx.drive.traffic.debugPlace('truck', s0 + 40, lane + (lane < 1 ? 1 : -1) * 1, 90);
      const mk = (['moto', 'tiller'].includes(p.get('mk') ?? '') ? p.get('mk') : 'sedan') as 'moto' | 'tiller' | 'sedan';
      ctx.drive.traffic.debugPlace(mk, s0 + nearS, p.get('same') ? lane : lane + (lane < 1 ? 1 : -1) * 1, mk === 'tiller' ? 25 : Number(p.get('mkv') || 88));
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
