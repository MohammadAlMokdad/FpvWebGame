import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Tree } from 'ez-tree-src';
import { WORLD } from '../config.js';
import { mulberry32 } from '../core/noise.js';
import { extractMeshes } from '../core/assets.js';
import { Colliders } from './colliders.js';
import { createNightSky } from './nightsky.js';

const UP = new THREE.Vector3(0, 1, 0);
const SHADOW_EXTENT = 65;
const TREE_LOD_DIST = 110;

// Box geometry whose UVs are in metres / tile, so textures keep a constant scale.
function boxGeo(w, h, d, tile, rand) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv');
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const ou = rand ? rand() : 0;
  const ov = rand ? rand() : 0;
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0] / tile + ou, uv.getY(i) * dims[f][1] / tile + ov);
    }
  }
  return g;
}

// Collects transformed geometries per material and merges them into one mesh each.
class StaticBuilder {
  constructor() {
    this.groups = new Map();
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
  }

  add(material, geometry, x, y, z, ry = 0, rx = 0, rz = 0) {
    this.e.set(rx, ry, rz, 'YXZ');
    this.m.compose(new THREE.Vector3(x, y, z), this.q.setFromEuler(this.e), new THREE.Vector3(1, 1, 1));
    geometry.applyMatrix4(this.m);
    if (!this.groups.has(material)) this.groups.set(material, []);
    this.groups.get(material).push(geometry);
  }

  build(parent) {
    for (const [material, list] of this.groups) {
      const mesh = new THREE.Mesh(mergeGeometries(list, false), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      list.forEach((g) => g.dispose());
    }
    this.groups.clear();
  }
}

// One InstancedMesh per sub-mesh of a glTF model, all sharing instance transforms.
class InstancedProp {
  constructor(gltf, capacity, { tint, roughness, color } = {}) {
    this.parts = extractMeshes(gltf.scene).map(({ geometry, material }) => {
      let mat = material;
      if (tint !== undefined || roughness !== undefined || color !== undefined) {
        mat = material.clone();
        if (color !== undefined) mat.color.set(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
        if (tint !== undefined) mat.color.multiplyScalar(tint);
        if (roughness !== undefined) mat.roughness = roughness;
      }
      const mesh = new THREE.InstancedMesh(geometry, mat, capacity);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      return mesh;
    });
    const box = new THREE.Box3();
    for (const p of this.parts) {
      p.geometry.computeBoundingBox();
      box.union(p.geometry.boundingBox);
    }
    this.bbox = box;
    this.count = 0;
    this.capacity = capacity;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
  }

  add(x, y, z, ry = 0, scale = 1, rx = 0, rz = 0) {
    if (this.count >= this.capacity) return;
    const s = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : scale;
    this.q.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
    this.m.compose(new THREE.Vector3(x, y, z), this.q, s);
    for (const p of this.parts) p.setMatrixAt(this.count, this.m);
    this.count++;
  }

  // World-space AABB of an instance placed like add() (for colliders).
  worldBox(x, y, z, ry, scale) {
    const b = this.bbox.clone();
    const s = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : scale;
    b.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(UP, ry), s));
    return b;
  }

  finish(parent) {
    for (const p of this.parts) {
      p.count = this.count;
      p.instanceMatrix.needsUpdate = true;
      p.computeBoundingSphere();
      parent.add(p);
    }
  }
}

function makeMaterial(tex, opts = {}) {
  return new THREE.MeshStandardMaterial({
    map: tex.diff,
    normalMap: tex.nor,
    roughness: 0.92,
    metalness: 0,
    ...opts,
  });
}

function padTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3a3b37';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#c9b14a';
  g.lineWidth = 14;
  g.beginPath();
  g.arc(128, 128, 100, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#d8d2bf';
  g.fillRect(84, 64, 22, 128);
  g.fillRect(150, 64, 22, 128);
  g.fillRect(84, 117, 88, 22);
  // Wear and grime.
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = `rgba(30,28,24,${Math.random() * 0.35})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Reads the sky HDRI: the sun direction (brightest texel) for the shadow-casting light, and
// the average colour just above the horizon so distance fog blends into the sky.
function analyzeSky(hdri) {
  const { data, width, height } = hdri.image;
  const read = data instanceof Uint16Array ? (v) => THREE.DataUtils.fromHalfFloat(v) : (v) => v;
  let best = -1;
  let bx = 0;
  let by = 0;
  for (let y = 0; y < height / 2; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const lum = read(data[i]) * 0.2126 + read(data[i + 1]) * 0.7152 + read(data[i + 2]) * 0.0722;
      if (lum > best) {
        best = lum;
        bx = x;
        by = y;
      }
    }
  }
  // Equirect texel → direction, matching three's equirectUv() with flipY.
  const phi = ((bx + 0.5) / width - 0.5) * Math.PI * 2;
  const lat = (0.5 - (by + 0.5) / height) * Math.PI;
  const sunDir = new THREE.Vector3(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)).normalize();
  if (sunDir.y < 0.25) sunDir.y = 0.25; // keep shadows a sensible length
  sunDir.normalize();

  const horizon = new THREE.Color(0, 0, 0);
  let count = 0;
  for (let y = Math.floor(height * 0.45); y < Math.floor(height * 0.485); y++) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      horizon.r += read(data[i]);
      horizon.g += read(data[i + 1]);
      horizon.b += read(data[i + 2]);
      count++;
    }
  }
  return { sunDir, horizon: horizon.multiplyScalar(1 / count) };
}

export function createEnvironment(scene, renderer, assets, terrain, paths) {
  const rand = mulberry32(WORLD.seed + 21);
  const colliders = new Colliders();
  const root = new THREE.Group();
  root.name = 'environment';
  scene.add(root);
  root.add(terrain.mesh);

  // --- Sky, fog and light -------------------------------------------------
  // A photographed sky: it is the visible background and lights the scene; the sun light is
  // aimed from the sun's position in the photo so shadows agree with the sky.
  const sky = analyzeSky(assets.hdri);
  const sunDir = sky.sunDir;
  scene.background = assets.hdri;
  scene.backgroundIntensity = 1;
  scene.environment = assets.hdri;
  scene.environmentIntensity = 0.55;
  const fogColor = sky.horizon.multiplyScalar(0.9);
  scene.fog = new THREE.FogExp2(fogColor, WORLD.fogDensity);

  const sun = new THREE.DirectionalLight(0xfff1de, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT, bottom: -SHADOW_EXTENT, near: 1, far: 320 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  // Night: a moonlit star sky, cool moonlight and two warm lamps at the outpost. Everything is
  // created up front (lamps at zero intensity by day) so switching never recompiles shaders.
  const dayFog = fogColor.clone();
  const nightFog = new THREE.Color(0.012, 0.016, 0.028);
  const moonDir = new THREE.Vector3(0.45, 0.62, -0.64).normalize();
  const nightSky = createNightSky(moonDir, nightFog);
  scene.add(nightSky);
  const lamps = [new THREE.Vector3(-4.5, 2.4, 2.2), new THREE.Vector3(15.5, 8.8, 15.5)].map((p) => {
    const lamp = new THREE.PointLight(0xffb070, 0, 30, 2);
    lamp.position.copy(p);
    scene.add(lamp);
    return lamp;
  });
  let lightDir = sunDir;
  let skyTime = 0;

  // mode: 'day' | 'night'. coldSky hides stars and moon (a thermal camera sees the sky as cold).
  function setTimeOfDay(mode, coldSky = false) {
    const night = mode === 'night';
    nightSky.material.uniforms.uStars.value = coldSky ? 0 : 1;
    scene.background = night ? null : assets.hdri;
    nightSky.visible = night;
    scene.environmentIntensity = night ? 0.06 : 0.55;
    scene.fog.color.copy(night ? nightFog : dayFog);
    scene.fog.density = night ? 0.0045 : WORLD.fogDensity;
    sun.color.set(night ? 0x9fb4ff : 0xfff1de);
    sun.intensity = night ? 0.45 : 3.2;
    lightDir = night ? moonDir : sunDir;
    for (const lamp of lamps) lamp.intensity = night ? 22 : 0;
  }

  // --- Materials ------------------------------------------------------------
  const tx = assets.textures;
  const concrete = makeMaterial(tx.concrete_layers, { color: 0xb8b4aa });
  const plaster = makeMaterial(tx.damaged_plaster, { color: 0xd2c8b6 });
  const iron = makeMaterial(tx.rusty_corrugated_iron, { roughness: 0.75, metalness: 0.3 });
  const rubbleMat = makeMaterial(tx.rubble, { color: 0xa09a90 });
  const canvas = new THREE.MeshStandardMaterial({ color: 0x4f5638, roughness: 1 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x2b2d2c, roughness: 0.6, metalness: 0.6 });
  const darkSlit = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 });

  const statics = new StaticBuilder();
  const solid = (material, w, h, d, x, y, z, tile = 3, ry = 0, collide = true) => {
    statics.add(material, boxGeo(w, h, d, tile, rand), x, y + h / 2, z, ry);
    if (collide) {
      const quarter = Math.abs(Math.sin(ry)) > 0.7;
      const sx = quarter ? d : w;
      const sz = quarter ? w : d;
      colliders.addCentered(new THREE.Vector3(x, y + h / 2, z), new THREE.Vector3(sx, h, sz));
    }
  };

  // --- Props --------------------------------------------------------------
  const m = assets.models;
  const props = {
    rock7: new InstancedProp(m.rock_07, 40),
    rock9: new InstancedProp(m.rock_09, 30),
    trunk: new InstancedProp(m.dead_tree_trunk, 24),
    crate: new InstancedProp(m.wooden_military_crate, 40),
    barrel: new InstancedProp(m.barrel_03, 40),
    barrier: new InstancedProp(m.concrete_road_barrier_02, 40),
    tyre: new InstancedProp(m.old_tyre, 30),
    sandbag: new InstancedProp(m.sack_trench, 40, { tint: 0.85, roughness: 1 }),
    sandbagSmall: new InstancedProp(m.sack_trench_small, 40, { tint: 0.85, roughness: 1 }),
    debris: new InstancedProp(m.debris_pile, 30, { color: 0x6b6258, roughness: 1 }),
    tank: new InstancedProp(m.tank_wreck, 4, { tint: 0.28, roughness: 1 }),
  };

  // Footprints already used, so nothing overlaps.
  const used = [];
  const isFree = (x, z, radius, roadClear = 5) => {
    const r = Math.hypot(x, z);
    if (r < 36 + radius || r > WORLD.playRadius - 8) return false;
    if (paths.distanceToRoads(x, z) < roadClear + radius) return false;
    return used.every((u) => Math.hypot(u.x - x, u.z - z) > u.r + radius);
  };
  const claim = (x, z, r) => used.push({ x, z, r });
  const ground = (x, z) => terrain.getHeight(x, z);
  const groundMin = (x, z, r) => Math.min(ground(x - r, z - r), ground(x + r, z - r), ground(x - r, z + r), ground(x + r, z + r), ground(x, z));

  // --- Base compound ------------------------------------------------------
  const H = WORLD.baseHalf;
  const wallH = 3.2;
  const wallT = 0.6;
  const gap = WORLD.gateWidth / 2;
  const segLen = H + wallT / 2 - gap;
  const segMid = gap + segLen / 2;
  for (const s of [-1, 1]) {
    solid(concrete, segLen, wallH, wallT, -segMid, 0, s * H);
    solid(concrete, segLen, wallH, wallT, segMid, 0, s * H);
    solid(concrete, wallT, wallH, segLen, s * H, 0, -segMid);
    solid(concrete, wallT, wallH, segLen, s * H, 0, segMid);
  }
  // Gate posts.
  for (const g of paths.gates) {
    const tx2 = g.normal.y !== 0 ? 1 : 0;
    const tz2 = g.normal.x !== 0 ? 1 : 0;
    for (const side of [-1, 1]) {
      const px = g.pos.x + tx2 * side * (gap + 0.4);
      const pz = g.pos.y + tz2 * side * (gap + 0.4);
      solid(concrete, 1.0, wallH + 0.8, 1.0, px, 0, pz);
      // Barriers flanking the road outside the gate.
      const bx = g.pos.x + g.normal.x * 3.5 + tx2 * side * (gap + 1.6);
      const bz = g.pos.y + g.normal.y * 3.5 + tz2 * side * (gap + 1.6);
      const ry = Math.atan2(g.normal.x, g.normal.y) + Math.PI / 2;
      props.barrier.add(bx, ground(bx, bz), bz, ry + side * 0.35, 1.2);
      // Sandbag positions just inside the wall, beside the opening.
      const sx = g.pos.x - g.normal.x * 2.2 + tx2 * side * (gap + 2.4);
      const sz = g.pos.y - g.normal.y * 2.2 + tz2 * side * (gap + 2.4);
      props.sandbagSmall.add(sx, 0, sz, ry - Math.PI / 2, 1);
    }
  }

  // Bunker.
  const bx = -7;
  const bz = 6;
  solid(concrete, 9, 2.8, 6.5, bx, 0, bz, 3);
  solid(concrete, 10, 0.5, 7.5, bx, 2.8, bz, 3, 0, false);
  colliders.addCentered(new THREE.Vector3(bx, 3.05, bz), new THREE.Vector3(10, 0.5, 7.5));
  for (const s of [-1, 1]) {
    statics.add(darkSlit, new THREE.BoxGeometry(4, 0.25, 0.1), bx, 2.0, bz + s * 3.27);
    statics.add(darkSlit, new THREE.BoxGeometry(0.1, 0.25, 3), bx + s * 4.52, 2.0, bz);
  }
  statics.add(darkSlit, new THREE.BoxGeometry(1.4, 2.0, 0.1), bx + 2.5, 1.0, bz - 3.28);
  props.sandbag.add(bx + 2.5, 0, bz - 5.2, 0, 1);

  // Watchtowers in two corners.
  const tower = (x, z) => {
    const legH = 7;
    for (const [lx, lz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
      statics.add(steel, new THREE.BoxGeometry(0.22, legH, 0.22), x + lx, legH / 2, z + lz);
      colliders.addCentered(new THREE.Vector3(x + lx, legH / 2, z + lz), new THREE.Vector3(0.3, legH, 0.3));
      statics.add(steel, new THREE.BoxGeometry(0.12, 2.6, 0.12), x + lx * 1.05, legH + 1.3, z + lz * 1.05);
    }
    solid(concrete, 3.6, 0.25, 3.6, x, legH, z, 2);
    solid(iron, 3.6, 1.1, 0.08, x, legH + 0.25, z - 1.76, 1.5);
    solid(iron, 3.6, 1.1, 0.08, x, legH + 0.25, z + 1.76, 1.5);
    solid(iron, 0.08, 1.1, 3.6, x - 1.76, legH + 0.25, z, 1.5);
    solid(iron, 0.08, 1.1, 2.0, x + 1.76, legH + 0.25, z - 0.8, 1.5);
    statics.add(iron, boxGeo(4.2, 0.08, 4.2, 1.5), x, legH + 2.65, z, 0, 0.08);
    colliders.addCentered(new THREE.Vector3(x, legH + 2.65, z), new THREE.Vector3(4.2, 0.3, 4.2));
    for (let i = 0; i < 3; i++) props.barrel.add(x + 2.3 + i * 0.7, 0, z - 1.6, rand() * 6, 1);
  };
  tower(15.5, 15.5);
  tower(-15.5, -15.5);

  // Antenna mast next to the bunker.
  statics.add(steel, new THREE.CylinderGeometry(0.07, 0.11, 12, 6), bx - 5.6, 6, bz - 1.5);
  for (let i = 1; i <= 3; i++) statics.add(steel, new THREE.BoxGeometry(1.4 - i * 0.3, 0.05, 0.05), bx - 5.6, 6 + i * 1.8, bz - 1.5);

  // Tents (triangular prisms).
  const tent = (x, z, ry) => {
    const g = new THREE.CylinderGeometry(1.7, 1.7, 4.4, 3, 1);
    g.rotateZ(Math.PI / 2);
    g.rotateX(-Math.PI / 2);
    g.scale(1, 0.9, 1);
    statics.add(canvas, g, x, 0.75, z, ry);
    colliders.addCentered(new THREE.Vector3(x, 1.0, z), new THREE.Vector3(Math.abs(Math.cos(ry)) > 0.5 ? 4.4 : 3, 2, Math.abs(Math.cos(ry)) > 0.5 ? 3 : 4.4));
  };
  tent(8, 11, 0);
  tent(13, 6, Math.PI / 2);

  // Launch pad (drone respawn point).
  const padPos = new THREE.Vector3(7, 0, -7);
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshStandardMaterial({ map: padTexture(), roughness: 0.95 }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(padPos.x, 0.04, padPos.z);
  pad.receiveShadow = true;
  root.add(pad);

  // Supply stacks inside the compound.
  const crateStack = (x, z, ry) => {
    const w = 1.24;
    for (let i = 0; i < 3; i++) props.crate.add(x + (i - 1) * w * Math.cos(ry), 0, z - (i - 1) * w * Math.sin(ry), ry, 1);
    props.crate.add(x, 0.46, z, ry + 0.1, 1);
    const alongX = Math.abs(Math.cos(ry)) > 0.7;
    colliders.addCentered(new THREE.Vector3(x, 0.5, z), new THREE.Vector3(alongX ? 3.8 : 0.7, 1, alongX ? 0.7 : 3.8));
  };
  crateStack(-13, -5, 0);
  crateStack(3, 15, Math.PI / 2);
  crateStack(-3, -14, 0.2);
  for (let i = 0; i < 6; i++) props.barrel.add(-15 + (i % 3) * 0.75, 0, 9 + Math.floor(i / 3) * 0.75, rand() * 6, 1);
  for (let i = 0; i < 4; i++) props.tyre.add(11 + rand() * 2, 0.08 + i * 0.16, -12 + rand() * 0.3, rand() * 6, 1.4, Math.PI / 2, 0);

  // Sandbag ring around the outside of the compound, between the gates.
  for (const g of paths.gates) {
    const tdir = new THREE.Vector2(g.normal.y, -g.normal.x);
    for (const side of [-1, 1]) {
      for (const along of [9, 14]) {
        const p = g.pos.clone().addScaledVector(g.normal, 3.2).addScaledVector(tdir, side * along);
        props.sandbag.add(p.x, ground(p.x, p.y) - 0.05, p.y, Math.atan2(g.normal.x, g.normal.y) + (rand() - 0.5) * 0.2, 1);
      }
    }
  }

  // --- Ruined houses ----------------------------------------------------------
  const house = (cx, cz) => {
    const w = 7 + rand() * 4;
    const d = 6 + rand() * 3;
    const fullH = rand() < 0.3 ? 6 : 3.4;
    const t = 0.35;
    const y0 = groundMin(cx, cz, Math.max(w, d) / 2) - 0.2;
    solid(concrete, w + 0.6, 0.4, d + 0.6, cx, y0, cz, 3, 0, false);
    const doorWall = Math.floor(rand() * 4);
    const walls = [
      { len: w, along: 'x', fixed: cz - d / 2 },
      { len: w, along: 'x', fixed: cz + d / 2 },
      { len: d, along: 'z', fixed: cx - w / 2 },
      { len: d, along: 'z', fixed: cx + w / 2 },
    ];
    walls.forEach((wall, wi) => {
      const cols = Math.max(4, Math.round(wall.len / 1.1));
      const cw = wall.len / cols;
      const ruined = rand() < 0.6;
      for (let c = 0; c < cols; c++) {
        const isDoor = wi === doorWall && (c === Math.floor(cols / 2));
        if (isDoor || (ruined && rand() < 0.18)) continue;
        let h = fullH;
        if (ruined) h *= 0.35 + rand() * 0.65;
        if (c % 3 === 1 && fullH > 4 && rand() < 0.5) h = Math.min(h, fullH * 0.45); // window gaps upstairs
        const offset = -wall.len / 2 + cw * (c + 0.5);
        if (wall.along === 'x') solid(plaster, cw, h, t, cx + offset, y0 + 0.4, wall.fixed, 3);
        else solid(plaster, t, h, cw, wall.fixed, y0 + 0.4, cz + offset, 3);
      }
    });
    // Collapsed roof slab leaning into the house.
    if (rand() < 0.7) {
      const slab = boxGeo(w * 0.6, 0.25, d * 0.9, 3, rand);
      statics.add(concrete, slab, cx - w * 0.15, y0 + fullH * 0.45, cz, 0, 0, 0.45);
    }
    // Rubble mounds.
    for (let i = 0; i < 3; i++) {
      const g = new THREE.IcosahedronGeometry(1.2 + rand() * 1.2, 1);
      g.scale(1, 0.38, 1);
      const rx = cx + (rand() - 0.5) * (w + 3);
      const rz = cz + (rand() - 0.5) * (d + 3);
      statics.add(rubbleMat, g, rx, ground(rx, rz) - 0.1, rz, rand() * 6);
    }
    props.debris.add(cx + w / 2 + 1.5, ground(cx + w / 2 + 1.5, cz), cz + (rand() - 0.5) * d, rand() * 6, 1.4);
  };
  let houses = 0;
  for (let attempt = 0; attempt < 400 && houses < 9; attempt++) {
    const a = rand() * Math.PI * 2;
    const r = 55 + rand() * 120;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!isFree(x, z, 8, 8)) continue;
    house(x, z);
    claim(x, z, 9);
    houses++;
  }

  // --- Scattered props ----------------------------------------------------
  const scatter = (count, radius, roadClear, fn) => {
    for (let placed = 0, tries = 0; placed < count && tries < count * 40; tries++) {
      const a = rand() * Math.PI * 2;
      const r = 38 + Math.sqrt(rand()) * (WORLD.playRadius - 45);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!isFree(x, z, radius, roadClear)) continue;
      fn(x, z);
      claim(x, z, radius);
      placed++;
    }
  };
  scatter(34, 2.5, 3, (x, z) => {
    const s = 11 + rand() * 12;
    const ry = rand() * Math.PI * 2;
    const y = groundMin(x, z, 1.5) - 0.3;
    props.rock7.add(x, y, z, ry, s, (rand() - 0.5) * 0.3, (rand() - 0.5) * 0.3);
    colliders.boxes.push(props.rock7.worldBox(x, y, z, ry, s * 0.8));
  });
  scatter(26, 2.5, 3, (x, z) => {
    const s = 28 + rand() * 26;
    const ry = rand() * Math.PI * 2;
    const y = groundMin(x, z, 1.5) - 0.2;
    props.rock9.add(x, y, z, ry, s);
    colliders.boxes.push(props.rock9.worldBox(x, y, z, ry, s * 0.8));
  });
  scatter(18, 3, 2, (x, z) => props.trunk.add(x, ground(x, z) - 0.05, z, rand() * 6, 1.6 + rand() * 0.8));
  scatter(10, 1.5, 1, (x, z) => props.tyre.add(x, ground(x, z) + 0.05, z, rand() * 6, 1.4, Math.PI / 2 + (rand() - 0.5) * 0.4, 0));
  scatter(10, 2, 2, (x, z) => props.debris.add(x, ground(x, z), z, rand() * 6, 1.2 + rand()));

  // Two burnt-out tank wrecks beside the roads.
  const tankLen = props.tank.bbox.getSize(new THREE.Vector3());
  const tankScale = 7 / Math.max(tankLen.x, tankLen.z);
  let tanks = 0;
  for (let tries = 0; tries < 300 && tanks < 2; tries++) {
    const lane = paths.lanes[Math.floor(rand() * paths.lanes.length)];
    const i = 2 + Math.floor(rand() * 4);
    const p = lane.points[i];
    const next = lane.points[i + 1];
    const dir = next.clone().sub(p).normalize();
    const side = new THREE.Vector2(-dir.y, dir.x).multiplyScalar(rand() < 0.5 ? 9 : -9);
    const x = p.x + side.x;
    const z = p.y + side.y;
    if (used.some((u) => Math.hypot(u.x - x, u.z - z) < u.r + 5)) continue;
    const ry = Math.atan2(dir.x, dir.y) + 0.6;
    const y = groundMin(x, z, 2.5) - props.tank.bbox.min.y * tankScale;
    props.tank.add(x, y, z, ry, tankScale, 0, 0.06);
    colliders.boxes.push(props.tank.worldBox(x, y, z, ry, tankScale));
    claim(x, z, 6);
    tanks++;
  }

  // --- Trees (EZ-Tree, instanced) ------------------------------------------
  const treeVariants = buildTreeVariants(rand);
  const treeSpots = [];
  for (let cluster = 0, tries = 0; cluster < 10 && tries < 400; tries++) {
    const a = rand() * Math.PI * 2;
    const r = 60 + rand() * 125;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    if (!isFree(cx, cz, 10, 6)) continue;
    const n = 7 + Math.floor(rand() * 9);
    for (let i = 0; i < n; i++) {
      const tx3 = cx + (rand() - 0.5) * 34;
      const tz3 = cz + (rand() - 0.5) * 34;
      if (isFree(tx3, tz3, 1.2, 4)) treeSpots.push([tx3, tz3]);
    }
    claim(cx, cz, 14);
    cluster++;
  }
  scatter(26, 1.5, 4, (x, z) => treeSpots.push([x, z]));
  const perVariant = treeVariants.map(() => []);
  for (const [x, z] of treeSpots) {
    const v = rand() < 0.25 ? treeVariants.length - 1 : Math.floor(rand() * (treeVariants.length - 1));
    perVariant[v].push([x, z]);
  }
  const tm = new THREE.Matrix4();
  const CELL = 60;
  const treeCells = [];
  // Instances are grouped per map cell so off-screen groups are culled (main and shadow pass).
  const plant = (variants, perVariantSpots, { scaleMin, scaleRange, collide }) => variants.forEach((variant, vi) => {
    const cells = new Map();
    for (const spot of perVariantSpots[vi]) {
      const key = `${Math.floor(spot[0] / CELL)},${Math.floor(spot[1] / CELL)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(spot);
    }
    for (const spots of cells.values()) {
      const meshes = variant.parts.map(({ near, material }) => {
        const im = new THREE.InstancedMesh(near, material, spots.length);
        im.castShadow = true;
        im.receiveShadow = true;
        return im;
      });
      const center = new THREE.Vector3();
      spots.forEach(([x, z]) => center.add(new THREE.Vector3(x, ground(x, z), z)));
      treeCells.push({ center: center.divideScalar(spots.length), meshes, parts: variant.parts, far: false });
      spots.forEach(([x, z], i) => {
        const s = scaleMin + rand() * scaleRange;
        tm.compose(new THREE.Vector3(x, ground(x, z) - 0.2, z), new THREE.Quaternion().setFromAxisAngle(UP, rand() * Math.PI * 2), new THREE.Vector3(s, s, s));
        meshes.forEach((im) => im.setMatrixAt(i, tm));
        if (collide) colliders.addCentered(new THREE.Vector3(x, ground(x, z) + variant.height * s * 0.3, z), new THREE.Vector3(0.7, variant.height * s * 0.6, 0.7));
      });
      meshes.forEach((im) => {
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        root.add(im);
      });
    }
  });
  plant(treeVariants, perVariant, { scaleMin: 0.8, scaleRange: 0.45, collide: true });

  // Bushes: clumped around the tree clusters and scattered over the grassland.
  const bushVariants = buildTreeVariants(rand, BUSH_SPECS);
  const bushSpots = bushVariants.map(() => []);
  const addBush = (x, z) => bushSpots[Math.floor(rand() * bushVariants.length)].push([x, z]);
  for (const [x, z] of treeSpots) {
    for (let k = 0; k < 2; k++) {
      const bx2 = x + (rand() - 0.5) * 9;
      const bz2 = z + (rand() - 0.5) * 9;
      if (paths.distanceToRoads(bx2, bz2) > 5 && Math.hypot(bx2, bz2) > 34) addBush(bx2, bz2);
    }
  }
  for (let tries = 0, placed = 0; placed < 160 && tries < 3000; tries++) {
    const a = rand() * Math.PI * 2;
    const r = 34 + Math.sqrt(rand()) * (WORLD.playRadius - 40);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (paths.distanceToRoads(x, z) < 5 || terrain.grassAt(x, z) < 0.5) continue;
    if (used.some((u) => Math.hypot(u.x - x, u.z - z) < u.r)) continue;
    addBush(x, z);
    placed++;
  }
  plant(bushVariants, bushSpots, { scaleMin: 0.7, scaleRange: 0.7, collide: false });

  Object.values(props).forEach((p) => p.finish(root));
  statics.build(root);

  const focus = new THREE.Vector3();
  function update(target, cameraPos) {
    nightSky.position.copy(cameraPos);
    skyTime += 1 / 60;
    nightSky.material.uniforms.uTime.value = skyTime;
    for (const cell of treeCells) {
      const far = cell.center.distanceTo(cameraPos) > TREE_LOD_DIST;
      if (far === cell.far) continue;
      cell.far = far;
      cell.meshes.forEach((im, i) => { im.geometry = far ? cell.parts[i].far : cell.parts[i].near; });
    }
    // Shadow frustum follows what the camera looks at; snapping reduces shimmer.
    const texel = (SHADOW_EXTENT * 2) / sun.shadow.mapSize.x;
    focus.set(Math.round(target.x / texel) * texel, 0, Math.round(target.z / texel) * texel);
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(lightDir, 160);
  }
  update(new THREE.Vector3(), new THREE.Vector3());

  function setShadowQuality(size, treeShadows) {
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    for (const cell of treeCells) for (const im of cell.meshes) im.castShadow = treeShadows;
  }

  return {
    colliders,
    setShadowQuality,
    setTimeOfDay,
    respawnPoint: padPos.clone().add(new THREE.Vector3(0, 6, 0)),
    sun,
    fogColor,
    treeCount: treeSpots.length,
    update,
  };
}

// A few tree shapes generated once and drawn many times, each with a near and a far
// level of detail. The last variant is leafless.
const TREE_SPECS = [
  { preset: 'Oak Medium', height: 11 },
  { preset: 'Ash Medium', height: 12 },
  { preset: 'Pine Medium', height: 13 },
  { preset: 'Oak Large', height: 10, dead: true },
];
const BUSH_SPECS = [
  { preset: 'Bush 1', height: 1.8 },
  { preset: 'Bush 2', height: 2.2 },
];

function buildTreeVariants(rand, specs = TREE_SPECS) {
  const generate = (spec, seed, detail) => {
    const tree = new Tree();
    tree.loadPreset(spec.preset);
    tree.options.seed = seed;
    // Far trees lose their finest branch level; single-level trees (pines) thin their leaves instead.
    let leafFactor = detail.leaves;
    if (detail.dropLevel) {
      if (tree.options.branch.levels > 1) tree.options.branch.levels -= 1;
      else leafFactor = 0.3;
    }
    const sec = tree.options.branch.sections;
    const seg = tree.options.branch.segments;
    for (const k of Object.keys(sec)) sec[k] = Math.max(2, Math.round(sec[k] * detail.sections));
    for (const k of Object.keys(seg)) seg[k] = Math.max(3, Math.round(seg[k] * detail.segments));
    if (spec.dead) tree.options.leaves.count = 0;
    else {
      tree.options.leaves.count = Math.max(3, Math.round(tree.options.leaves.count * leafFactor));
      tree.options.leaves.size *= detail.leafSize;
    }
    tree.generate();
    return tree;
  };
  return specs.map((spec) => {
    const seed = Math.floor(rand() * 100000);
    const near = generate(spec, seed, { sections: 0.45, segments: 0.55, leaves: 0.5, leafSize: 1.3 });
    const far = generate(spec, seed, { sections: 0.3, segments: 0.4, leaves: 0.9, leafSize: 1.9, dropLevel: true });

    const branchGeo = near.branchesMesh.geometry;
    branchGeo.computeBoundingBox();
    const s = spec.height / (branchGeo.boundingBox.max.y - branchGeo.boundingBox.min.y);
    const barkSrc = near.branchesMesh.material;
    const bark = new THREE.MeshStandardMaterial({
      map: barkSrc.map, normalMap: barkSrc.normalMap, color: spec.dead ? 0x6d655c : barkSrc.color, roughness: 0.95,
    });
    const parts = [{ material: bark, near: branchGeo.scale(s, s, s), far: far.branchesMesh.geometry.scale(s, s, s) }];
    if (!spec.dead) {
      const leafSrc = near.leavesMesh.material;
      const leaves = new THREE.MeshStandardMaterial({
        map: leafSrc.map, color: new THREE.Color(leafSrc.color).multiplyScalar(0.8), alphaTest: 0.5,
        side: THREE.DoubleSide, roughness: 0.9,
      });
      parts.push({ material: leaves, near: near.leavesMesh.geometry.scale(s, s, s), far: far.leavesMesh.geometry.scale(s, s, s) });
    }
    const tris = (key) => Math.round(parts.reduce((sum, p) => sum + p[key].index.count / 3, 0));
    console.info(`[trees] ${spec.preset}${spec.dead ? ' (dead)' : ''}: ${tris('near')} near / ${tris('far')} far triangles`);
    return { parts, height: spec.height };
  });
}
