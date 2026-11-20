import * as THREE from 'three';
import { Renderer, detectQuality } from './render';
import { GarageScene } from './garage';
import { buildVette } from './car-vette';
import cars from './cars.json';
import type { CarConfig } from './car';

// Прототип новой «Кометы»: гараж, переключение ливреи, ракурсы.
const renderer = new Renderer(document.getElementById('gl') as HTMLCanvasElement, detectQuality());
const pmrem = new THREE.PMREMGenerator(renderer.gl);
const garage = new GarageScene(pmrem, document.body);
const base = (cars as CarConfig[])[0];
const car = buildVette({ ...base, color: '#f4f5f2', sponsor: 'absouleins.ru' });
garage.attachCar(car);
renderer.setExposure(1.0);
renderer.setBloom(0.22, 3.0, 0.4);
renderer.setVignette(0.45);

const params = new URLSearchParams(location.search);
let livery = params.get('livery') === '1';
let spin = !params.get('yaw');
let fixedYaw = params.get('yaw') ? Number(params.get('yaw')) : null;
const livBtn = document.getElementById('liv')!;
const spinBtn = document.getElementById('spin')!;
const apply = () => {
  car.setLivery?.(livery);
  livBtn.textContent = livery ? 'Страховка: есть (ливрея)' : 'Страховка: нет';
  livBtn.classList.toggle('on', livery);
  spinBtn.classList.toggle('on', spin);
};
livBtn.addEventListener('click', () => { livery = !livery; apply(); });
spinBtn.addEventListener('click', () => { spin = !spin; fixedYaw = spin ? null : garage.yaw; apply(); });
document.querySelectorAll<HTMLButtonElement>('[data-yaw]').forEach((b) => b.addEventListener('click', () => {
  spin = false; fixedYaw = Number(b.dataset.yaw); garage.yaw = fixedYaw; apply();
}));
apply();

const resize = () => { renderer.resize(); garage.resize(innerWidth / innerHeight); garage.camera.clearViewOffset(); garage.camera.updateProjectionMatrix(); };
addEventListener('resize', resize);
resize();
if (fixedYaw !== null) garage.yaw = fixedYaw;
const timer = new THREE.Timer();
let frames = 0;
renderer.gl.setAnimationLoop((t) => {
  timer.update(t);
  const dt = Math.max(0, Math.min(timer.getDelta(), 0.1));
  if (!spin && fixedYaw !== null) garage.yaw = fixedYaw;
  garage.update(dt);
  renderer.render(garage.scene, garage.camera, t / 1000);
  if (++frames === 3) (window as any).__ready = true;
});
