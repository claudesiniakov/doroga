import type * as THREE from 'three';
import { ROAD } from './textures';

const snowNoise = /* glsl */ `
  float snowHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float snowNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(snowHash(i), snowHash(i + vec2(1.0, 0.0)), f.x),
      mix(snowHash(i + vec2(0.0, 1.0)), snowHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

const roadSnow = /* glsl */ `
  float lateral = (vMapUv.x * 2.0 - 1.0) * ${ROAD.half.toFixed(2)};
  float laneCenter = clamp(floor(lateral / ${ROAD.laneWidth.toFixed(1)} + 0.5), -1.0, 1.0)
    * ${ROAD.laneWidth.toFixed(1)};
  float wheelTrack = abs(abs(lateral - laneCenter) - 0.82);
  float cleared = 1.0 - smoothstep(0.17, 0.49, wheelTrack + (grain - 0.5) * 0.15);
  float shoulder = smoothstep(4.9, 6.05, abs(lateral));
  float cover = mix(0.77 + drift * 0.2, 0.19 + drift * 0.23, cleared * (1.0 - shoulder));
  cover = mix(cover, 0.995, shoulder);
  // Снег оставляет читаемыми светлые линии на проезжей части.
  float marking = smoothstep(0.14, 0.42, dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
  diffuseColor.rgb = mix(diffuseColor.rgb, snowColor, cover * (1.0 - marking * 0.72));
`;

export function addSnowCover(
  road: THREE.MeshStandardMaterial[],
  gravel: THREE.MeshStandardMaterial,
  ground: THREE.MeshStandardMaterial,
) {
  const enabled = { value: 0 };
  const apply = (material: THREE.MeshStandardMaterial, surface: 'road' | 'ground' | 'gravel') => {
    const baseCompile = material.onBeforeCompile;
    const baseKey = material.customProgramCacheKey();
    material.customProgramCacheKey = () => `${baseKey}-snow-${surface}`;
    material.onBeforeCompile = (shader, renderer) => {
      baseCompile.call(material, shader, renderer);
      shader.uniforms.snowEnabled = enabled;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 snowPosition;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nsnowPosition = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float snowEnabled;\nvarying vec2 snowPosition;\n${snowNoise}`)
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
          if (snowEnabled > 0.5) {
            float drift = snowNoise(snowPosition * 0.36);
            float grain = snowNoise(snowPosition * 7.0);
            vec3 snowColor = vec3(0.73, 0.81, 0.90) * (0.87 + drift * 0.15 + grain * 0.055);
            ${surface === 'road' ? roadSnow : `
              float exposed = smoothstep(0.31, 0.66, drift + (grain - 0.5) * 0.18);
              diffuseColor.rgb = mix(diffuseColor.rgb, snowColor, 0.81 + exposed * 0.18);
            `}
          }
          #include <roughnessmap_fragment>
          if (snowEnabled > 0.5) roughnessFactor = mix(roughnessFactor, 0.93, 0.75);
        `);
    };
  };
  for (const material of road) apply(material, 'road');
  apply(gravel, 'gravel');
  apply(ground, 'ground');

  const materials = [...road, gravel, ground].map((material) => ({ material, normalScale: material.normalScale.clone() }));
  return (on: boolean) => {
    enabled.value = Number(on);
    for (const { material, normalScale } of materials) {
      material.normalScale.copy(normalScale).multiplyScalar(on ? 0.44 : 1);
    }
  };
}
