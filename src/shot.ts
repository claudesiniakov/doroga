import { KBM, loadKbm } from './kbm';
import * as THREE from 'three';
import type { DriveScene } from './drive';
import type { GarageScene } from './garage';
import type { Renderer } from './render';
import { TrafficAssets } from './traffic-models';

/** Детерминированные кадры для автоматических снимков (scripts/shot.mjs). */
export async function runShot(kind: string, ctx: {
  renderer: Renderer; garage: GarageScene; drive: DriveScene; frame: (dt: number) => void;
  startDrive: (skip?: boolean, s?: number) => Promise<void>; enterGarage: () => void;
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
      for (const k of ['sedan', 'truck', 'van', 'tow', 'limo', 'classic']) {
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
    log.push(`статистика: всего ${txt('gsKm')}, столкновений ${txt('gsCrashes')}, заездов ${txt('gsRuns')}, последний «${txt('gsLast')}»`);
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
    const cls = () => KBM[loadKbm()].cls + ' (ОСАГО ' + document.getElementById('osagoPrice')!.textContent + ')';
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
  } else if (kind === 'blink') {
    // левый поворотник должен быть слева по ходу: проверяем в мировых координатах
    const d = ctx.drive;
    await ctx.startDrive(true, 900);
    const tr = d.traffic;
    tr.clear();
    const out: string[] = [];
    for (const k of ['sedan', 'truck', 'van', 'tow', 'limo', 'classic'] as const) {
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
      const payouts: number[] = [];
      d.onDamage = ({ paidToVictim }) => payouts.push(paidToVictim);
      let nextShift = 0;
      while (d.crashes < 6 && d.phase !== 'stopped' && t < 3000) {
        let sh = 0;
        if (t > nextShift) { sh = Math.random() < 0.5 ? -1 : 1; nextShift = t + 0.7 + Math.random(); }
        t += 1 / 60;
        d.update(1 / 60, { throttle: 1, brake: 0, laneShift: sh }, t);
      }
      log.push(`ОСАГО=${osago}: ударов ${d.crashes}, выплаты [${payouts.join(',')}], монет ${d.coins}, здоровье ${d.health}, phase=${d.phase}, причина=${d.endReason}`);
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
    const stats = { sedan: 0, truck: 0, van: 0, tow: 0, limo: 0, classic: 0, kedr: 0, moto: 0, tiller: 0 };
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
    if (tm === 'sedan' || tm === 'truck' || tm === 'van' || tm === 'tow' || tm === 'limo' || tm === 'classic') {
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
      const requested = p.get('mk');
      const mk = requested === 'tow' || requested === 'limo' || requested === 'classic' ? requested : 'sedan';
      ctx.drive.traffic.debugPlace(mk, s0 + nearS, p.get('same') ? lane : lane + (lane < 1 ? 1 : -1) * 1, Number(p.get('mkv') || 88));
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
