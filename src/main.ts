import * as THREE from 'three';
import './style.css';
import './home.css';
import cars from './cars.json';
import { Renderer, detectQuality, QualityName } from './render';
import type { CarConfig } from './car';
import { buildPlayerCar } from './player-car';
import { KBM, loadKbm, saveKbm, osagoPrice, osagoFactors, kbmNext, fmtK } from './kbm';
import { GarageScene } from './garage';
import type { DriveScene } from './drive';
import { START_COINS, LITERS_PER_KM, FUEL_PRICE, KASKO, REPAIR_PRICE, POLICE_FINE } from './drive-rules';
import { Input } from './input';
import { OSAGO_LESSON, OSAGO_TARIFF_SOURCE } from './osago-lesson';
import { finishRecordRun, formatRecordDistance, formatRecordDays, loadRecords, MAX_NICKNAME_LENGTH, saveRecord, startRecordRun } from './records';

type State = 'loading' | 'garage' | 'drive' | 'pause' | 'station' | 'over' | 'protocol' | 'renewal' | 'breakdown' | 'yearReport' | 'returningHome';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // служебный режим для автоматических снимков
if (SHOT) document.documentElement.classList.add('shot');

const screens = ['loading', 'garage', 'hud', 'pause', 'station', 'breakdown', 'over', 'kbm', 'protocol', 'yearReport'] as const;
function show(...ids: string[]) {
  for (const s of screens) $(s).classList.toggle('show', ids.includes(s));
  $('garage').inert = !ids.includes('garage') || ids.includes('kbm');
  $('kbm').inert = !ids.includes('kbm');
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
  const cfg = (SHOT && configs.find((config) => config.id === params.get('car'))) || configs[0];
  const car = buildPlayerCar(cfg);
  const garage = SHOT ? new GarageScene(pmrem, document.body) : undefined;
  garage?.attachCar(car);
  loadBar(0.35, 'Прокладываем трассу…');
  await nextFrame();

  let drive: DriveScene;
  let driveModule: Promise<typeof import('./drive')> | undefined;
  const loadDrive = () => driveModule ??= import('./drive').catch((error: unknown) => {
    driveModule = undefined;
    throw error;
  });
  const prepareDrive = async () => {
    if (drive) return drive;
    const { DriveScene } = await loadDrive();
    const scene = new DriveScene(pmrem, renderer.quality.textureSize, renderer.anisotropy, Number(params.get('seed') || 1337));
    scene.endless = !SHOT;
    if (SHOT) scene.setSnow(params.get('snow') !== '0');
    scene.setShadowMapSize(renderer.quality.shadowMap);
    scene.resize(innerWidth / innerHeight);
    Object.assign(scene, { onStation, onPolice, onDamage, onEmpty, onCrash, onYearEnd });
    drive = scene;
    return scene;
  };

  // ——— кошелёк, поездки, статистика (сохраняются между поездками) ———
  const lsNum = (k: string, d: number) => {
    try { const raw = localStorage.getItem(k); const v = Number(raw); return raw !== null && Number.isFinite(v) ? v : d; } catch { return d; }
  };
  const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* нет хранилища */ } };
  let wallet = lsNum('doroga.wallet', START_COINS);
  let trip = lsNum('doroga.trip', 1);
  let kaskoPrice = lsNum('doroga.kaskoPrice', KASKO);
  const TRIP_REWARD = 100;
  /** Первая поездка — 4 км, каждая следующая на 2 км длиннее. */
  const tripKm = (n: number) => 4 + 2 * (n - 1);
  const gstats = {
    km: 0, crashes: 0, done: 0, collected: 0,
    runs: 0, durationMs: 0, bestMs: 0,
    lastRun: null as { durationMs: number; km: number; crashes: number } | null,
  };
  try {
    const saved = JSON.parse(localStorage.getItem('doroga.stats') || '{}');
    for (const key of ['km', 'crashes', 'done', 'collected', 'runs', 'durationMs', 'bestMs'] as const) {
      if (Number.isFinite(saved?.[key]) && saved[key] >= 0) gstats[key] = saved[key];
    }
    const last = saved?.lastRun;
    if (last && [last.durationMs, last.km, last.crashes].every((value) => Number.isFinite(value) && value >= 0)) {
      gstats.lastRun = last;
    }
  } catch { /* нет хранилища */ }
  const fmtKm = (km: number) => `${km.toFixed(1).replace('.', ',')} км`;
  const updateEconomyUI = () => {
    $('walletTop').textContent = String(wallet);
    $('walletCard').textContent = String(wallet);
    $('gsDays').textContent = formatRecordDays(gstats.durationMs);
    $('gsBest').textContent = gstats.runs ? formatRecordDays(gstats.bestMs) : '—';
    $('gsRuns').textContent = String(gstats.runs);
    $('gsYears').textContent = String(gstats.done);
    $('gsKm').textContent = fmtKm(gstats.km);
    $('gsCrashes').textContent = String(gstats.crashes);
    $('gsCoins').textContent = String(gstats.collected);
    const last = gstats.lastRun;
    $('gsLast').textContent = last
      ? `${formatRecordDays(last.durationMs)} · ${fmtKm(last.km)} · столкновений: ${last.crashes}`
      : '—';
    $('go').textContent = state === 'renewal'
      ? (ins.osago || ins.kasko ? 'Продолжить путь' : 'Продолжить без страховки') : 'Поехать';
  };

  const ownRecordKey = 'doroga.ownTimeRecords';
  const ownRecords = new Set<number>();
  try {
    const saved = JSON.parse(localStorage.getItem(ownRecordKey) ?? '[]');
    if (Array.isArray(saved)) {
      for (const key of saved) if (Number.isSafeInteger(key)) ownRecords.add(key);
    }
  } catch { /* нет хранилища */ }

  let recordSaved = false;
  let rankingRun: Promise<string | undefined> | undefined;
  let activeRunSeconds = 0;
  let accountedRunMs = 0;
  let runCrashes = 0;
  let rankedSummary: { durationMs: number; run: Promise<string | undefined>; finished: Promise<boolean> } | undefined;
  let submittedNickname: string | undefined;
  let recordLoad = 0;
  const recordForm = $<HTMLFormElement>('recordForm');
  const recordNickname = $<HTMLInputElement>('recordNickname');
  const recordSave = $<HTMLButtonElement>('recordSave');
  const recordStatus = $('recordStatus');
  recordNickname.maxLength = MAX_NICKNAME_LENGTH;
  const renderRecords = async () => {
    const request = ++recordLoad;
    const status = $('recordsEmpty');
    status.textContent = 'Загружаем общие рекорды…';
    status.hidden = false;
    const scroll = $('recordsScroll');
    scroll.hidden = true;
    try {
      const records = await loadRecords();
      if (request !== recordLoad) return;
      status.textContent = 'Здесь будут результаты завершённых заездов.';
      status.hidden = records.length > 0;
      scroll.hidden = records.length === 0;
      const rows = records.map(({ id, nickname, durationMs }, index) => {
        const row = document.createElement('tr');
        for (const cell of [String(index + 1), nickname, formatRecordDays(durationMs)]) {
          row.insertCell().textContent = cell;
        }
        if (ownRecords.has(id)) {
          row.classList.add('own-record');
          const label = document.createElement('span');
          label.className = 'own-record-label';
          label.textContent = 'Ваш заезд';
          row.cells[1].append(' ', label);
        }
        return row;
      });
      $('recordsBody').replaceChildren(...rows);
    } catch {
      if (request === recordLoad) status.textContent = 'Общие рекорды пока недоступны.';
    }
  };
  recordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const summary = rankedSummary;
    if (state !== 'over' || !summary || recordSaved || recordSave.disabled) return;
    const nickname = recordNickname.value.trim();
    recordStatus.hidden = false;
    if (!nickname || nickname.length > MAX_NICKNAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(nickname)) {
      recordStatus.textContent = `Введите ник длиной до ${MAX_NICKNAME_LENGTH} символов.`;
      recordNickname.focus();
      return;
    }
    submittedNickname ??= nickname;
    recordNickname.disabled = recordSave.disabled = true;
    recordStatus.textContent = 'Сохраняем результат…';
    try {
      const run = await summary.run;
      if (!run) return;
      if (!await summary.finished) await finishRecordRun(run, summary.durationMs);
      const { place, id } = await saveRecord(submittedNickname, run);
      if (place <= 100) {
        ownRecords.add(id);
        lsSet(ownRecordKey, [...ownRecords]);
      }
      if (summary !== rankedSummary || state !== 'over') return;
      recordSaved = true;
      recordStatus.textContent = place <= 100 ? `Результат сохранён. Место №${place}.`
        : `Результат сохранён. Место №${place} в общем рейтинге.`;
      $('ovGarage').textContent = 'К таблице рекордов';
    } catch {
      if (summary !== rankedSummary || state !== 'over') return;
      recordSave.disabled = false;
      recordStatus.textContent = 'Не удалось сохранить результат. Попробуйте ещё раз.';
    }
  });

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

  let openInsuranceTab = () => {};
  let openRecordsTab = () => {};
  // Вкладки переключают панели; стрелки перемещают фокус между вкладками.
  {
    const slidesEl = $('slides');
    const slides = [...slidesEl.querySelectorAll<HTMLElement>('.slide')];
    const tabsEl = $('tabs');
    tabsEl.innerHTML = slides.map((slide, i) =>
      `<button type="button" id="home-tab-${i}" data-i="${i}" role="tab" aria-controls="home-slide-${i}">${slide.dataset.name}</button>`).join('');
    const tabs = [...tabsEl.querySelectorAll('button')];
    slides.forEach((slide, i) => {
      slide.id = `home-slide-${i}`;
      slide.setAttribute('role', 'tabpanel');
      slide.setAttribute('aria-labelledby', tabs[i].id);
    });
    const markSlide = (index: number) => {
      tabs.forEach((tab, i) => {
        tab.classList.toggle('on', i === index);
        tab.setAttribute('aria-selected', String(i === index));
        tab.tabIndex = i === index ? 0 : -1;
        slides[i].inert = i !== index;
        slides[i].classList.toggle('active', i === index);
      });
    };
    const insuranceIndex = slides.findIndex((slide) => slide.dataset.name === 'Страховка');
    openInsuranceTab = () => markSlide(insuranceIndex);
    openInsuranceTab();
    const recordsIndex = slides.findIndex((slide) => slide.dataset.name === 'Рекорды');
    openRecordsTab = () => markSlide(recordsIndex);
    tabsEl.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button) return;
      const index = Number(button.dataset.i);
      markSlide(index);
      if (index === recordsIndex) void renderRecords();
    });
    tabsEl.addEventListener('keydown', (event) => {
      const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-i]');
      if (!tab) return;
      const current = Number(tab.dataset.i);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length
          : event.key === 'ArrowRight' ? (current + 1) % tabs.length : current;
      if (current === index) return;
      event.preventDefault();
      markSlide(index);
      tabs[index].focus();
      if (index === recordsIndex) void renderRecords();
    });
  }

  const touchControls = matchMedia('(pointer: coarse)');
  const portrait = matchMedia('(orientation: portrait)');
  const input = new Input($('touch'), $('pedGas'), $('pedBrake'));
  let state: State = 'loading';
  const clock = new THREE.Timer();
  clock.connect(document);
  let time = 0;
  let hintTimer = 0;

  const resize = () => {
    renderer.resize();
    garage?.resize(innerWidth / innerHeight);
    drive?.resize(innerWidth / innerHeight);
  };
  addEventListener('resize', resize);
  resize();

  const fade = async (on: boolean) => {
    $('fade').classList.toggle('on', on);
    await sleep(SHOT ? 0 : 620);
  };

  const enterGarage = () => {
    void renderRecords();
    if (garage) garage.attachCar(car);
    else drive.previewRoad(car, cfg);
    $('garage').classList.remove('is-renewal');
    $('homeMode').hidden = true;
    $('insuranceHeading').textContent = 'Страховка на год';
    openInsuranceTab();
    renderer.setExposure(garage ? 1.0 : 0.6);
    renderer.setBloom(0.22, 3.0, 0.4);
    renderer.setVignette(0.45);
    input.enabled = false;
    state = 'garage';
    updateEconomyUI();
    show('garage');
  };

  let startingDrive = false;
  const startDrive = async (skipIntro = false, startS = 30) => {
    if (startingDrive) return;
    startingDrive = true;
    input.enabled = false;
    try {
      if (!SHOT) {
        state = 'loading';
        $('fade').classList.remove('on');
        $('loading').classList.add('starting-drive');
        loadBar(0.15, 'Готовим заезд…');
        show('loading');
        await nextFrame();
        await nextFrame();
      }
      await prepareDrive();
      drive.attachCar(car, cfg);
      // Страховки оплачиваются только после успешной подготовки поездки.
      const startCoins = Math.max(0, wallet - insCost());
      drive.insurance = { ...ins, osagoPrice: osagoPrice(kbm) };
      drive.tripKm = tripKm(trip);
      drive.startCoins = startCoins;
      if (!SHOT) {
        loadBar(0.45, 'Прокладываем трассу…');
        await nextFrame();
      }
      drive.reset(skipIntro, startS);
      renderer.setExposure(0.6);
      renderer.setBloom(0.18, 4.5, 0.35);
      renderer.setVignette(0.3);
      if (!SHOT) {
        loadBar(0.8, 'Готовим первый кадр…');
        await nextFrame();
        if (renderer.gl.getContext().isContextLost()) throw new Error('Потерян контекст WebGL');
        renderer.render(drive.scene, drive.camera, time);
        if (renderer.gl.getContext().isContextLost()) throw new Error('Потерян контекст WebGL');
        loadBar(1, 'Заезд готов');
        await nextFrame();
      }
      wallet = startCoins;
      lsSet('doroga.wallet', wallet);
      runClosed = false;
      activeRunSeconds = 0;
      accountedRunMs = 0;
      runCrashes = 0;
      rankingRun = drive.endless ? startRecordRun().catch(() => undefined) : undefined;
      state = 'drive';
      show('hud');
      $('ctrlHint').classList.remove('hide');
      $('touchHint').classList.remove('hide');
      hintTimer = 0;
      clock.update();
    } catch (error) {
      if (SHOT) throw error;
      console.error(error);
      enterGarage();
      $('go').textContent = 'Не удалось выехать · повторить';
    } finally {
      $('loading').classList.remove('starting-drive');
      startingDrive = false;
    }
  };

  // КБМ и КАСКО пересчитываются при завершении страхового периода.
  let kbm = loadKbm();
  let runClosed = true;
  let lastKbmChange: { from: number; to: number } | null = null;
  let lastTrip = { finished: false, km: 0, crashes: 0, reward: 0, num: 1 };
  const finishRun = (renewingInsurance = false) => {
    if (runClosed) return;
    runClosed = true;
    // итог поездки: награда за финиш, кошелёк, статистика
    const finished = drive.endReason === 'finish' || drive.endReason === 'year';
    const reward = finished && SHOT ? TRIP_REWARD : 0;
    const km = drive.tripDone / 1000;
    lastTrip = { finished, km, crashes: drive.crashes, reward, num: trip };
    wallet = renewingInsurance || SHOT ? Math.max(0, drive.coins) + reward : START_COINS;
    gstats.km += km;
    gstats.crashes += drive.crashes;
    gstats.collected += drive.coinsCollected;
    if (finished) { gstats.done++; trip++; }
    const durationMs = Math.floor(activeRunSeconds * 1000);
    gstats.durationMs += durationMs - accountedRunMs;
    accountedRunMs = durationMs;
    runCrashes += drive.crashes;
    if (!renewingInsurance) {
      gstats.runs++;
      gstats.bestMs = Math.max(gstats.bestMs, durationMs);
      gstats.lastRun = { durationMs, km: drive.endless ? drive.odometer / 1000 : km, crashes: runCrashes };
    }
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
  portrait.addEventListener('change', (event) => {
    if (touchControls.matches && event.matches) pause();
  });
  input.onCamera = () => drive.toggleCamera();

  // ——— страховки (покупаются перед заездом из стартовых монет) ———
  const ins = { kasko: false, osago: false };
  try { Object.assign(ins, JSON.parse(localStorage.getItem('doroga.ins') || '{}')); } catch { /* нет хранилища */ }
  function insCost() { return (ins.kasko ? kaskoPrice : 0) + (ins.osago ? osagoPrice(kbm) : 0); }
  // ливрея страховщика — при любой купленной страховке (видна сразу в гараже и в поездке)
  function applyLivery() { car.setLivery?.(ins.kasko || ins.osago); }
  function renderIns() {
    // не дороже кошелька: лишнее снимается
    if (insCost() > wallet && ins.kasko) ins.kasko = false;
    if (insCost() > wallet && ins.osago) ins.osago = false;
    ($('insKasko') as HTMLButtonElement).disabled = !ins.kasko && insCost() + kaskoPrice > wallet;
    $('kaskoPrice').textContent = String(kaskoPrice);
    $('insKasko').classList.toggle('on', ins.kasko);
    $('insOsago').classList.toggle('on', ins.osago);
    $('insKasko').setAttribute('aria-pressed', String(ins.kasko));
    $('insOsago').setAttribute('aria-pressed', String(ins.osago));
    $('osagoPrice').textContent = String(osagoPrice(kbm));
    $('kbmNow').textContent = fmtK(KBM[kbm].k);
    $('kbmCls').textContent = KBM[kbm].cls;
    $('startCoins').textContent = String(wallet - insCost());
    applyLivery();
    updateEconomyUI();
    try { localStorage.setItem('doroga.ins', JSON.stringify({ kasko: ins.kasko, osago: ins.osago })); } catch { /* нет хранилища */ }
  }
  const lessonKey = 'doroga.osagoLessonSeen';
  let lessonSeen = false;
  try { lessonSeen = localStorage.getItem(lessonKey) === '1'; } catch { /* нет хранилища */ }
  let lessonIndex = 0;
  let kbmTrigger: HTMLElement | null = null;
  const lesson = $('osagoLesson');
  const confirmation = $('osagoConfirm');
  const kbmTable = $('kbmTable');
  const confirmTable = $('osagoConfirmTable');
  const referenceTable = $('osagoLessonTable');
  const lessonDetails = $<HTMLDetailsElement>('osagoDetails');
  const lessonBack = $<HTMLButtonElement>('osagoBack');
  const lessonNext = $<HTMLButtonElement>('osagoNext');
  $<HTMLAnchorElement>('osagoSource').href = OSAGO_TARIFF_SOURCE;
  const formatFactor = (factor: number) => String(factor).replace('.', ',');

  const renderKbmTable = () => {
    $('kbmBody').innerHTML = KBM.map((r, i) =>
      `<tr class="${i === kbm ? 'cur' : ''}"><td class="c">${r.cls}</td><td>${fmtK(r.k)}</td><td>${osagoPrice(i)}</td>` +
      r.next.map((n) => `<td class="n">${KBM[n].cls}</td>`).join('') + '</tr>').join('');
    const afford = insCost() + osagoPrice(kbm) <= wallet;
    $('kbmBuy').textContent = ins.osago ? 'ОСАГО уже выбрано' : afford ? `Выбрать ОСАГО за ${osagoPrice(kbm)} монет` : 'Не хватает монет';
    ($('kbmBuy') as HTMLButtonElement).disabled = ins.osago || !afford;
  };

  const showOsagoConfirmation = () => {
    confirmTable.append(kbmTable);
    lesson.hidden = true;
    confirmation.hidden = false;
    $('kbmTitle').textContent = 'Оформление ОСАГО';
    $('osagoCalculation').textContent = `${osagoFactors(kbm).map(formatFactor).join(' × ')} ≈ ${osagoPrice(kbm)} монет`;
  };

  const renderOsagoCard = () => {
    const card = OSAGO_LESSON[lessonIndex];
    lesson.hidden = false;
    confirmation.hidden = true;
    $('kbmTitle').textContent = 'Как рассчитывается стоимость ОСАГО?';
    $('osagoCount').textContent = `${lessonIndex + 1} / ${OSAGO_LESSON.length} карточек`;
    $('osagoFactors').replaceChildren(...OSAGO_LESSON.map(({ factor }, index) => {
      const chip = document.createElement(index === lessonIndex ? 'mark' : 'span');
      chip.textContent = factor;
      return chip;
    }));
    $('osagoCardTitle').textContent = card.title;
    $('osagoExplanation').textContent = card.explanation;
    const example = formatFactor(osagoFactors(kbm)[lessonIndex]);
    $('osagoGameValue').textContent = lessonIndex === 0 ? `В игре · ${example} монет` : `В игре · ${card.factor} = ${example}`;
    lessonBack.disabled = lessonIndex === 0;
    lessonNext.textContent = lessonIndex === OSAGO_LESSON.length - 1 ? 'К оформлению' : 'Далее';
    confirmTable.append(kbmTable);
    referenceTable.replaceChildren();
    lessonDetails.open = false;
    const isKbm = card.factor === 'КБМ';
    lessonDetails.hidden = !isKbm && !card.table;
    if (isKbm) {
      $('osagoTableTitle').textContent = 'Таблица КБМ';
      referenceTable.append(kbmTable);
    } else if (card.table) {
      $('osagoTableTitle').textContent = card.table.title;
      const table = document.createElement('table');
      table.className = 'kbm-table';
      table.setAttribute('aria-label', card.table.title);
      const head = table.createTHead().insertRow();
      for (const label of card.table.headers) {
        const column = document.createElement('th');
        column.scope = 'col';
        column.textContent = label;
        head.append(column);
      }
      const body = table.createTBody();
      for (const values of card.table.rows) {
        const row = body.insertRow();
        for (const value of values) row.insertCell().textContent = value;
      }
      referenceTable.append(table);
    }
  };

  const startOsagoLesson = () => {
    lessonIndex = 0;
    renderOsagoCard();
    $('kbmTitle').focus({ preventScroll: true });
  };
  const finishOsagoLesson = () => {
    lessonSeen = true;
    lsSet(lessonKey, '1');
    showOsagoConfirmation();
    $('kbmTitle').focus({ preventScroll: true });
  };
  const openKbm = (trigger: HTMLElement, reviewLesson = false) => {
    kbmTrigger = trigger;
    renderKbmTable();
    show('garage', 'kbm');
    if (reviewLesson || (!lessonSeen && !SHOT)) startOsagoLesson();
    else {
      showOsagoConfirmation();
      $('kbmClose').focus({ preventScroll: true });
    }
  };
  const closeKbm = () => {
    show('garage');
    kbmTrigger?.focus({ preventScroll: true });
  };
  $('insKasko').addEventListener('click', () => { ins.kasko = !ins.kasko; renderIns(); });
  $('insOsago').addEventListener('click', () => {
    if (ins.osago) { ins.osago = false; renderIns(); return; }
    openKbm($('insOsago'));
  });
  $('kbmLink').addEventListener('click', () => openKbm($('kbmLink'), true));
  $('osagoReplay').addEventListener('click', startOsagoLesson);
  $('osagoSkip').addEventListener('click', finishOsagoLesson);
  lessonBack.addEventListener('click', () => {
    lessonIndex--;
    renderOsagoCard();
    if (lessonBack.disabled) lessonNext.focus();
  });
  lessonNext.addEventListener('click', () => {
    if (lessonIndex + 1 === OSAGO_LESSON.length) finishOsagoLesson();
    else { lessonIndex++; renderOsagoCard(); }
  });
  $('kbmBuy').addEventListener('click', () => { ins.osago = true; renderIns(); closeKbm(); });
  $('kbmClose').addEventListener('click', closeKbm);
  renderIns();

  // ——— заправка и автосервис: одна панель ———
  let stationService: 'fuel' | 'repair' = 'fuel';
  const updateStation = () => {
    const repair = stationService === 'repair';
    $('stEyebrow').textContent = drive.stationKind === 'repair' ? 'Автосервис' : 'Заправка «Топливо 24»';
    for (const [id, active] of [['stFuelTab', !repair], ['stRepairTab', repair]] as const) {
      const tab = $(id);
      tab.classList.toggle('on', active);
      tab.setAttribute('aria-pressed', String(active));
    }
    const canLeave = drive.fuel > 0 && drive.health > 0;
    const leave = $<HTMLButtonElement>('stLeave');
    leave.disabled = !canLeave;
    leave.textContent = canLeave ? 'Уехать' : drive.health <= 0 ? 'Для выезда нужен ремонт' : 'Для выезда нужно топливо';
    $('stEnd').hidden = canLeave;
    const full = $<HTMLButtonElement>('stFull'), ten = $<HTMLButtonElement>('stTen');
    $('stCoins').textContent = String(drive.coins);
    if (!repair) {
      $('stTitle').textContent = 'Заправиться?';
      $('stTank').textContent = String(Math.ceil(drive.fuel - 1e-6));
      $('stUnit').textContent = `/ ${drive.tank} л`;
      $('stTankBar').style.width = `${(drive.fuel / drive.tank) * 100}%`;
      $('stBarWrap').classList.remove('hp');
      $('stPrice').textContent = '1 монета за литр';
      const need = Math.ceil(drive.tank - drive.fuel - 1e-6);
      const can = Math.min(need, Math.floor(drive.coins / FUEL_PRICE));
      full.disabled = can <= 0;
      full.textContent = can <= 0 ? (need <= 0 ? 'Бак полный' : 'Не хватает монет')
        : can < need ? `На все монеты · ${can} л` : `Полный бак · ${need} л за ${need * FUEL_PRICE}`;
      ten.disabled = can <= 0;
      ten.textContent = '+10 л · 10 монет';
      ten.style.display = can > 10 ? '' : 'none';
    } else {
      $('stTitle').textContent = 'Отремонтировать?';
      $('stTank').textContent = String(Math.round(drive.health));
      $('stUnit').textContent = '%';
      $('stTankBar').style.width = `${drive.health}%`;
      $('stBarWrap').classList.add('hp');
      const kasko = drive.insurance.kasko;
      $('stPrice').textContent = kasko ? 'по КАСКО — бесплатно' : '1 монета за 10 %';
      const need = Math.max(0, 100 - drive.health);
      const canPct = kasko ? need : Math.min(need, Math.floor(drive.coins / REPAIR_PRICE) * 10);
      full.disabled = canPct <= 0;
      full.textContent = need <= 0 ? 'Машина целая'
        : canPct <= 0 ? 'Не хватает монет'
          : canPct < need ? `На все монеты · +${canPct} %`
            : `Полный ремонт · ${kasko ? 'бесплатно' : `${drive.repairCost(need)} монет`}`;
      ten.disabled = canPct <= 0;
      ten.textContent = `+10 % · ${kasko ? 'бесплатно' : `${REPAIR_PRICE} монета`}`;
      ten.style.display = need > 10 && canPct > 0 ? '' : 'none';
    }
  };
  const onStation: NonNullable<DriveScene['onStation']> = (kind) => {
    stationService = drive.health <= 0 ? 'repair' : drive.fuel <= 0 ? 'fuel' : kind;
    state = 'station';
    input.enabled = false;
    updateStation();
    show('hud', 'station');
  };
  $('stFuelTab').addEventListener('click', () => { stationService = 'fuel'; updateStation(); });
  $('stRepairTab').addEventListener('click', () => { stationService = 'repair'; updateStation(); });
  const buyService = (full: boolean) => {
    if (state !== 'station') return;
    if (stationService === 'repair') drive.repair(full ? 100 : 10);
    else drive.refuel(full ? drive.tank : 10);
    updateStation();
  };
  $('stFull').addEventListener('click', () => buyService(true));
  $('stTen').addEventListener('click', () => buyService(false));
  // ——— ДПС: протокол за езду без ОСАГО ———
  const onPolice: NonNullable<DriveScene['onPolice']> = () => {
    state = 'protocol';
    input.enabled = false;
    const n = String(Math.floor(1000000 + Math.random() * 8999999));
    $('prNum').textContent = `77 ДР № ${n}`;
    $('prPlace').textContent = `трасса, ${(drive.odometer / 1000).toFixed(1).replace('.', ',')} км`;
    $('prCar').textContent = `${cfg.name}, г/н ${cfg.plate}`;
    $('prFine').textContent = drive.policeFine >= POLICE_FINE ? `штраф ${drive.policeFine} монет`
      : `штраф ${POLICE_FINE} монет (списано ${drive.policeFine} — больше нет)`;
    $('prSign').textContent = `Подписать · −${drive.policeFine} монет`;
    show('hud', 'protocol');
  };
  $('prSign').addEventListener('click', () => {
    if (state !== 'protocol') return;
    drive.leavePolice();
    state = 'drive';
    input.clear();
    input.enabled = false;
    show('hud');
  });
  // ——— удары: здоровье и ОСАГО ———
  let toastTimer = 0;
  const onDamage: NonNullable<DriveScene['onDamage']> = ({ damage, fine, covered }) => {
    const t = $('toast');
    t.innerHTML = `−${damage} % здоровья` + (covered ? ' · ущерб покрыло ОСАГО' : fine > 0 ? ` · ущерб другой машине <span class="coin"></span>−${fine}` : '');
    t.classList.toggle('ok', covered);
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.classList.remove('on'), 2600);
  };
  $('stLeave').addEventListener('click', () => {
    if (state !== 'station' || !drive.leaveStation()) return;
    state = 'drive';
    input.clear();
    input.enabled = false;
    show('hud');
  });
  const showRunSummary = () => {
    finishRun();
    state = 'over';
    input.enabled = false;
    const t = lastTrip;
    $('ovEyebrow').textContent = SHOT ? `Поездка №${t.num} · ${tripKm(t.num)} км` : 'Бесконечная дорога';
    $('ovTitle').textContent = drive.endReason === 'wreck' ? 'Машина разбита'
      : drive.endReason === 'fuel' ? 'Топливо кончилось' : 'Заезд завершён';
    const durationMs = drive.endless ? Math.floor(activeRunSeconds * 1000) : 0;
    recordSaved = false;
    rankedSummary = undefined;
    submittedNickname = undefined;
    recordForm.reset();
    recordNickname.disabled = recordSave.disabled = false;
    recordForm.hidden = durationMs <= 0;
    recordStatus.hidden = true;
    if (durationMs > 0) {
      const run = rankingRun ?? Promise.resolve(undefined);
      const finished = run.then(async (token) => {
        if (!token) return false;
        await finishRecordRun(token, durationMs);
        return true;
      }).catch(() => false);
      const summary = rankedSummary = { durationMs, run, finished };
      recordSave.disabled = true;
      void run.then((token) => {
        if (summary !== rankedSummary || state !== 'over') return;
        if (token) {
          recordSave.disabled = false;
        } else {
          recordNickname.disabled = true;
          recordStatus.hidden = false;
          recordStatus.textContent = 'Сервер рекордов был недоступен при старте заезда.';
        }
      });
    }
    $('ovGarage').textContent = 'На главную';
    $('ovKm').textContent = drive.endless ? formatRecordDistance(Math.round(drive.odometer)) : fmtKm(t.km);
    $('ovDaysRow').hidden = !drive.endless;
    $('ovDays').textContent = formatRecordDays(durationMs);
    $('ovRewardRow').style.display = t.finished ? '' : 'none';
    $('ovReward').textContent = String(t.reward);
    $('ovCrashes').textContent = String(t.crashes);
    $('ovCoins').textContent = String(wallet);
    $('ovAgain').textContent = 'Начать новый заезд';
    const ch = lastKbmChange;
    $('ovKbmRow').style.display = ch ? '' : 'none';
    if (ch) $('ovKbm').textContent = ch.from === ch.to ? `класс ${KBM[ch.to].cls} (без изменений)`
      : `класс ${KBM[ch.from].cls} → ${KBM[ch.to].cls} · ОСАГО ${osagoPrice(ch.from)} → ${osagoPrice(ch.to)}`;
    show('hud', 'over');
  };
  const onEmpty: NonNullable<DriveScene['onEmpty']> = () => {
    if (drive.endReason === 'wreck') {
      state = 'breakdown';
      input.enabled = false;
      const destination = drive.assistanceDestination;
      const place = destination.kind === 'repair' ? 'Автосервис' : 'Заправка';
      $('towDestination').textContent = `${place} · ${fmtKm(Math.abs(destination.sStop - drive.s) / 1000)}`;
      $('towWallet').textContent = String(drive.coins);
      const cost = drive.assistanceCost;
      const call = $<HTMLButtonElement>('towCall');
      call.disabled = drive.coins < cost;
      call.textContent = cost === 0 ? 'Вызвать помощь · бесплатно по КАСКО'
        : call.disabled ? `Эвакуация · нужно ${cost} монет` : `Вызвать помощь · ${cost} монет`;
      show('hud', 'breakdown');
      call.disabled ? $('towEnd').focus() : call.focus();
      return;
    }
    showRunSummary();
  };
  const YEAR_REPORT_MS = 3000;
  const onYearEnd = () => {
    finishRun(true);
    state = 'yearReport';
    input.enabled = false;
    $('yearKm').textContent = fmtKm(lastTrip.km);
    $('yearCrashes').textContent = String(lastTrip.crashes);
    $('yearCoins').textContent = String(drive.coinsCollected);
    const change = lastKbmChange;
    $('yearKbmRow').hidden = !change;
    if (change) $('yearKbm').textContent = `${fmtK(KBM[change.from].k)} → ${fmtK(KBM[change.to].k)}`;
    show('yearReport');
    setTimeout(() => {
      if (state !== 'yearReport') return;
      state = 'renewal';
      ins.kasko = ins.osago = false;
      $('garage').classList.add('is-renewal');
      $('homeMode').hidden = false;
      $('insuranceHeading').textContent = 'Январь · выберите страховку';
      openInsuranceTab();
      renderIns();
      show('garage');
    }, YEAR_REPORT_MS);
  };
  $('towCall').addEventListener('click', async () => {
    const call = $<HTMLButtonElement>('towCall');
    if (state !== 'breakdown' || call.disabled) return;
    call.disabled = true;
    const end = $<HTMLButtonElement>('towEnd');
    end.disabled = true;
    call.textContent = 'Эвакуируем к ближайшей остановке…';
    try {
      await fade(true);
      drive.towToService();
    } finally {
      end.disabled = false;
      await fade(false);
    }
  });
  $('towEnd').addEventListener('click', () => {
    if (state === 'breakdown') showRunSummary();
  });
  $('stEnd').addEventListener('click', () => {
    if (state !== 'station' || (drive.fuel > 0 && drive.health > 0)) return;
    drive.endReason = drive.health <= 0 ? 'wreck' : 'fuel';
    drive.phase = 'stopped';
    showRunSummary();
  });
  $('ovAgain').addEventListener('click', () => { if (state === 'over') startDrive(); });
  $('ovGarage').addEventListener('click', async () => {
    if (state !== 'over') return;
    state = 'returningHome';
    await fade(true);
    enterGarage();
    if (recordSaved) openRecordsTab();
    await fade(false);
  });
  const onCrash: NonNullable<DriveScene['onCrash']> = (e) => {
    const hit = $('hit');
    hit.style.setProperty('--k', String(e.severity));
    hit.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => hit.classList.remove('on')));
    if (navigator.vibrate) navigator.vibrate(e.side ? 60 : 120);
  };
  addEventListener('keydown', (e) => {
    const osagoDialog = $('kbm');
    if (!osagoDialog.inert) {
      if (e.code === 'Escape') {
        e.preventDefault();
        closeKbm();
      } else if (e.key === 'Tab') {
        const controls = [...osagoDialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]')]
          .filter((control) => control.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        const active = document.activeElement;
        if (first && last && (!controls.some((control) => control === active) || active === (e.shiftKey ? first : last))) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
      return;
    }
    if ((state === 'drive' || state === 'pause') && (e.code === 'Escape' || e.code === 'KeyP')) {
      e.preventDefault();
      if (!e.repeat) {
        if (state === 'drive') pause();
        else resume();
      }
      return;
    }
    const focusedControl = e.target instanceof Element &&
      e.target.closest('button, a, input, select, textarea, [contenteditable]');
    if (state === 'station') {
      if (e.defaultPrevented || (focusedControl && e.code !== 'Escape')) return;
      if (e.code === 'Enter' || e.code === 'Escape' || e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        if (!e.repeat) $(e.code === 'Enter' ? 'stFull' : 'stLeave').click();
      }
      return;
    }
    if (state === 'over' && e.code === 'Enter' && !focusedControl) {
      $('ovAgain').click();
    }
    if (state === 'protocol' && (e.code === 'Enter' || e.code === 'Space')) $('prSign').click();
    if (state === 'garage' || state === 'renewal') {
      if (focusedControl) return;
      if (e.code === 'Enter' || e.code === 'Space') $('go').click();
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
    if (!$('kbm').inert) return;
    if (state === 'renewal') {
      wallet -= insCost();
      lsSet('doroga.wallet', wallet);
      drive.renewInsurance({ ...ins, osagoPrice: osagoPrice(kbm) }, wallet);
      runClosed = false;
      state = 'drive';
      input.clear();
      input.enabled = true;
      clock.update();
      show('hud');
      return;
    }
    if (state !== 'garage') return;
    // на телефоне — сразу на весь экран и горизонтально (нажатие — жест пользователя, браузер разрешит)
    if (touchControls.matches) enterFs(true);
    startDrive();
  });
  $('pauseBtn').addEventListener('click', pause);
  $('resume').addEventListener('click', resume);
  $('restart').addEventListener('click', async () => { finishRun(); await startDrive(); });
  $('toGarage').addEventListener('click', () => {
    if (state !== 'pause') return;
    drive.v = 0;
    drive.phase = 'stopped';
    showRunSummary();
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
    const toExit = drive.nextExitStartDist, toStation = drive.nextServiceDist;
    const r50 = (m: number) => Math.max(50, Math.round(m / 50) * 50);
    const kind = drive.nextExitKind;
    const place = kind === 'repair' ? '🔧 Автосервис' : '⛽ Заправка';
    const toPlace = toStation;
    const toPolice = drive.policeS !== null && drive.policeFine === 0 ? drive.policeS - drive.s : Infinity;
    const toFinish = drive.finishS - drive.s;
    if (ph === 'finish') setBanner('🏁 Финиш!');
    else if (!drive.endless && ph === 'drive' && toFinish > 0 && toFinish < 500) setBanner(`🏁 Финиш через ${r50(toFinish)} м`);
    else if (ph === 'policeIn' || ph === 'protocol') setBanner('🚓 Остановка ДПС<small>проверка документов</small>', true);
    else if (ph === 'drive' && toPolice > 0 && toPolice < 450) setBanner(`🚓 Впереди пост ДПС<small>через ${r50(toPolice)} м · полиса ОСАГО нет</small>`, true);
    else if (ph === 'pitIn' || ph === 'refuel') setBanner(drive.stationKind === 'repair' ? '🔧 Заезжаем в автосервис' : '⛽ Заезжаем на заправку');
    else if (drive.waitingToMerge) setBanner('Ждём свободную полосу');
    else if (ph === 'pitOut' || ph === 'policeOut') setBanner('Выезжаем на дорогу');
    else if (ph === 'empty') setBanner('Топливо кончилось', true);
    else if (ph === 'wrecked') setBanner('Машина разбита', true);
    else if (ph === 'drive' && drive.lane === 2) setBanner(`${place}<small>${kind === 'repair' ? 'бокс' : 'колонка'} через ${r50(toPlace)} м</small>`);
    else if (ph === 'drive' && toExit < 700 && toPlace > 30) {
      const urgent = kind === 'repair' ? hp < 0.35 : f < 0.2;
      setBanner(!drive.exitOpen
        ? `${place} через ${r50(toExit)} м<small>перестройтесь в правую полосу</small>`
        : `${place}: съезд открыт<small>${touchControls.matches ? 'свайп вправо' : '→'} — съехать</small>`, urgent);
    } else if (hp < 0.35 && ph === 'drive') {
      setBanner(`Машина повреждена: ${Math.round(drive.health)} %<small>ремонт через ${(toStation / 1000).toFixed(1)} км</small>`, true);
    } else if (f < 0.2 && ph === 'drive') {
      setBanner(`Мало топлива: ${Math.ceil(drive.fuel)} л<small>до заправки ${(toStation / 1000).toFixed(1)} км · хватит на ${(drive.fuel / LITERS_PER_KM).toFixed(1)} км</small>`, true);
    } else setBanner('');
  };

  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  $('tripBar').parentElement!.hidden = !SHOT;
  if (!SHOT) $('odoGoal').textContent = 'км';
  const dateLabel = $('calendarDate');
  const frame = (dt: number, elapsed = dt) => {
    time += dt;
    if (state === 'garage' || state === 'loading') {
      if (startingDrive && state === 'loading') return;
      if (garage) {
        garage.update(dt);
        renderer.render(garage.scene, garage.camera, time);
      } else if (drive) renderer.render(drive.scene, drive.camera, time);
      return;
    }
    if (state === 'station' || state === 'over' || state === 'protocol' || state === 'breakdown') {
      // мир живёт: трафик едет мимо, машина стоит
      drive.update(dt, { throttle: 0, brake: 0, laneShift: 0 }, time);
      updateHud();
    }
    if (state === 'drive') {
      if (drive.phase !== 'intro' && !drive.waitingToMerge) activeRunSeconds += elapsed;
      input.poll();
      drive.update(dt, { throttle: input.throttle, brake: input.brake, laneShift: input.take() }, time, elapsed);
      updateHud();
      if (drive.phase === 'drive' && !input.enabled) input.enabled = true;
      if (drive.phase === 'drive') hintTimer += dt;
      if (hintTimer > 7) {
        $('ctrlHint').classList.add('hide');
        $('touchHint').classList.add('hide');
      }
      const kmh = Math.round(drive.speedKmh);
      if (kmh !== lastSpeed) {
        lastSpeed = kmh;
        speedEl.textContent = String(kmh);
        arcEl.style.strokeDashoffset = String(SPEEDO_LEN * (1 - Math.min(1, kmh / cfg.maxSpeedKmh)));
      }
      setOdo((drive.endless ? drive.odometer : drive.tripDone) / 100);
      if (drive.endless) {
        const date = `${drive.calendarDay} ${months[drive.month]}`;
        if (dateLabel.textContent !== date) dateLabel.textContent = date;
      } else {
        $('odoGoal').textContent = `/ ${drive.tripKm} км`;
        $('tripBar').style.width = `${Math.min(100, (drive.tripDone / (drive.tripKm * 1000)) * 100)}%`;
      }
    }
    renderer.render(drive.scene, drive.camera, time);
  };

  if (SHOT && garage) {
    const [{ runShot }, scene] = await Promise.all([import('./shot'), prepareDrive()]);
    scene.attachCar(car, cfg);
    scene.reset(true);
    garage.attachCar(car);
    await runShot(SHOT, { renderer, garage, drive: scene, frame, startDrive, enterGarage });
    return;
  }

  await prepareDrive();
  enterGarage();
  renderer.gl.setAnimationLoop((t) => {
    clock.update(t);
    const elapsed = Math.max(0, clock.getDelta());
    frame(Math.min(elapsed, 0.1), elapsed);
  });
}

main().catch((e) => {
  console.error(e);
  loadBar(1, 'Ошибка: ' + (e?.message || e));
});
