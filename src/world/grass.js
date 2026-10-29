import * as THREE from 'three';
import { WORLD } from '../config.js';
import { mulberry32 } from '../core/noise.js';

const CELL = 32;          // metres per grass chunk
const VIEW_DIST = 75;     // chunks beyond this are hidden
const MAX_ALTITUDE = 55;  // above this the tufts are sub-pixel: skip them entirely
const DENSITY = 0.55;     // tufts per square metre at full quality

function bladeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const rand = mulberry32(99);
  for (let i = 0; i < 46; i++) {
    const x = 12 + rand() * 232;
    const h = 120 + rand() * 130;
    const lean = (rand() - 0.5) * 60;
    const w = 3 + rand() * 4;
    const tone = rand();
    const r = Math.round(105 + tone * 75);
    const gr = Math.round(120 + tone * 55);
    const b = Math.round(50 + tone * 25);
    const grad = g.createLinearGradient(0, 256, 0, 256 - h);
    grad.addColorStop(0, `rgb(${r * 0.7 | 0},${gr * 0.72 | 0},${b * 0.7 | 0})`);
    grad.addColorStop(1, `rgb(${r},${gr},${b})`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x - w, 256);
    g.quadraticCurveTo(x + lean * 0.3, 256 - h * 0.6, x + lean, 256 - h);
    g.quadraticCurveTo(x + lean * 0.3 + w * 0.3, 256 - h * 0.6, x + w, 256);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// One tuft: three crossed quads, each built facing both ways (front-side rendering) so no
// face gets a flipped normal. Normals point up so tufts light like the ground they sit on.
function tuftGeometry() {
  const parts = [];
  for (let k = 0; k < 3; k++) {
    for (const back of [false, true]) {
      const q = new THREE.PlaneGeometry(0.8, 0.55);
      q.translate(0, 0.275, 0);
      if (back) q.rotateY(Math.PI);
      q.rotateY((k * Math.PI) / 3);
      parts.push(q);
    }
  }
  const g = new THREE.BufferGeometry();
  const merged = parts.map((p) => p.toNonIndexed());
  const count = merged.reduce((n, p) => n + p.getAttribute('position').count, 0);
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o = 0;
  for (const p of merged) {
    pos.set(p.getAttribute('position').array, o * 3);
    uv.set(p.getAttribute('uv').array, o * 2);
    o += p.getAttribute('position').count;
  }
  const normal = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normal[i * 3 + 1] = 1;
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  return g;
}

// Chunked, instanced grass tufts on the grassy parts of the terrain, swaying in the wind.
export function createGrass(scene, terrain, density = 1) {
  const rand = mulberry32(WORLD.seed + 77);
  const time = { value: 0 };
  const material = new THREE.MeshStandardMaterial({
    map: bladeTexture(), alphaTest: 0.4, roughness: 1, color: 0xd8d6b4,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 seed = instanceMatrix[3].xz;
          float sway = sin(uTime * 1.6 + seed.x * 0.35 + seed.y * 0.21) * 0.6 + sin(uTime * 3.1 + seed.x) * 0.25;
          transformed.xz += vec2(0.09, 0.05) * sway * uv.y;
        #endif`);
  };
  material.customProgramCacheKey = () => 'grass';
  const geometry = tuftGeometry();

  const chunks = [];
  const half = WORLD.playRadius;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let cz = -half; cz < half; cz += CELL) {
    for (let cx = -half; cx < half; cx += CELL) {
      const spots = [];
      const tries = Math.round(CELL * CELL * DENSITY * density);
      for (let i = 0; i < tries; i++) {
        const x = cx + rand() * CELL;
        const z = cz + rand() * CELL;
        const r = Math.hypot(x, z);
        if (r < 30 || r > WORLD.playRadius) continue;
        const w = terrain.grassAt(x, z);
        if (w < 0.35 || rand() > w) continue;
        spots.push([x, z]);
      }
      if (!spots.length) continue;
      const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
      mesh.receiveShadow = true;
      spots.forEach(([x, z], i) => {
        const s = 0.7 + rand() * 0.7;
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        m.compose(new THREE.Vector3(x, terrain.getHeight(x, z) - 0.03, z), q, new THREE.Vector3(s, s * (0.8 + rand() * 0.5), s));
        mesh.setMatrixAt(i, m);
      });
      mesh.computeBoundingSphere();
      mesh.visible = false;
      scene.add(mesh);
      chunks.push({ mesh, total: spots.length, center: new THREE.Vector3(cx + CELL / 2, terrain.getHeight(cx + CELL / 2, cz + CELL / 2), cz + CELL / 2) });
    }
  }

  return {
    // Instances were placed in random order, so drawing the first N is an even thinning.
    setDensity(f) {
      for (const c of chunks) c.mesh.count = Math.round(c.total * f);
    },
    update(cameraPos, t) {
      time.value = t;
      const hide = cameraPos.y > MAX_ALTITUDE;
      for (const c of chunks) c.mesh.visible = !hide && c.center.distanceTo(cameraPos) < VIEW_DIST + CELL * 0.7;
    },
  };
}
