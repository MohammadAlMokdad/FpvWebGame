import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Layer for objects that glow in night vision / show hot in thermal (soldiers).
export const HOT_LAYER = 1;
const VISION_IDS = { day: 0, thermal: 1, green: 2, white: 3 };

// Analog FPV video feed: tone mapping, fisheye lens, chromatic fringing, grain, scanlines,
// tearing glitches and full static on signal loss. At night it becomes a night-vision camera:
// colour thermal, green phosphor or white phosphor, with soldiers taken from a heat mask.
const FPVShader = {
  uniforms: {
    tDiffuse: { value: null },
    tHeat: { value: null },
    uHeatTexel: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uDistort: { value: 0.16 },
    uNoise: { value: 0 },
    uGlitch: { value: 0 },
    uLoss: { value: 0 },
    uFlash: { value: 0 },
    uVision: { value: 0 },
    uGain: { value: 1 },
    toneMappingExposure: { value: 1.05 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    // colorspace_pars_fragment (sRGBTransferOETF) is prepended by three; tone mapping is not,
    // because the material sets toneMapped: false.
    #include <tonemapping_pars_fragment>
    uniform sampler2D tDiffuse, tHeat;
    uniform vec2 uHeatTexel;
    uniform float uTime, uDistort, uNoise, uGlitch, uLoss, uFlash, uGain;
    uniform int uVision;
    uniform vec2 uRes;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 display(vec3 hdr) { return sRGBTransferOETF(vec4(ACESFilmicToneMapping(hdr), 1.0)).rgb; }
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    // Thermal false colour: black-blue (cold) → blue → cyan → green → yellow → orange → red →
    // white-hot. Soldiers sit around 0.88 (red).
    vec3 thermal(float t) {
      vec3 c = mix(vec3(0.0, 0.0, 0.06), vec3(0.05, 0.1, 0.55), smoothstep(0.0, 0.2, t));
      c = mix(c, vec3(0.0, 0.55, 0.9), smoothstep(0.2, 0.36, t));
      c = mix(c, vec3(0.1, 0.8, 0.35), smoothstep(0.36, 0.5, t));
      c = mix(c, vec3(0.95, 0.9, 0.1), smoothstep(0.5, 0.65, t));
      c = mix(c, vec3(1.0, 0.5, 0.05), smoothstep(0.65, 0.78, t));
      c = mix(c, vec3(0.95, 0.08, 0.05), smoothstep(0.78, 0.88, t));
      return mix(c, vec3(1.0, 0.95, 0.9), smoothstep(0.93, 1.0, t));
    }

    // Heat mask around uv: the soldier silhouette and a soft surrounding glow.
    void heatAt(vec2 uv, out float core, out float halo) {
      core = texture2D(tHeat, uv).r;
      halo = 0.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 0.5236;
        vec2 o = vec2(cos(a), sin(a));
        halo += texture2D(tHeat, uv + o * uHeatTexel * 2.5).r;
        halo += texture2D(tHeat, uv + o * uHeatTexel * 5.5).r * 0.8;
        halo += texture2D(tHeat, uv + o * uHeatTexel * 10.0).r * 0.5;
      }
      halo = clamp(halo / 9.0, 0.0, 1.0);
    }

    void main() {
      float aspect = uRes.x / uRes.y;
      vec2 c = vUv - 0.5;
      c.x *= aspect;
      float r2 = dot(c, c);
      vec2 d = c * (1.0 + uDistort * r2 + uDistort * 0.4 * r2 * r2) / (1.0 + uDistort * 0.28);
      d.x /= aspect;
      vec2 uv = d + 0.5;

      // Horizontal line tearing and an occasional vertical jump.
      float line = floor(uv.y * 80.0);
      float tick = floor(uTime * 24.0);
      float tear = step(1.0 - uGlitch * 0.35, hash(vec2(line, tick))) * uGlitch;
      uv.x += (hash(vec2(line * 1.7, tick + 3.0)) - 0.5) * 0.09 * tear;
      uv.y += step(0.92, hash(vec2(tick, 7.1))) * uGlitch * (hash(vec2(tick, 1.3)) - 0.5) * 0.08;

      vec2 dir = uv - 0.5;
      float ca = 0.0018 + r2 * 0.006 + uGlitch * 0.008;
      vec3 hdr = vec3(
        texture2D(tDiffuse, uv + dir * ca).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - dir * ca).b);
      vec3 col;
      float grainAmount = 0.06;
      if (uVision == 0) {
        col = display(hdr + uFlash);
        // Washed-out, slightly cool camera grade.
        float l = luma(col);
        col = mix(vec3(l), col, 0.9) * vec3(0.97, 1.0, 1.02);
        col = (col - 0.5) * 1.06 + 0.5;
      } else {
        // Night vision: amplify the faint scene, then read it as brightness or temperature.
        float l = luma(display(hdr * uGain + uFlash * 3.0));
        float core, halo;
        heatAt(uv, core, halo);
        if (uVision == 1) {
          float t = 0.04 + pow(l, 0.85) * 0.62;
          t = min(t, 0.58);
          t = mix(t, 1.0, smoothstep(0.85, 1.0, l));                       // fire and blasts are white-hot
          t = max(t, max(core * 0.9, halo * 0.72));                         // soldiers red, warm fringe
          col = thermal(t);
          grainAmount = 0.05;
        } else {
          float v = pow(l, 0.8) * 1.1;
          v += core * 0.9 + halo * 1.1;                         // glowing soldiers
          col = uVision == 2 ? vec3(0.32, 1.0, 0.42) * v : vec3(v);
          // Intensifier sparkle.
          col += step(0.9985, hash(vUv * uRes + fract(uTime * 3.1) * 57.0)) * 0.5;
          grainAmount = 0.14;
        }
      }
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);

      float grain = hash(vUv * uRes + fract(uTime * 13.7) * 91.0) - 0.5;
      col += grain * (grainAmount + uNoise * 0.4);
      float band = smoothstep(0.55, 1.0, sin(vUv.y * 6.0 - uTime * 5.0) * 0.5 + 0.5);
      col += (hash(vec2(floor(vUv.y * 220.0), floor(uTime * 30.0))) - 0.5) * uNoise * 0.6 * band;
      col *= 0.95 + 0.05 * sin(vUv.y * uRes.y * 1.6);

      float vig = smoothstep(1.2, 0.3, length((vUv - 0.5) * vec2(aspect, 1.0)));
      col *= mix(0.42, 1.0, vig);

      float st = hash(floor(vUv * uRes * 0.5) + fract(uTime * 7.3) * 113.0);
      col = mix(col, vec3(st * 0.8 + 0.05), uLoss);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

// Draws hot objects (HOT_LAYER) white into the heat mask, hidden wherever the main pass has a
// nearer surface (walls, hills) — but smoke and particles write no depth, so heat shows through.
function createHeatMaterial(depthUniforms) {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, depthUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        #include <packing>
        uniform sampler2D tSceneDepth;
        uniform vec2 uHeatRes;
        uniform float uNear, uFar;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float sceneZ = perspectiveDepthToViewZ(texture2D(tSceneDepth, gl_FragCoord.xy / uHeatRes).x, uNear, uFar);
        float myZ = perspectiveDepthToViewZ(gl_FragCoord.z, uNear, uFar);
        if (myZ < sceneZ - 0.35) discard;
        gl_FragColor = vec4(1.0);`);
  };
  material.customProgramCacheKey = () => 'heat-mask';
  return material;
}

// The 3D scene renders into an HDR buffer at `scale` × canvas resolution; the FPV pass
// upsamples it to the screen. Lowering the scale is the main performance lever.
export function createPostFX(renderer, scene, camera) {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(FPVShader.uniforms),
    vertexShader: FPVShader.vertexShader,
    fragmentShader: FPVShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const quad = new FullScreenQuad(material);
  const u = material.uniforms;
  const canvasSize = new THREE.Vector2();
  const depthUniforms = {
    tSceneDepth: { value: null },
    uHeatRes: { value: new THREE.Vector2(1, 1) },
    uNear: { value: camera.near },
    uFar: { value: camera.far },
  };
  const heatMaterial = createHeatMaterial(depthUniforms);
  const clearColor = new THREE.Color();
  let target = null;
  let heatTarget = null;
  let samples = 0;
  let scale = 1;

  function rebuild() {
    renderer.getDrawingBufferSize(canvasSize);
    const w = Math.max(1, Math.round(canvasSize.x * scale));
    const h = Math.max(1, Math.round(canvasSize.y * scale));
    if (target && target.width === w && target.height === h && target.samples === samples) return;
    target?.dispose();
    heatTarget?.dispose();
    target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples });
    target.depthTexture = new THREE.DepthTexture(w, h);
    const hw = Math.max(1, Math.round(w / 2));
    const hh = Math.max(1, Math.round(h / 2));
    heatTarget = new THREE.WebGLRenderTarget(hw, hh, { format: THREE.RedFormat, type: THREE.UnsignedByteType });
    u.tDiffuse.value = target.texture;
    u.tHeat.value = heatTarget.texture;
    u.uHeatTexel.value.set(1 / hw, 1 / hh);
    u.uRes.value.copy(canvasSize);
    depthUniforms.tSceneDepth.value = target.depthTexture;
    depthUniforms.uHeatRes.value.set(hw, hh);
  }

  // Heat mask: only HOT_LAYER objects, white, depth-tested against the main pass.
  function renderHeat() {
    const background = scene.background;
    const mask = camera.layers.mask;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(clearColor);
    const clearAlpha = renderer.getClearAlpha();
    scene.background = null;
    scene.overrideMaterial = heatMaterial;
    camera.layers.set(HOT_LAYER);
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(heatTarget);
    renderer.render(scene, camera);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.shadowMap.autoUpdate = shadowAuto;
    camera.layers.mask = mask;
    scene.overrideMaterial = null;
    scene.background = background;
  }

  return {
    uniforms: u,
    get scale() { return scale; },
    get size() { return target ? `${target.width}x${target.height}` : ''; },
    configure({ msaa = samples, renderScale = scale }) {
      samples = msaa;
      scale = renderScale;
      rebuild();
    },
    setSize() {
      rebuild();
    },
    // mode: 'day' | 'thermal' | 'green' | 'white'; gain amplifies the scene at night.
    setVision(mode, gain = 1) {
      u.uVision.value = VISION_IDS[mode] ?? 0;
      u.uGain.value = gain;
    },
    render(time) {
      u.uTime.value = time;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      if (u.uVision.value !== 0) renderHeat();
      renderer.setRenderTarget(null);
      quad.render(renderer);
    },
  };
}
