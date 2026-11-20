/** Клавиатура + касания. laneShift накапливается между кадрами и забирается take(). */
export class Input {
  throttle = 0;
  brake = 0;
  private shift = 0;
  private keys = new Set<string>();
  private pedals = { gas: false, brake: false };
  /** Ползунок газа на сенсорном экране: 0…1, остаётся где поставили; тормоз сбрасывает в 0. */
  private gasLevel = 0;
  onPause?: () => void;
  private resetGas = () => {};
  onCamera?: () => void;
  enabled = false;

  constructor(touchLayer: HTMLElement, gas: HTMLElement, brake: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) { if (this.isDriveKey(e.code)) e.preventDefault(); return; }
      this.keys.add(e.code);
      if (!this.enabled) return;
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.shift -= 1;
      if (e.code === 'ArrowRight' || e.code === 'KeyD') this.shift += 1;
      if (e.code === 'KeyC') this.onCamera?.();
      if (e.code === 'Escape' || e.code === 'KeyP') this.onPause?.();
      if (this.isDriveKey(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.pedals.gas = this.pedals.brake = false; });

    // касание левой/правой половины экрана — смена полосы; свайп тоже
    let sx = 0, sy = 0, st = 0, swiped = false;
    touchLayer.addEventListener('pointerdown', (e) => {
      if (!this.enabled || e.pointerType === 'mouse') return;
      sx = e.clientX; sy = e.clientY; st = performance.now(); swiped = false;
    });
    touchLayer.addEventListener('pointermove', (e) => {
      if (!this.enabled || e.pointerType === 'mouse' || swiped || !st) return;
      const dx = e.clientX - sx;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - sy)) {
        this.shift += Math.sign(dx);
        swiped = true;
      }
    });
    touchLayer.addEventListener('pointerup', (e) => {
      if (!this.enabled || e.pointerType === 'mouse' || !st) return;
      if (!swiped && performance.now() - st < 350) this.shift += e.clientX < innerWidth / 2 ? -1 : 1;
      st = 0;
    });

    const hold = (el: HTMLElement, key: 'gas' | 'brake') => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); this.pedals[key] = true; el.classList.add('on'); if (key === 'brake') this.resetGas(); });
      const off = () => { this.pedals[key] = false; el.classList.remove('on'); };
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('lostpointercapture', off);
    };
    hold(brake, 'brake');

    // газ — вертикальный ползунок: где палец, столько и газа (низ 0 %, верх 100 %); значение остаётся, тормоз сбрасывает
    const fill = gas.querySelector<HTMLElement>('.gas-fill');
    const val = gas.querySelector<HTMLElement>('.gas-val b');
    const setGas = (v: number) => {
      this.gasLevel = v;
      const pct = Math.round(v * 100);
      if (fill) fill.style.height = `${pct}%`;
      if (val) val.textContent = String(pct);
      gas.setAttribute('aria-valuenow', String(pct));
      gas.classList.toggle('on', v > 0);
    };
    const fromY = (y: number) => {
      const r = gas.getBoundingClientRect();
      const pad = 10;   // у краёв — гарантированные 0 и 100 %
      return Math.min(1, Math.max(0, (r.bottom - pad - y) / (r.height - pad * 2)));
    };
    let active = -1;
    gas.addEventListener('pointerdown', (e) => {
      e.preventDefault(); try { gas.setPointerCapture(e.pointerId); } catch { /* нет захвата */ } active = e.pointerId; setGas(fromY(e.clientY));
    });
    gas.addEventListener('pointermove', (e) => { if (e.pointerId === active) setGas(fromY(e.clientY)); });
    const release = (e: PointerEvent) => { if (e.pointerId === active) active = -1; };
    this.resetGas = () => { if (this.gasLevel > 0) setGas(0); };
    gas.addEventListener('pointerup', release);
    gas.addEventListener('pointercancel', release);
    gas.addEventListener('lostpointercapture', release);
  }

  private isDriveKey(c: string) {
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(c);
  }

  poll() {
    const k = this.keys;
    this.throttle = !this.enabled ? 0 : k.has('ArrowUp') || k.has('KeyW') ? 1 : this.gasLevel;
    this.brake = this.enabled && (k.has('ArrowDown') || k.has('KeyS') || k.has('Space') || this.pedals.brake) ? 1 : 0;
    if (this.brake) this.resetGas();
  }

  take(): number {
    const s = Math.sign(this.shift);
    this.shift = 0;
    return s;
  }

  /** Новый заезд/выход в гараж — газ в ноль. */
  clear() { this.shift = 0; this.keys.clear(); this.resetGas(); }
}
