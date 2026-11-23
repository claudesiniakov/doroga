import * as THREE from 'three';
import { Renderer, detectQuality } from './render';
import { GarageScene } from './garage';
import { buildPlayerCar } from './player-car';
import type { CarConfig } from './car';
import { TrafficAssets, type TrafficKind } from './traffic-models';
import cars from './cars.json';

const canvas = document.querySelector<HTMLCanvasElement>('#gl')!;
const renderer = new Renderer(canvas, detectQuality());
const pmrem = new THREE.PMREMGenerator(renderer.gl);
const garage = new GarageScene(pmrem, canvas);
pmrem.dispose();
renderer.setExposure(1.0);
renderer.setBloom(0.22, 3.0, 0.4);
renderer.setVignette(0.45);

interface Preview {
  root: THREE.Group;
  setLivery?: (on: boolean) => void;
}

const trafficNames: Record<TrafficKind, string> = {
  sedan: 'Седан',
  truck: 'Грузовик',
  moto: 'Мотоцикл',
  van: 'Минивэн',
  tiller: 'Мотоблок с повозкой',
};

let traffic: TrafficAssets | undefined;
const getTraffic = () => traffic ??= new TrafficAssets();
const select = document.querySelector<HTMLSelectElement>('#vehicle')!;
const factories = new Map<string, () => Preview>();
const previews = new Map<string, Preview>();

function addOption(group: HTMLOptGroupElement, id: string, name: string, build: () => Preview) {
  group.append(new Option(name, id));
  factories.set(id, build);
}

const playerGroup = document.querySelector<HTMLOptGroupElement>('#player')!;
for (const config of cars as CarConfig[]) {
  addOption(playerGroup, config.id, config.name, () => buildPlayerCar(config));
}
const trafficGroup = document.querySelector<HTMLOptGroupElement>('#traffic')!;
for (const kind of Object.keys(trafficNames) as TrafficKind[]) {
  addOption(trafficGroup, kind, trafficNames[kind], () => getTraffic().create(kind));
}
addOption(trafficGroup, 'police', 'Патруль ДПС', () => getTraffic().createPolice().vis);

const params = new URLSearchParams(location.search);
const initialYaw = params.get('yaw');
let spin = initialYaw === null || !Number.isFinite(Number(initialYaw));
if (!spin) garage.yaw = Number(initialYaw);
let livery = params.get('livery') === '1';
let active: Preview;
const livBtn = document.querySelector<HTMLButtonElement>('#liv')!;
const spinBtn = document.querySelector<HTMLButtonElement>('#spin')!;

function updateControls() {
  active.setLivery?.(livery);
  livBtn.hidden = !active.setLivery;
  livBtn.textContent = livery ? 'Страховка: есть' : 'Страховка: нет';
  livBtn.setAttribute('aria-pressed', String(livery));
  spinBtn.setAttribute('aria-pressed', String(spin));
}

function showVehicle(id: string) {
  let preview = previews.get(id);
  if (!preview) {
    const model = factories.get(id)!();
    const bounds = new THREE.Box3().setFromObject(model.root, true);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const stand = new THREE.Group();
    stand.add(model.root);
    model.root.position.sub(new THREE.Vector3(center.x, bounds.min.y, center.z));
    stand.scale.setScalar(Math.min(1, 5.6 / Math.hypot(size.x, size.z), 2.4 / size.y));
    preview = { root: stand, setLivery: model.setLivery?.bind(model) };
    previews.set(id, preview);
  }
  active = preview;
  garage.attachVehicle(active.root);
  updateControls();
}

const requested = params.get('car');
if (requested && factories.has(requested)) select.value = requested;
showVehicle(select.value);
select.addEventListener('change', () => showVehicle(select.value));
livBtn.addEventListener('click', () => {
  livery = !livery;
  updateControls();
});
spinBtn.addEventListener('click', () => {
  spin = !spin;
  updateControls();
});
document.querySelectorAll<HTMLButtonElement>('[data-yaw]').forEach((button) => {
  button.addEventListener('click', () => {
    spin = false;
    garage.yaw = Number(button.dataset.yaw);
    updateControls();
  });
});

const resize = () => {
  renderer.resize();
  garage.resize(innerWidth / innerHeight);
  garage.camera.clearViewOffset();
  garage.camera.updateProjectionMatrix();
};
addEventListener('resize', resize);
resize();

const timer = new THREE.Timer();
let frames = 0;
renderer.gl.setAnimationLoop((t) => {
  timer.update(t);
  const dt = Math.max(0, Math.min(timer.getDelta(), 0.1));
  garage.update(dt, spin);
  renderer.render(garage.scene, garage.camera, t / 1000);
  if (++frames === 3) (window as any).__ready = true;
});
