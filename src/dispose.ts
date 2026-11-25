import * as THREE from 'three';

/**
 * Освобождает GPU-ресурсы поддерева сцены: геометрию, материалы и текстуры в них.
 * Материалы и геометрии общие для нескольких мешей, поэтому каждого ресурса
 * касаемся один раз — повторный dispose у three безопасен, но лишние события не нужны.
 * Геометрии с userData.sharedGeo принадлежат пулу/шаблону и не освобождаются.
 */
export function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const instanced = object as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) instanced.dispose();
    const mesh = object as THREE.Mesh;
    if (mesh.geometry instanceof THREE.BufferGeometry && !mesh.userData.sharedGeo) geometries.add(mesh.geometry);
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) materials.add(m);
  });
  for (const material of materials) {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
  root.removeFromParent();
}
