import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { projectY } from './surface-ray';

export function buildRoofRail(
  roof: THREE.Mesh,
  x: number,
  profile: ReadonlyArray<readonly [z: number, rise: number]>,
  railMaterial: THREE.Material,
  mountMaterial: THREE.Material,
) {
  const rail = new THREE.Group();
  const samples = profile.map(([z, rise]) => {
    const surface = projectY(roof, x, z, true);
    if (surface === undefined) throw new Error('Рейлинг: не найдена поверхность крыши');
    return { z, surface, rise };
  });

  const curve = new THREE.CatmullRomCurve3(
    samples.map(({ z, surface, rise }) => new THREE.Vector3(x, surface + rise, z)),
  );
  const bar = new THREE.Mesh(new THREE.TubeGeometry(curve, samples.length * 6, 0.016, 8, false), railMaterial);
  bar.castShadow = true;
  rail.add(bar);

  for (const { z, surface, rise } of [samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]]) {
    const height = rise + 0.012;
    const mount = new THREE.Mesh(new RoundedBoxGeometry(0.066, height, 0.108, 2, 0.012), mountMaterial);
    mount.position.set(x, surface + height / 2 - 0.01, z);
    rail.add(mount);
  }
  return rail;
}
