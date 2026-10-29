import * as THREE from 'three';
import { WORLD } from '../config.js';
import { createNoise2D, mulberry32, smoothstep, lerp, clamp } from '../core/noise.js';

// Metres covered by one repeat of each ground texture: grass, dirt, mud, road.
const TILE = new THREE.Vector4(1 / 14, 1 / 10, 1 / 12, 1 / 6);

export function createTerrain(paths, textures) {
  const { size, segments } = WORLD;
  const noise = createNoise2D(WORLD.seed);
  const rand = mulberry32(WORLD.seed + 3);
  const n = segments + 1;
  const cell = size / segments;
  const half = size / 2;

  const craters = [];
  while (craters.length < 22) {
    const a = rand() * Math.PI * 2;
    const r = 48 + rand() * 140;
    craters.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, R: 2.5 + rand() * 3.5, depth: 0.9 + rand() * 0.9 });
  }

  const lowAt = (x, z) => noise.fbm(x * 0.0045 + 11.3, z * 0.0045 - 4.1, 3) * 16;
  const low0 = lowAt(0, 0);
  const detail0 = noise.fbm(0, 0, 3) * 3 + noise.fbm(0, 0, 2) * 0.5;

  function craterAt(x, z) {
    let dh = 0;
    let mask = 0;
    for (const c of craters) {
      const dx = x - c.x;
      const dz = z - c.z;
      const d2 = dx * dx + dz * dz;
      const outer = c.R * 1.5;
      if (d2 > outer * outer) continue;
      const d = Math.sqrt(d2) / c.R;
      if (d < 1) dh -= c.depth * (1 - d * d);
      else dh += c.depth * 0.35 * (1 - (d - 1) / 0.5);
      mask = Math.max(mask, 1 - smoothstep(0.9, 1.5, d));
    }
    return { dh, mask };
  }

  // Height and splat source data for one point.
  function sample(x, z) {
    const r = Math.hypot(x, z);
    const low = lowAt(x, z) - low0;
    const detail = noise.fbm(x * 0.02, z * 0.02, 3) * 3 + noise.fbm(x * 0.09 + 50, z * 0.09, 2) * 0.5 - detail0;
    let h = low + detail;
    h += smoothstep(205, 290, r) * 36 * (0.65 + 0.35 * noise(x * 0.012, z * 0.012));

    const pad = 1 - smoothstep(30, 50, r);
    h = lerp(h, 0, pad);
    const roadDist = paths.distanceToRoads(x, z);
    const road = 1 - smoothstep(2.6, 6.5, roadDist);
    const roadH = lerp(low, 0, pad) - 0.12;
    h = lerp(h, roadH, road * 0.9);
    const crater = craterAt(x, z);
    h += crater.dh;
    return { h, r, road, roadDist, crater: crater.mask };
  }

  const heights = new Float32Array(n * n);
  const positions = new Float32Array(n * n * 3);
  const splatSrc = [];
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -half + ix * cell;
      const z = -half + iz * cell;
      const s = sample(x, z);
      const i = iz * n + ix;
      heights[i] = s.h;
      positions.set([x, s.h, z], i * 3);
      splatSrc.push(s);
    }
  }

  const indices = new Uint32Array(segments * segments * 6);
  let k = 0;
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * n + ix;
      const b = (iz + 1) * n + ix;
      const c = (iz + 1) * n + ix + 1;
      const d = iz * n + ix + 1;
      indices.set([a, b, d, b, c, d], k);
      k += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // Per-vertex blend weights: grass, dirt, mud, road (gravel).
  const normals = geometry.getAttribute('normal');
  const splat = new Float32Array(n * n * 4);
  const inBase = (x, z) => 1 - smoothstep(WORLD.baseHalf + 1, WORLD.baseHalf + 5, Math.max(Math.abs(x), Math.abs(z)));
  for (let i = 0; i < n * n; i++) {
    const s = splatSrc[i];
    const x = positions[i * 3];
    const z = positions[i * 3 + 2];
    const slope = 1 - normals.getY(i);
    const base = inBase(x, z);
    const road = Math.max(s.road, base);
    const patch = noise.fbm(x * 0.035 + 100, z * 0.035, 3);
    const mudRing = smoothstep(18, 28, s.r) * (1 - smoothstep(34, 55, s.r));
    const roadEdge = smoothstep(3, 5, s.roadDist) * (1 - smoothstep(6, 11, s.roadDist));
    const mud = clamp(s.crater + mudRing * 0.5 + roadEdge * 0.25 + smoothstep(0.4, 0.65, patch) * 0.45, 0, 1) * (1 - road);
    const dirt = clamp(slope * 4 + smoothstep(0.05, 0.35, -patch) * 0.7, 0, 1) * (1 - road) * (1 - mud);
    const grass = Math.max(0, 1 - road - mud - dirt);
    const sum = grass + dirt + mud + road || 1;
    splat.set([grass / sum, dirt / sum, mud / sum, road / sum], i * 4);
  }
  geometry.setAttribute('splat', new THREE.BufferAttribute(splat, 4));

  const layers = ['aerial_grass_rock', 'dirt_aerial_03', 'aerial_mud_1', 'gravel_road'];
  const material = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0, envMapIntensity: 0.7 });
  material.onBeforeCompile = (shader) => {
    layers.forEach((name, i) => {
      shader.uniforms[`tCol${i}`] = { value: textures[name].diff };
      shader.uniforms[`tNor${i}`] = { value: textures[name].nor };
    });
    shader.uniforms.uTile = { value: TILE };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 splat;
        varying vec4 vSplat;
        varying vec3 vWPos;
        varying vec3 vWNormal;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        vSplat = splat;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tCol0, tCol1, tCol2, tCol3, tNor0, tNor1, tNor2, tNor3;
        uniform vec4 uTile;
        varying vec4 vSplat;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        float th(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float tnoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(th(i), th(i + vec2(1, 0)), f.x), mix(th(i + vec2(0, 1)), th(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <map_fragment>', `
        vec2 wuv = vec2(vWPos.x, -vWPos.z);
        float n1 = tnoise(wuv * 0.21) * 0.6 + tnoise(wuv * 0.9) * 0.4;
        vec4 w = vSplat;
        w.xyz = max(w.xyz + (vec3(n1, 1.0 - n1, n1) - 0.5) * 0.45 * step(0.02, w.xyz), 0.0);
        w /= max(dot(w, vec4(1.0)), 1e-3);
        vec2 uv0 = wuv * uTile.x, uv1 = wuv * uTile.y, uv2 = wuv * uTile.z, uv3 = wuv * uTile.w;
        // Second, rotated grass sample breaks up visible tiling.
        vec2 uv0b = mat2(0.8, -0.6, 0.6, 0.8) * wuv * uTile.x * 0.37;
        vec3 grassCol = mix(texture2D(tCol0, uv0).rgb, texture2D(tCol0, uv0b).rgb, tnoise(wuv * 0.05));
        vec3 terrainCol = grassCol * w.x + texture2D(tCol1, uv1).rgb * w.y
          + texture2D(tCol2, uv2).rgb * w.z + texture2D(tCol3, uv3).rgb * w.w;
        terrainCol *= mix(0.78, 1.12, tnoise(wuv * 0.018));
        diffuseColor.rgb *= terrainCol;`)
      .replace('#include <normal_fragment_maps>', `
        vec3 tn = (texture2D(tNor0, uv0).xyz * 2.0 - 1.0) * w.x + (texture2D(tNor1, uv1).xyz * 2.0 - 1.0) * w.y
          + (texture2D(tNor2, uv2).xyz * 2.0 - 1.0) * w.z + (texture2D(tNor3, uv3).xyz * 2.0 - 1.0) * w.w;
        tn.xy *= 0.9;
        tn = normalize(tn);
        vec3 nW = normalize(vWNormal);
        vec3 tW = normalize(vec3(1.0, 0.0, 0.0) - nW * nW.x);
        vec3 bW = cross(nW, tW);
        normal = normalize((viewMatrix * vec4(normalize(tW * tn.x + bW * tn.y + nW * tn.z), 0.0)).xyz);`);
  };
  material.customProgramCacheKey = () => 'terrain-splat';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  // Exact height of the rendered triangle under (x, z).
  function getHeight(x, z) {
    const gx = clamp((x + half) / cell, 0, segments - 1e-4);
    const gz = clamp((z + half) / cell, 0, segments - 1e-4);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const ha = heights[iz * n + ix];
    const hb = heights[(iz + 1) * n + ix];
    const hc = heights[(iz + 1) * n + ix + 1];
    const hd = heights[iz * n + ix + 1];
    if (fx + fz <= 1) return ha + (hd - ha) * fx + (hb - ha) * fz;
    return hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fz);
  }

  const p = new THREE.Vector3();
  // Distance along the ray to the ground, or Infinity.
  function raycast(origin, dir, maxDist) {
    let prev = 0;
    let t = 0;
    while (t < maxDist) {
      p.copy(origin).addScaledVector(dir, t);
      const gap = p.y - getHeight(p.x, p.z);
      if (gap < 0) {
        let lo = prev;
        let hi = t;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) * 0.5;
          p.copy(origin).addScaledVector(dir, mid);
          if (p.y < getHeight(p.x, p.z)) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prev = t;
      t += clamp(gap * 0.5, 0.35, 3);
    }
    return Infinity;
  }

  // Grass blend weight (0..1) at (x, z), from the nearest terrain vertex.
  function grassAt(x, z) {
    const ix = Math.round(clamp((x + half) / cell, 0, segments));
    const iz = Math.round(clamp((z + half) / cell, 0, segments));
    return splat[(iz * n + ix) * 4];
  }

  return { mesh, getHeight, raycast, grassAt, craters };
}
