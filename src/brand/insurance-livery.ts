import * as THREE from 'three';
import absolutLogo from './absolut-logo.svg?raw';

/**
 * Логотип страховщика (векторный, с сайта): знак «a.» — на двери, название в две строки — на корме.
 * В исходнике viewBox 0 0 279 61: знак занимает x 0…80, название — x 92…279.
 */
let textures: { mark: THREE.CanvasTexture; word: THREE.CanvasTexture } | undefined;

export function brandTextures() {
  if (textures) return textures;
  const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const markC = mk(1024, 1024), wordC = mk(2048, 460);
  const mark = new THREE.CanvasTexture(markC), word = new THREE.CanvasTexture(wordC);
  for (const t of [mark, word]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; }
  const img = new Image();
  img.onload = () => {
    const k = img.naturalWidth / 279;             // пикселей на единицу viewBox
    // дверь: знак «a.» в белом круге с тёмно-синим ободком (цвет логотипа)
    const g = markC.getContext('2d')!;
    g.beginPath(); g.arc(512, 512, 496, 0, Math.PI * 2); g.fillStyle = '#1D4382'; g.fill();
    g.beginPath(); g.arc(512, 512, 470, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
    const mw = 80 * k, mh = 61 * k, s = 600 / Math.max(mw, mh);
    g.drawImage(img, 0, 0, mw, mh, 512 - (mw * s) / 2, 512 - (mh * s) / 2, mw * s, mh * s);
    mark.needsUpdate = true;
    // корма: логотип целиком — знак «a.» + «Абсолют / Страхование», в его цветах
    const w = wordC.getContext('2d')!;
    const sw = 279 * k, sh = 61 * k, s2 = Math.min(1980 / sw, 440 / sh);
    w.drawImage(img, 0, 0, sw, sh, 1024 - (sw * s2) / 2, 230 - (sh * s2) / 2, sw * s2, sh * s2);
    word.needsUpdate = true;
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(absolutLogo);
  return textures = { mark, word };
}

/** Полосы ливреи в координатах кузова (+X — левый борт, +Y — вверх, +Z — вперёд). */
const LIVERY_GLSL = /* glsl */`
vec3 liveryColor(vec3 p, vec3 n, vec3 base) {
  const vec3 navy = vec3(0.012, 0.035, 0.16);
  const vec3 sky  = vec3(0.05, 0.36, 0.78);
  const vec3 red  = vec3(0.72, 0.02, 0.03);
  float aa = 0.006;
  vec3 c = base;
  // продольные полосы сверху: капот, крыша, крышка двигателя
  float wTop = smoothstep(0.35, 0.65, n.y);
  float ax = abs(p.x);
  vec3 t = base;
  t = mix(t, red,  1.0 - smoothstep(0.205, 0.205 + aa, ax));
  t = mix(t, base, 1.0 - smoothstep(0.185, 0.185 + aa, ax));
  t = mix(t, sky,  1.0 - smoothstep(0.175, 0.175 + aa, ax));
  t = mix(t, base, 1.0 - smoothstep(0.115, 0.115 + aa, ax));
  t = mix(t, navy, 1.0 - smoothstep(0.095, 0.095 + aa, ax));
  c = mix(c, t, wTop);
  // боковая «волна»: поднимается к корме
  float wSide = smoothstep(0.35, 0.65, abs(n.x)) * (1.0 - wTop);
  float y0 = 0.5 + 0.13 * (1.0 - smoothstep(-1.6, 1.9, p.z));
  float y = p.y - y0;
  vec3 s = base;
  s = mix(s, navy, smoothstep(0.0, aa, y) * (1.0 - smoothstep(0.075, 0.075 + aa, y)));
  s = mix(s, sky,  smoothstep(0.092, 0.092 + aa, y) * (1.0 - smoothstep(0.14, 0.14 + aa, y)));
  s = mix(s, red,  smoothstep(0.156, 0.156 + aa, y) * (1.0 - smoothstep(0.178, 0.178 + aa, y)));
  // полосы не заходят на нос и корму
  s = mix(base, s, (1.0 - smoothstep(1.95, 2.15, p.z)) * smoothstep(-2.25, -2.05, p.z));
  c = mix(c, s, wSide);
  return c;
}`;

export function applyInsuranceStripes(paint: THREE.MeshPhysicalMaterial) {
  const livery = { value: 0 };
  paint.onBeforeCompile = (s) => {
    s.uniforms.uLivery = livery;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjP;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;\nvObjN = normal;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vObjP;\nvarying vec3 vObjN;\nuniform float uLivery;\n${LIVERY_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (uLivery > 0.5) diffuseColor.rgb = liveryColor(vObjP, normalize(vObjN), diffuseColor.rgb);');
  };
  paint.customProgramCacheKey = () => 'insurance-stripes';

  return (on: boolean) => { livery.value = on ? 1 : 0; };
}
