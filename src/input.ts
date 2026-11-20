/** Клавиатура + касания. laneShift накапливается между кадрами и забирается take(). */
export class Input {
  throttle = 0;
  brake = 0;
  private shift = 0;
  private keys = new Set<string>();
  private pedals = { gas: false, brake: false };
  onPause?: () => void;
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
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); this.pedals[key] = true; el.classList.add('on'); });
      const off = () => { this.pedals[key] = false; el.classList.remove('on'); };
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('lostpointercapture', off);
    };
    hold(gas, 'gas');
    hold(brake, 'brake');
  }

  private isDriveKey(c: string) {
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(c);
  }

  poll() {
    const k = this.keys;
    this.throttle = this.enabled && (k.has('ArrowUp') || k.has('KeyW') || this.pedals.gas) ? 1 : 0;
    this.brake = this.enabled && (k.has('ArrowDown') || k.has('KeyS') || k.has('Space') || this.pedals.brake) ? 1 : 0;
  }

  take(): number {
    const s = Math.sign(this.shift);
    this.shift = 0;
    return s;
  }

  clear() { this.shift = 0; this.keys.clear(); }
}
