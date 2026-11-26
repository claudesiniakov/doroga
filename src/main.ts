import * as THREE from 'three';
import './style.css';
import './interface.css';
import './home.css';
import cars from './cars.json';
import { Renderer, detectQuality, QualityName } from './render';
import type { CarConfig } from './car';
import { buildPlayerCar } from './player-car';
import { KBM, loadKbm, saveKbm, osagoPrice, osagoFactors, kbmNext, fmtK } from './kbm';
import { GarageScene } from './garage';
import type { DriveScene } from './drive';
import { START_COINS, DAYS_PER_SECOND, CHARGE_PRICE, KASKO, REPAIR_PRICE, POLICE_FINE } from './drive-rules';
import { Input } from './input';
import { OSAGO_LESSON } from './osago-lesson';
import { finishRecordRun, formatRecordDays, loadRecords, MAX_NICKNAME_LENGTH, saveRecord, startRecordRun } from './records';
import { checkNickname } from '../server/nickname-rules.mjs';

type State = 'loading' | 'garage' | 'drive' | 'pause' | 'station' | 'over' | 'protocol' | 'renewal' | 'breakdown' | 'yearReport' | 'returningHome' | 'policeCheck' | 'caught';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const coinAmount = (value: string | number) => {
  const amount = document.createElement('span');
  amount.className = 'coin-amount';
  const icon = document.createElement('span');
  icon.className = 'coin';
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', 'монет');
  amount.append(String(value), icon);
  return amount;
};

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // служебный режим для автоматических снимков
if (SHOT) document.documentElement.classList.add('shot');

const screens = ['loading', 'garage', 'hud', 'pause', 'station', 'breakdown', 'over', 'kbm', 'protocol', 'yearReport', 'policeCheck', 'caught'] as const;
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
  let noticeTimer = 0;
  const notify = (text: string) => {
    const toast = $('toast');
    const line = document.createElement('div');
    line.textContent = text;
    toast.replaceChildren(line);
    toast.classList.remove('ok');
    toast.classList.add('on');
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => toast.classList.remove('on'), 3200);
  };
  renderer.onContextLost = () => {
    if (state === 'drive') pause();
    notify('Видеокарта пересоздаёт контекст — игра на паузе');
  };
  renderer.onContextRestored = () => {
    renderer.resize();
    notify('Графика восстановлена');
  };
  const pmrem = new THREE.PMREMGenerator(renderer.gl);
  if (!SHOT) {
    const built = new Date(__BUILD_TIME__);
    const stamp = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
    }).format(built);
    const buildTag = $('buildTag');
    buildTag.textContent = `${__BUILD_REV__} · ${stamp} МСК`;
    buildTag.title = `Сборка: ${built.toISOString()}`;
    buildTag.hidden = false;
  }
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
    if (drive) return drive;
    const scene = new DriveScene(pmrem, renderer.quality.textureSize, renderer.anisotropy, Number(params.get('seed') || 1337));
    if (SHOT) scene.setSnow(params.get('snow') !== '0');
    scene.setShadowMapSize(renderer.quality.shadowMap);
    scene.resize(innerWidth / innerHeight);
    Object.assign(scene, { onStation, onPolice, onPoliceCheck, onCaught, onPickup, onDamage, onEmpty, onCrash, onYearEnd });
    drive = scene;
    return scene;
  };

  // ——— кошелёк, поездки, статистика (сохраняются между поездками) ———
  const lsNum = (k: string, d: number) => {
    try { const raw = localStorage.getItem(k); const v = Number(raw); return raw !== null && Number.isFinite(v) ? v : d; } catch { return d; }
  };
  const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* нет хранилища */ } };
  /** Награда за успешно закрытый страховой год. */
  const YEAR_BONUS = 25;
  let wallet = lsNum('doroga.wallet', START_COINS);
  let trip = lsNum('doroga.trip', 1);
  let kaskoPrice = lsNum('doroga.kaskoPrice', KASKO);
  const fmtKm = (km: number) => `${km.toFixed(1).replace('.', ',')} км`;
  const updateEconomyUI = () => {
    $('walletTop').textContent = String(wallet);
    $('walletCard').textContent = String(wallet);
    $('go').textContent = state === 'renewal'
      ? (ins.osago || ins.kasko ? 'Продолжить путь' : 'Продолжить без страховки') : 'Поехать';
  };

  const ownRecordKey = 'doroga.ownTimeRecords';
  const recordNicknameKey = 'doroga.recordNickname';
  let lastRecordNickname = '';
  const ownRecords = new Set<number>();
  try { lastRecordNickname = localStorage.getItem(recordNicknameKey) ?? ''; } catch { /* нет хранилища */ }
  try {
    const saved = JSON.parse(localStorage.getItem(ownRecordKey) ?? '[]');
    if (Array.isArray(saved)) {
      for (const key of saved) if (Number.isSafeInteger(key)) ownRecords.add(key);
    }
  } catch { /* нет хранилища */ }

  let recordSaved = false;
  let rankingRun: Promise<string | undefined> | undefined;
  let activeRunSeconds = 0;
  let runCrashes = 0;
  let rankedSummary: { durationMs: number; run: Promise<string | undefined>; finished: Promise<boolean> } | undefined;
  let savingRecord = false;
  let recordLoad = 0;
  const recordForm = $<HTMLFormElement>('recordForm');
  const recordNickname = $<HTMLInputElement>('recordNickname');
  const ovAgain = $<HTMLButtonElement>('ovAgain');
  const ovGarage = $<HTMLButtonElement>('ovGarage');
  const recordStatus = $('recordStatus');
  recordNickname.maxLength = MAX_NICKNAME_LENGTH;
  const isValidRecordNickname = (nickname: string) => checkNickname(nickname).ok;
  recordNickname.addEventListener('input', () => {
    const nickname = recordNickname.value.trim();
    if (!isValidRecordNickname(nickname) || nickname === lastRecordNickname) return;
    lastRecordNickname = nickname;
    lsSet(recordNicknameKey, nickname);
  });
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
  const saveSummaryRecord = async () => {
    const summary = rankedSummary;
    const nickname = recordNickname.value.trim();
    if (!summary || recordSaved || recordNickname.disabled || !nickname) return true;
    recordStatus.hidden = false;
    const verdict = checkNickname(nickname);
    if (!verdict.ok) {
      recordStatus.textContent = `${verdict.reason}. Придумайте другой ник.`;
      recordNickname.focus();
      return false;
    }
    savingRecord = true;
    recordNickname.disabled = ovAgain.disabled = ovGarage.disabled = true;
    recordStatus.textContent = 'Сохраняем результат…';
    try {
      const run = await summary.run;
      if (!run) {
        recordStatus.textContent = 'Сервер рекордов был недоступен при старте заезда.';
        return true;
      }
      if (!await summary.finished) await finishRecordRun(run, summary.durationMs);
      const { place, id } = await saveRecord(nickname, run);
      if (place <= 100) {
        ownRecords.add(id);
        lsSet(ownRecordKey, [...ownRecords]);
      }
      recordSaved = true;
      recordStatus.textContent = place <= 100 ? `Результат сохранён. Место №${place}.`
        : `Результат сохранён. Место №${place} в общем рейтинге.`;
      return true;
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : '';
      recordStatus.textContent = reason
        ? `${reason}. Придумайте другой ник или очистите поле, чтобы выйти.`
        : 'Не удалось сохранить результат. Повторите попытку или очистите поле ника, чтобы выйти.';
      recordNickname.focus();
      return false;
    } finally {
      savingRecord = false;
      recordNickname.disabled = ovAgain.disabled = ovGarage.disabled = false;
    }
  };
  recordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    ovAgain.click();
  });

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
  let renderedBackdrop: State | undefined;
  const desktopPreview = matchMedia('(pointer: fine) and (min-width: 900px)');
  const previewLeft = () => desktopPreview.matches
    ? (document.querySelector('.home-layout')!.getBoundingClientRect().right + 24) / innerWidth
    : undefined;

  // В альбомной ориентации спидометр-полоса ставится ровно между чипами и месяцем.
  const speedoEl = document.querySelector('.speedo') as HTMLElement;
  const landscapeHud = matchMedia('(max-height: 500px) and (orientation: landscape)');
  const layoutHud = () => {
    if (!touchControls.matches || !landscapeHud.matches) {
      speedoEl.style.left = '';
      speedoEl.style.right = '';
      return;
    }
    const left = document.querySelector('.hud-left')!.getBoundingClientRect();
    const month = $('calendarDate').getBoundingClientRect();
    const pad = 12;
    speedoEl.style.left = `${Math.round(left.right + pad)}px`;
    speedoEl.style.right = `${Math.round(innerWidth - month.left + pad)}px`;
  };
  const resize = () => {
    renderedBackdrop = undefined;
    renderer.resize();
    garage?.resize(innerWidth / innerHeight);
    drive?.resize(innerWidth / innerHeight, previewLeft());
  };
  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 120);
  });
  resize();

  const fade = async (on: boolean) => {
    $('fade').classList.toggle('on', on);
    await sleep(SHOT ? 0 : 620);
  };

  const enterGarage = () => {
    void renderRecords();
    if (garage) garage.attachCar(car);
    else drive?.previewRoad(car, cfg, previewLeft());
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
    $('fade').classList.remove('on');
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
      $('policeFlash').hidden = true;
      runClosed = false;
      activeRunSeconds = 0;
      setOdo(0);
      runCrashes = 0;
      rankingRun = startRecordRun().catch(() => undefined);
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

  // Скидка по КБМ начисляется только за безаварийный страховой период, завершившийся сменой года.
  let kbm = loadKbm();
  let runClosed = true;
  let lastKbmChange: { from: number; to: number } | null = null;
  let lastTrip = { finished: false, km: 0, crashes: 0, reward: 0, num: 1 };
  const finishRun = (renewingInsurance = false) => {
    if (runClosed) return;
    $('policeFlash').hidden = true;
    runClosed = true;
    // итог поездки: кошелёк и статистика
    const finished = drive.endReason === 'year';
    const km = drive.tripDone / 1000;
    lastTrip = { finished, km, crashes: drive.crashes, reward: 0, num: trip };
    // Кошелёк переносится целиком при любом окончании заезда: прогресс не сгорает.
    // За успешно закрытый год — ещё и награда.
    wallet = Math.max(0, drive.coins) + (renewingInsurance ? YEAR_BONUS : 0);
    runCrashes += drive.crashes;
    if (finished) trip++;
    if (drive.insurance.kasko) {
      kaskoPrice = Math.round(Math.min(200, Math.max(10, kaskoPrice * (drive.kaskoRepairUsed ? 1.1 + Math.random() * 0.2 : 0.95 - Math.random() * 0.15))));
    }
    lsSet('doroga.wallet', wallet); lsSet('doroga.trip', trip); lsSet('doroga.kaskoPrice', kaskoPrice);
    lastKbmChange = null;
    if (drive.insurance.osago && (renewingInsurance || drive.crashes > 0)) {
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
  input.onCamera = () => drive?.toggleCamera();

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
  const kbmReference = $('osagoKbmTable');
  const referenceTable = $('osagoLessonTable');
  const lessonDetails = $<HTMLDetailsElement>('osagoDetails');
  const lessonBack = $<HTMLButtonElement>('osagoBack');
  const lessonNext = $<HTMLButtonElement>('osagoNext');
  const formatFactor = (factor: number) => String(factor).replace('.', ',');

  const renderKbmTable = () => {
    $('kbmBody').innerHTML = KBM.map((r, i) =>
      `<tr class="${i === kbm ? 'cur' : ''}"><td class="c">${r.cls}</td><td>${fmtK(r.k)}</td>` +
      r.next.map((n) => `<td class="n">${KBM[n].cls}</td>`).join('') + '</tr>').join('');
    const afford = insCost() + osagoPrice(kbm) <= wallet;
    const buy = $<HTMLButtonElement>('kbmBuy');
    buy.replaceChildren(...(ins.osago ? ['ОСАГО уже выбрано'] : afford
      ? ['Выбрать ОСАГО за ', coinAmount(osagoPrice(kbm))] : ['Не хватает монет']));
    buy.disabled = ins.osago || !afford;
  };

  const showOsagoConfirmation = () => {
    lesson.hidden = true;
    confirmation.hidden = false;
    $('kbmTitle').textContent = 'Оформление ОСАГО';
    $('osagoCalculation').replaceChildren(`${osagoFactors(kbm).map(formatFactor).join(' × ')} ≈ `, coinAmount(osagoPrice(kbm)));
  };

  const renderOsagoCard = () => {
    const card = OSAGO_LESSON[lessonIndex];
    lesson.hidden = false;
    confirmation.hidden = true;
    $('kbmTitle').textContent = 'Как рассчитывается стоимость ОСАГО?';
    $('osagoCount').textContent = `${lessonIndex + 1} / ${OSAGO_LESSON.length}`;
    const factors = document.createDocumentFragment();
    OSAGO_LESSON.forEach(({ factor }, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `osago-factor${index === lessonIndex ? ' current' : ''}`;
      chip.textContent = factor;
      chip.setAttribute('aria-current', String(index === lessonIndex));
      chip.addEventListener('click', () => {
        if (index === lessonIndex) return;
        lessonIndex = index;
        renderOsagoCard();
        document.querySelector<HTMLButtonElement>('#osagoFactors .osago-factor.current')?.focus({ preventScroll: true });
      });
      factors.append(chip);
      if (index < OSAGO_LESSON.length - 1) {
        const times = document.createElement('span');
        times.className = 'osago-times';
        times.textContent = '×';
        times.setAttribute('aria-hidden', 'true');
        factors.append(times);
      }
    });
    $('osagoFactors').replaceChildren(factors);
    $('osagoCardTitle').textContent = card.title;
    $('osagoExplanation').textContent = card.explanation;
    const example = formatFactor(osagoFactors(kbm)[lessonIndex]);
    $('osagoGameValue').replaceChildren('В игре · ', lessonIndex === 0 ? coinAmount(example) : `${card.factor} = ${example}`);
    lessonBack.disabled = lessonIndex === 0;
    lessonNext.textContent = lessonIndex === OSAGO_LESSON.length - 1 ? 'К оформлению' : 'Далее';
    referenceTable.replaceChildren();
    lessonDetails.open = false;
    const isKbm = card.factor === 'КБМ';
    kbmReference.hidden = !isKbm;
    referenceTable.hidden = !card.table;
    lessonDetails.hidden = !isKbm && !card.table;
    if (isKbm) {
      $('osagoTableTitle').textContent = 'Таблица КБМ';
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

  // ——— автосервис: ремонт и зарядка ———
  let stationService: 'repair' | 'charge' = 'repair';
  const updateStation = () => {
    const repair = stationService === 'repair';
    for (const [id, active] of [['stRepairTab', repair], ['stChargeTab', !repair]] as const) {
      const tab = $(id);
      tab.classList.toggle('on', active);
      tab.setAttribute('aria-pressed', String(active));
    }
    const canLeave = drive.fuel > 0 && drive.health > 0;
    const leave = $<HTMLButtonElement>('stLeave');
    leave.disabled = !canLeave;
    leave.textContent = canLeave ? 'Уехать'
      : drive.health <= 0 ? 'Для выезда нужен ремонт' : 'Для выезда нужен заряд';
    $('stEnd').hidden = canLeave;
    const full = $<HTMLButtonElement>('stFull'), ten = $<HTMLButtonElement>('stTen');
    $('stCoins').textContent = String(drive.coins);
    $('stEyebrow').textContent = 'Автосервис';
    if (repair) {
      $('stTitle').textContent = 'Отремонтировать?';
      $('stTank').textContent = String(Math.round(drive.health));
      $('stUnit').textContent = '%';
      $('stTankBar').style.width = `${drive.health}%`;
      $('stBarWrap').classList.add('hp');
      const kasko = drive.insurance.kasko;
      $('stPrice').replaceChildren(...(kasko ? ['по КАСКО — бесплатно'] : [coinAmount(REPAIR_PRICE), ' за 10 %']));
      const need = Math.max(0, 100 - drive.health);
      const canPct = kasko ? need : Math.min(need, Math.floor(drive.coins / REPAIR_PRICE) * 10);
      full.disabled = canPct <= 0;
      full.replaceChildren(...(need <= 0 ? ['Машина целая']
        : canPct <= 0 ? ['Не хватает монет']
          : [canPct < need ? `Ремонт · +${canPct} % за ` : 'Полный ремонт · ',
            kasko ? 'бесплатно' : coinAmount(drive.repairCost(canPct))]));
      ten.disabled = canPct <= 0;
      ten.replaceChildren('+10 % · ', kasko ? 'бесплатно' : coinAmount(REPAIR_PRICE));
      ten.style.display = need > 10 && canPct > 0 ? '' : 'none';
    } else {
      $('stTitle').textContent = 'Зарядить батарею?';
      $('stTank').textContent = String(Math.round(drive.fuel));
      $('stUnit').textContent = '%';
      $('stTankBar').style.width = `${drive.fuel}%`;
      $('stBarWrap').classList.remove('hp');
      $('stPrice').replaceChildren(coinAmount(CHARGE_PRICE), ' за 10 %');
      const need = Math.max(0, 100 - drive.fuel);
      const canPct = Math.min(need, Math.floor(drive.coins / CHARGE_PRICE) * 10);
      full.disabled = canPct <= 0;
      full.replaceChildren(...(need <= 0 ? ['Батарея полная']
        : canPct <= 0 ? ['Не хватает монет']
          : [canPct < need ? `Заряд · +${canPct} % за ` : 'Полный заряд · ', coinAmount(drive.chargeCost(canPct))]));
      ten.disabled = canPct <= 0;
      ten.replaceChildren('+10 % · ', coinAmount(CHARGE_PRICE));
      ten.style.display = need > 10 && canPct > 0 ? '' : 'none';
    }
  };
  const onStation: NonNullable<DriveScene['onStation']> = () => {
    stationService = drive.health <= 0 ? 'repair' : drive.fuel <= 0 ? 'charge' : 'repair';
    state = 'station';
    input.enabled = false;
    updateStation();
    show('hud', 'station');
  };
  const buyService = (full: boolean) => {
    if (state !== 'station') return;
    if (stationService === 'repair') drive.repair(full ? 100 : 10);
    else drive.charge(full ? 100 : 10);
    updateStation();
  };
  $('stRepairTab').addEventListener('click', () => { stationService = 'repair'; updateStation(); });
  $('stChargeTab').addEventListener('click', () => { stationService = 'charge'; updateStation(); });
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
    if (drive.insurance.osago) {
      // Полис в порядке: протокол не составляется, штрафа нет.
      $('prTitle').textContent = 'ПРОВЕРКА';
      $('prSub').textContent = 'документов';
      $('prViolation').textContent = 'полис ОСАГО действует — нарушений не выявлено';
      $('prFine').textContent = 'нет';
      $('prSign').replaceChildren('Продолжить');
    } else {
      $('prTitle').textContent = 'ПРОТОКОЛ';
      $('prSub').textContent = 'об административном правонарушении';
      $('prViolation').textContent = 'управление транспортным средством при заведомо отсутствующем полисе ОСАГО — ч. 2 ст. 12.37 КоАП РФ';
      const fine = $('prFine');
      fine.replaceChildren('штраф ', coinAmount(POLICE_FINE));
      if (drive.policeFine < POLICE_FINE) fine.append(' (списано ', coinAmount(drive.policeFine), ' — больше нет)');
      $('prSign').replaceChildren('Подписать · ', coinAmount(`−${drive.policeFine}`));
    }
    show('hud', 'protocol');
  };
  const onPoliceCheck: NonNullable<DriveScene['onPoliceCheck']> = () => {
    state = 'policeCheck';
    input.enabled = false;
    $('policeNote').textContent = drive.insurance.osago
      ? 'Полис ОСАГО действует: остановитесь, инспектор сверит документы. Уход от требования об остановке — нарушение.'
      : 'Полиса у вас нет: остановитесь и подпишите протокол. Уход от требования об остановке — нарушение.';
    show('hud', 'policeCheck');
    $('policeStop').focus({ preventScroll: true });
  };
  const onCaught: NonNullable<DriveScene['onCaught']> = () => {
    state = 'caught';
    input.enabled = false;
    $('policeFlash').hidden = true;
    $('toast').classList.remove('on');
    // Если в погоне было ДТП — это уже неповиновение (19.3 КоАП), а не только уход от остановки.
    $('caughtArticle').textContent = drive.chaseCrashes > 0
      ? `Ст. 19.3 ч. 1 КоАП РФ — неповиновение законному распоряжению сотрудника полиции: штраф от 500 до 1 000 ₽ или административный арест до 15 суток. Во время погони вы стали участником ДТП (${drive.chaseCrashes}). В игре — конец заезда и потеря прогресса года.`
      : 'Ст. 12.25 ч. 2 КоАП РФ — невыполнение законного требования сотрудника полиции об остановке транспортного средства: штраф от 500 до 800 ₽. В игре — конец заезда и потеря прогресса года.';
    show('hud', 'caught');
    $('caughtRestart').focus({ preventScroll: true });
  };
  $('policeStop').addEventListener('click', () => {
    if (state !== 'policeCheck') return;
    // Возвращаемся в заезд: машина сама плавно съедет на обочину и встанет.
    state = 'drive';
    input.enabled = true;
    show('hud');
    drive.stopAtPolice();
  });
  $('policeFlee').addEventListener('click', () => {
    if (state !== 'policeCheck') return;
    state = 'drive';
    input.enabled = true;
    show('hud');
    drive.startChase();
    $('policeFlash').hidden = false;
    const toast = $('toast');
    const warn = document.createElement('div');
    warn.textContent = 'Нарушать закон плохо!';
    const chase = document.createElement('div');
    chase.textContent = 'За вами погоня — не тормозите';
    toast.replaceChildren(warn, chase);
    toast.classList.remove('ok');
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('on'), 4500);
  });
  $('caughtRestart').addEventListener('click', async () => {
    if (state !== 'caught') return;
    $('policeFlash').hidden = true;
    finishRun();
    // Новый заезд тоже начинается с выбора страховки.
    state = 'returningHome';
    await fade(true);
    enterGarage();
    await fade(false);
  });
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
  const onPickup: NonNullable<DriveScene['onPickup']> = (_kind, amount) => {
    const toast = $('toast');
    const line = document.createElement('div');
    line.textContent = `+${amount} % заряда`;
    toast.replaceChildren(line);
    toast.classList.add('ok');
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('on'), 2600);
  };
  const onDamage: NonNullable<DriveScene['onDamage']> = ({ ownDamage, thirdPartyDamage, paidToVictim, covered }) => {
    const t = $('toast');
    const damage = document.createElement('div');
    damage.textContent = `Урон вашей машине: −${ownDamage} %`;
    const payout = document.createElement('div');
    payout.append(covered ? 'По ОСАГО выплатили пострадавшему: ' : 'Вы выплатили пострадавшему из своих: ', coinAmount(paidToVictim));
    if (paidToVictim < thirdPartyDamage) payout.append(' из ', coinAmount(thirdPartyDamage));
    t.replaceChildren(damage, payout);
    t.classList.toggle('ok', covered);
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.classList.remove('on'), 3600);
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
    $('ovEyebrow').hidden = true;
    $('ovEyebrow').textContent = `Страховой год №${t.num}`;
    $('ovTitle').textContent = drive.endReason === 'wreck' ? 'Машина разбита'
      : drive.endReason === 'charge' ? 'Заряд кончился' : 'Заезд завершён';
    const durationMs = Math.floor(activeRunSeconds * 1000);
    recordSaved = false;
    rankedSummary = undefined;
    recordForm.reset();
    recordNickname.value = lastRecordNickname;
    recordNickname.disabled = false;
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
      void run.then((token) => {
        if (summary !== rankedSummary || state !== 'over' || savingRecord) return;
        if (!token) {
          recordNickname.disabled = true;
          recordStatus.hidden = false;
          recordStatus.textContent = 'Сервер рекордов был недоступен при старте заезда.';
        }
      });
    }
    $('ovGarage').textContent = 'На главную';
    $('ovKmRow').hidden = true;
    $('ovKm').textContent = fmtKm(t.km);
    $('ovDaysRow').hidden = false;
    $('ovDays').textContent = formatRecordDays(durationMs);
    $('ovRewardRow').style.display = 'none';
    $('ovCrashes').textContent = String(runCrashes);
    const { osago, kasko, ownVictims, ownService, hadOsago, hadKasko } = drive.payouts;
    $('ovOsagoRow').hidden = !hadOsago;
    $('ovKaskoRow').hidden = !hadKasko;
    $('ovOsago').replaceChildren(coinAmount(osago));
    $('ovKasko').replaceChildren(coinAmount(kasko));
    $('ovOwnVictims').replaceChildren(coinAmount(ownVictims));
    $('ovOwnService').replaceChildren(coinAmount(ownService));
    $('ovWalletRow').hidden = true;
    $('ovCoins').textContent = String(wallet);
    $('ovAgain').textContent = 'Начать новый заезд';
    const ch = lastKbmChange;
    $('ovKbmRow').hidden = !ch;
    if (ch) $('ovKbm').replaceChildren(...(ch.from === ch.to ? [`класс ${KBM[ch.to].cls} (без изменений)`]
      : [`класс ${KBM[ch.from].cls} → ${KBM[ch.to].cls} · ОСАГО `, coinAmount(osagoPrice(ch.from)), ' → ', coinAmount(osagoPrice(ch.to))]));
    show('hud', 'over');
  };
  const onEmpty: NonNullable<DriveScene['onEmpty']> = () => {
    if (drive.endReason === 'wreck') {
      state = 'breakdown';
      input.enabled = false;
      $('towWallet').textContent = String(drive.coins);
      const cost = drive.assistanceCost;
      const minimum = drive.assistanceMinimumCost;
      $('towPrice').replaceChildren(coinAmount(cost));
      $('towRepair').replaceChildren(coinAmount(drive.repairCost(10)));
      const call = $<HTMLButtonElement>('towCall');
      call.disabled = drive.coins < minimum;
      call.replaceChildren(...(call.disabled ? ['Для выезда нужно ', coinAmount(minimum)]
        : cost === 0 ? ['Вызвать помощь по КАСКО'] : ['Вызвать помощь · ', coinAmount(cost)]));
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
    $('yearBonus').textContent = String(YEAR_BONUS);
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
      $('insuranceHeading').textContent = 'Страховка на новый год';
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
    if (state !== 'station' || drive.health > 0) return;
    drive.endReason = 'wreck';
    drive.phase = 'stopped';
    showRunSummary();
  });
  // Сохранение рекорда не должно блокировать выход с итогов.
  const leaveSummary = async (openRecords: boolean) => {
    if (state !== 'over' || savingRecord) return;
    await saveSummaryRecord().catch(() => false);
    if (state !== 'over') return;
    state = 'returningHome';
    await fade(true);
    enterGarage();
    await fade(false);
    if (openRecords && recordSaved) openRecordsTab();
  };
  ovAgain.addEventListener('click', () => { void leaveSummary(false); });
  ovGarage.addEventListener('click', () => { void leaveSummary(true); });
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
    // На телефоне кнопка полного экрана нужна и во время заезда — в обеих ориентациях.
    if (touchControls.matches) {
      $('fsHud').hidden = false;
      $('fsHud').addEventListener('click', () => (isFs() ? document.exitFullscreen?.() : enterFs(false)));
    }
  }
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => setTimeout(resize, 50));
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
    renderedBackdrop = undefined;
    drive.setShadowMapSize(renderer.quality.shadowMap);
    markQuality();
  });

  const SPEEDO_LEN = 252;
  const speedEl = $('speed'), arcEl = $('speedArc'), odoEl = $('odo'), speedBar = $('speedBar');
  const drums = [...odoEl.querySelectorAll<HTMLElement>('.drum')].reverse();
  const initialDrumCount = drums.length;
  const drumPos = drums.map(() => -1);
  const drumAnimations: (Animation | undefined)[] = [];
  let lastOdo = -1;
  function setOdo(value: number) {
    const v = Math.max(0, value);
    if (v === lastOdo) return;
    const animate = !SHOT && v === lastOdo + 1 && lastOdo >= 0 &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches;
    lastOdo = v;
    if (!SHOT) {
      if (v === 0) {
        for (const drum of drums.splice(initialDrumCount)) drum.remove();
        drumPos.length = drumAnimations.length = initialDrumCount;
      }
      while (v >= 10 ** drums.length) {
        const drum = drums[1].cloneNode(true) as HTMLElement;
        drum.style.setProperty('--p', '0');
        odoEl.prepend(drum);
        drums.push(drum);
        drumPos.push(0);
      }
      odoEl.setAttribute('aria-label', formatRecordDays(v * 1000));
    }
    const frac = v % 1;
    for (let i = 0; i < drums.length; i++) {
      const unit = 10 ** i;
      const digit = Math.floor(v / unit) % 10;
      const rolling = i === 0 ? frac : (v % unit) >= unit - 1 ? frac : 0;   // все младшие на «9» — переносим
      const p = Math.round((digit + rolling) * 100) / 100;
      const previous = drumPos[i];
      if (p === previous) continue;
      const drum = drums[i];
      drumAnimations[i]?.cancel();
      drum.style.setProperty('--p', String(p));
      if (animate) {
        // Последний ноль на ленте дублирует первый и даёт прокрутку вперёд через девятку.
        drumAnimations[i] = drum.animate(
          [{ '--p': String(previous) }, { '--p': String(previous === 9 && p === 0 ? 10 : p) }],
          { duration: 240, easing: 'ease-out' },
        );
      }
      drumPos[i] = p;
    }
  }
  setOdo(0);
  let lastSpeed = -1;

  const fuelBox = $('fuelBox'), fuelBar = $('fuelBar'), fuelL = $('fuelL'), coinsEl = $('coins'), banner = $('banner');
  const hpBox = $('hpBox'), hpBar = $('hpBar'), hpVal = $('hpVal'), hudNote = $('hudNote');
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
    // Игровое время: одна секунда = один день, поэтому расстояние переводим в дни по текущей скорости.
    // Дни идут быстрее, поэтому за день машина проезжает больше метров.
    const daysFor = (meters: number) => Math.max(1, Math.round(meters / Math.max(10, drive.v * DAYS_PER_SECOND)));
    const toExit = drive.nextExitStartDist, toStation = drive.nextServiceDist;
    const place = '🔧 Автосервис';
    const toPlace = toStation;
    const toPolice = drive.policeS !== null && drive.policeFine === 0 ? drive.policeS - drive.s : Infinity;
    if (ph === 'policeIn' || ph === 'protocol') setBanner('🚓 Остановка ДПС<small>проверка документов</small>', true);
    else if (ph === 'drive' && toPolice > 0 && toPolice < 450) setBanner(`🚓 Впереди пост ДПС<small>через ${daysFor(toPolice)} дн. · ${drive.insurance.osago ? 'проверка документов' : 'полиса ОСАГО нет'}</small>`, true);
    else if (ph === 'pitIn' || ph === 'refuel') setBanner('🔧 Заезжаем в автосервис');
    else if (drive.waitingToMerge) setBanner('Ждём свободную полосу');
    else if (ph === 'pitOut' || ph === 'policeOut') setBanner('Выезжаем на дорогу');
    else if (ph === 'empty') setBanner('Заряд кончился', true);
    else if (ph === 'wrecked') setBanner('Машина разбита', true);
    else if (ph === 'drive' && drive.lane === 2) setBanner(`${place}<small>бокс через ${daysFor(toPlace)} дн.</small>`);
    else if (ph === 'drive' && toExit < 700 && toPlace > 30) {
      const urgent = hp < 0.35;
      setBanner(!drive.exitOpen
        ? `${place} через ${daysFor(toExit)} дн.<small>перестройтесь в правую полосу</small>`
        : `${place}: съезд открыт<small>${touchControls.matches ? 'свайп вправо' : '→'} — съехать</small>`, urgent);
    } else setBanner('');
    const notes: string[] = [];
    if (ph === 'drive' && hp < 0.35) notes.push(`Ремонт через ${daysFor(toStation)} дн.`);
    hudNote.textContent = notes.join(' · ');
  };

  const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  $('tripBar').parentElement!.hidden = true;
  if (!SHOT) {
    odoEl.querySelector('.dot')?.remove();
    drums[0].classList.replace('tenth', 'units');
    $('odoGoal').textContent = 'дн.';
  }
  const dateLabel = $('calendarDate');
  let hudLayoutTick = 0;
  const frame = (dt: number, elapsed = dt) => {
    time += dt;
    if (state === 'drive' && hudLayoutTick++ % 30 === 0) layoutHud();
    if (state === 'pause' || state === 'over' || state === 'yearReport' || state === 'renewal' || state === 'policeCheck' || state === 'caught') {
      if (renderedBackdrop !== state) {
        renderer.render(drive.scene, drive.camera, time);
        renderedBackdrop = state;
      }
      return;
    }
    renderedBackdrop = undefined;
    if (state === 'garage' || state === 'loading') {
      if (startingDrive && state === 'loading') return;
      if (garage) {
        garage.update(dt);
        renderer.render(garage.scene, garage.camera, time);
      } else if (drive) renderer.render(drive.scene, drive.camera, time);
      return;
    }
    if (state === 'station' || state === 'protocol' || state === 'breakdown') {
      // мир живёт: трафик едет мимо, машина стоит
      drive.update(dt, { throttle: 0, brake: 0, laneShift: 0 }, time);
      updateHud();
    }
    if (state === 'drive') {
      if (drive.phase !== 'intro' && !drive.waitingToMerge) activeRunSeconds += elapsed * DAYS_PER_SECOND;
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
        speedBar.style.width = `${Math.round(Math.min(1, kmh / cfg.maxSpeedKmh) * 100)}%`;
      }
      setOdo(Math.floor(activeRunSeconds));
      const date = months[drive.month];
      if (dateLabel.textContent !== date) dateLabel.textContent = date;
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

  enterGarage();
  // Долгие просадки FPS — понижаем качество на шаг; выбор игрока при этом не перезаписываем.
  let fpsWindow = 0, fpsFrames = 0, slowSeconds = 0, qualityNoticeShown = false;
  const adaptQuality = (elapsed: number) => {
    if (SHOT || !elapsed || (state !== 'drive' && state !== 'pause')) return;
    fpsWindow += elapsed;
    fpsFrames++;
    if (fpsWindow < 1) return;
    const fps = fpsFrames / fpsWindow;
    fpsWindow = 0;
    fpsFrames = 0;
    slowSeconds = fps < 42 ? slowSeconds + 1 : 0;
    if (slowSeconds < 3 || renderer.quality.name === 'low') return;
    const next: QualityName = renderer.quality.name === 'high' ? 'medium' : 'low';
    renderer.setQuality(next, false);
    drive?.setShadowMapSize(renderer.quality.shadowMap);
    markQuality();
    slowSeconds = 0;
    if (!qualityNoticeShown) {
      qualityNoticeShown = true;
      notify('Графика снижена, чтобы заезд шёл плавно');
    }
  };
  renderer.gl.setAnimationLoop((t) => {
    clock.update(t);
    const elapsed = Math.max(0, clock.getDelta());
    frame(Math.min(elapsed, 0.1), elapsed);
    adaptQuality(elapsed);
  });

  // Выгрузка страницы: гасим цикл и освобождаем GPU-ресурсы (bfcache не трогаем).
  const teardown = () => {
    renderer.gl.setAnimationLoop(null);
    drive?.dispose();
    garage?.dispose();
    drive = undefined as unknown as DriveScene;
    renderer.dispose();
  };
  addEventListener('pagehide', (event) => {
    if ((event as PageTransitionEvent).persisted) return;
    teardown();
  });
  await nextFrame();
  await nextFrame();
  if (!startingDrive && $('garage').classList.contains('show')) {
    try {
      const scene = await prepareDrive();
      if (!startingDrive && $('garage').classList.contains('show')) scene.previewRoad(car, cfg, previewLeft());
    } catch (error) {
      console.error(error);
    }
  }
}

main().catch((e) => {
  console.error(e);
  loadBar(1, 'Ошибка: ' + (e?.message || e));
});
