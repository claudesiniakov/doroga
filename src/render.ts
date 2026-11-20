import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type QualityName = 'low' | 'medium' | 'high';

export interface Quality {
  name: QualityName;
  pixelRatio: number;
  shadowMap: number;
  bloom: boolean;
  msaa: number;
  textureSize: number;
}

export const QUALITY: Record<QualityName, Quality> = {
  low: { name: 'low', pixelRatio: 1, shadowMap: 1024, bloom: false, msaa: 0, textureSize: 512 },
  medium: { name: 'medium', pixelRatio: 1.5, shadowMap: 2048, bloom: true, msaa: 4, textureSize: 1024 },
  high: { name: 'high', pixelRatio: 2, shadowMap: 4096, bloom: true, msaa: 4, textureSize: 1024 },
};

export function detectQuality(): QualityName {
  const q = new URLSearchParams(location.search).get('q');
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  try {
    const saved = localStorage.getItem('doroga.quality');
    if (saved === 'low' || saved === 'medium' || saved === 'high') return saved;
  } catch { /* хранилище недоступно */ }
  const mobile = matchMedia('(pointer: coarse)').matches;
  return mobile ? 'medium' : 'high';
}

/** Финальная цветокоррекция в линейном HDR: виньетка, лёгкий «тёплый» сплит-тон, зерно. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.32 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uAspect;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
      float v = 1.0 - uVignette * smoothstep(0.35, 1.05, length(d));
      c.rgb *= v;
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // тени — чуть холоднее, света — теплее
      c.rgb = mix(c.rgb * vec3(0.96, 0.99, 1.05), c.rgb * vec3(1.04, 1.0, 0.95), smoothstep(0.05, 0.8, l));
      c.rgb += (hash(vUv * 1000.0 + uTime) - 0.5) * 0.012 * (0.3 + l);
      gl_FragColor = c;
    }`,
};

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  quality: Quality;
  exposure = 0.95;
  setExposure(e: number) { this.exposure = e; this.gl.toneMappingExposure = e; }

  constructor(canvas: HTMLCanvasElement, q: QualityName) {
    this.quality = QUALITY[q];
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 0.95;
    this.exposure = 0.95;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.quality.msaa });
    this.composer = new EffectComposer(this.gl, rt);
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.composer.addPass(this.renderPass);
    // страховка: NaN/Inf в HDR-кадре не должны попадать в свечение (оно размывает их в чёрные прямоугольники)
    this.composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          bvec4 bad = bvec4(isnan(c.r) || isinf(c.r), isnan(c.g) || isinf(c.g), isnan(c.b) || isinf(c.b), isnan(c.a) || isinf(c.a));
          if (any(bad)) c = vec4(0.0, 0.0, 0.0, 1.0);
          gl_FragColor = vec4(min(c.rgb, vec3(64.0)), c.a);
        }`,
    }));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 1.6);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.applyQuality();
    this.resize();
  }

  get anisotropy() { return Math.min(16, this.gl.capabilities.getMaxAnisotropy()); }

  setQuality(q: QualityName) {
    this.quality = QUALITY[q];
    try { localStorage.setItem('doroga.quality', q); } catch { /* нет хранилища */ }
    this.applyQuality();
    this.resize();
  }

  private applyQuality() {
    this.gl.setPixelRatio(Math.min(devicePixelRatio || 1, this.quality.pixelRatio));
    this.bloom.enabled = this.quality.bloom;
    this.composer.renderTarget1.samples = this.quality.msaa;
    this.composer.renderTarget2.samples = this.quality.msaa;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.gl.setSize(w, h, false);
    this.composer.setPixelRatio(this.gl.getPixelRatio());
    this.composer.setSize(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }

  setBloom(strength: number, threshold: number, radius = 0.55) {
    this.bloom.strength = strength;
    this.bloom.threshold = threshold;
    this.bloom.radius = radius;
  }

  setVignette(v: number) { this.grade.uniforms.uVignette.value = v; }

  render(scene: THREE.Scene, camera: THREE.Camera, time: number) {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.grade.uniforms.uTime.value = time % 100;
    this.composer.render();
  }
}
