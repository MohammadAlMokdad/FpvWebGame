import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ENEMY_TYPES } from '../config.js';
import { extractMeshes } from '../core/assets.js';
import { HOT_LAYER } from '../fx/postfx.js';

const SKIN = 0x8d6a4f;
const VISOR = 0x14181b;
const AK_LENGTH = 0.88; // metres, muzzle to butt

// AKM model (muzzle along −X in the source file) converted to metres with the muzzle on +Z,
// +Y up and the origin at the pistol grip. Material colours are baked into vertex colours.
function rifleGeometry(gltf) {
  const parts = extractMeshes(gltf.scene).map(({ geometry, material }) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    colorize(g, material.color);
    return g;
  });
  const rifle = mergeGeometries(parts);
  rifle.rotateY(Math.PI / 2);
  rifle.computeBoundingBox();
  let box = rifle.boundingBox;
  const s = AK_LENGTH / (box.max.z - box.min.z);
  rifle.scale(s, s, s);
  rifle.computeBoundingBox();
  box = rifle.boundingBox;
  // The pistol grip sits ~40% of the length forward of the butt, a little below mid-height.
  const gripZ = box.min.z + (box.max.z - box.min.z) * 0.4;
  const gripY = box.min.y + (box.max.y - box.min.y) * 0.42;
  rifle.translate(-(box.min.x + box.max.x) / 2, -gripY, -gripZ);
  return rifle;
}

function bandGeometry() {
  const g = new THREE.CylinderGeometry(0.07, 0.07, 0.08, 10, 1, true);
  g.deleteAttribute('uv');
  return g;
}

// Converts quantised / interleaved glTF attributes to plain float (and uint16 joint) arrays
// and drops everything except what skinning needs.
function toPlainAttributes(g) {
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'skinIndex', 'skinWeight', 'color'].includes(name)) g.deleteAttribute(name);
  }
  for (const name of ['position', 'normal', 'skinWeight', 'skinIndex']) {
    const a = g.getAttribute(name);
    if (!a) continue;
    const isJoint = name === 'skinIndex';
    const plain = !a.isInterleavedBufferAttribute && !a.normalized
      && (isJoint ? a.array instanceof Uint16Array : a.array instanceof Float32Array);
    if (plain) continue;
    const out = isJoint ? new Uint16Array(a.count * a.itemSize) : new Float32Array(a.count * a.itemSize);
    const getters = ['getX', 'getY', 'getZ', 'getW'];
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a[getters[k]](i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  return g;
}

function colorize(geometry, color) {
  const c = new THREE.Color(color);
  const n = geometry.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

// Builds one merged, vertex-coloured skinned mesh per enemy type from the SWAT model, plus a
// shared AK-47 mesh that each soldier carries on its chest bone.
export class SoldierFactory {
  constructor(gltf, rifleGltf) {
    this.clips = Object.fromEntries(gltf.animations.map((c) => [c.name, c]));
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    const skinned = [];
    scene.traverse((o) => {
      if (o.isSkinnedMesh) skinned.push(o);
    });
    const main = skinned[0];
    const bones = main.skeleton.bones;

    // Body parts: each part is quantised with its own transform folded into its inverse bind
    // matrices, so map vertices into the main part's space (inv(IBM_main) * IBM_part), then
    // remap joint indices onto the main skeleton.
    const bodyParts = skinned.map((mesh) => {
      const g = toPlainAttributes(mesh.geometry.clone());
      const bone = mesh.skeleton.bones[0];
      const toMain = main.skeleton.boneInverses[bones.indexOf(bone)].clone().invert()
        .multiply(mesh.skeleton.boneInverses[0]);
      g.applyMatrix4(toMain);
      const remap = mesh.skeleton.bones.map((b) => bones.indexOf(b));
      const si = g.getAttribute('skinIndex');
      for (let i = 0; i < si.count; i++) {
        si.setXYZW(i, remap[si.getX(i)], remap[si.getY(i)], remap[si.getZ(i)], remap[si.getW(i)]);
      }
      return { geometry: g, material: mesh.material.name };
    });

    // Armband: a rigid ring skinned to the left upper arm.
    const bandIdx = bones.findIndex((b) => b.name === 'UpperArmL');
    const band = bandGeometry();
    band.applyMatrix4(main.skeleton.boneInverses[bandIdx].clone().invert().multiply(this.measureArmbandMount(gltf)));
    const n = band.getAttribute('position').count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = bandIdx;
      sw[i * 4] = 1;
    }
    band.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    band.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));

    const normalise = (g) => {
      toPlainAttributes(g);
      if (!g.index) g.setIndex([...Array(g.getAttribute('position').count).keys()]);
      return g;
    };

    this.geometries = {};
    for (const [key, def] of Object.entries(ENEMY_TYPES)) {
      const list = bodyParts.map(({ geometry, material }) => {
        const g = normalise(geometry.clone());
        const color = { Swat: def.uniform, Swat_Black: def.gear, Skin: SKIN, Visor: VISOR }[material] ?? def.gear;
        colorize(g, color);
        return g;
      });
      if (def.armband) {
        const b = normalise(band.clone());
        colorize(b, def.armband);
        list.push(b);
      }
      this.geometries[key] = mergeGeometries(list);
    }
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });

    this.rifleGeometry = rifleGeometry(rifleGltf);
    this.rifleGeometry.computeBoundingBox();
    this.muzzleLocal = new THREE.Vector3(0, 0.04, this.rifleGeometry.boundingBox.max.z);
    this.rifleMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
    this.riflePoses = this.measureRiflePoses(gltf);

    // Template: original hierarchy with all skinned meshes replaced by one merged mesh.
    // Vertices live in quantised bind space, so bounding volumes are meaningless: no culling.
    const mergedMesh = new THREE.SkinnedMesh(this.geometries.rifleman, this.material);
    mergedMesh.name = 'soldierMesh';
    mergedMesh.castShadow = true;
    mergedMesh.frustumCulled = false;
    mergedMesh.layers.enable(HOT_LAYER); // warm bodies: glow in night vision, red in thermal
    mergedMesh.bind(main.skeleton, main.bindMatrix);
    main.parent.add(mergedMesh);
    skinned.forEach((m) => m.parent.remove(m));
    this.template = scene;
  }

  // Chest-relative rifle transforms for the low-ready carry and the shouldered aim.
  measureRiflePoses(gltf) {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const get = (name) => scene.getObjectByName(name);
    const chest = get('Chest');
    const up = new THREE.Vector3(0, 1, 0);
    const forward = this.characterForward(gltf);
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const hips = get('Hips').getWorldPosition(new THREE.Vector3());
    if (get('WristR').getWorldPosition(new THREE.Vector3()).sub(hips).dot(right) < 0) right.negate();
    const left = right.clone().negate();
    const chestPos = chest.getWorldPosition(new THREE.Vector3());
    const invChest = chest.matrixWorld.clone().invert();

    const pose = (offset, muzzleDir) => {
      const z = muzzleDir.clone().normalize();
      const x = new THREE.Vector3().crossVectors(up, z).normalize();
      const y = new THREE.Vector3().crossVectors(z, x);
      const world = new THREE.Matrix4().makeBasis(x, y, z).setPosition(chestPos.clone().add(offset));
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      invChest.clone().multiply(world).decompose(p, q, sc);
      return { position: p, quaternion: q, scale: sc };
    };
    const at = (f, r, u) => forward.clone().multiplyScalar(f).addScaledVector(right, r).addScaledVector(up, u);
    // Carry: grip at the right hip, muzzle forward, angled across the body and down.
    const across = forward.clone().multiplyScalar(Math.cos(0.55)).addScaledVector(left, Math.sin(0.55));
    const carryDir = across.multiplyScalar(Math.cos(0.42)).addScaledVector(up, -Math.sin(0.42));
    return {
      carry: pose(at(0.24, 0.13, -0.27), carryDir),
      aim: pose(at(0.3, 0.15, 0.04), forward),
    };
  }

  measureArmbandMount(gltf) {
    const scene = SkeletonUtils.clone(gltf.scene);
    scene.updateMatrixWorld(true);
    const upper = scene.getObjectByName('UpperArmL');
    const lower = scene.getObjectByName('LowerArmL');
    const a = upper.getWorldPosition(new THREE.Vector3());
    const b = lower.getWorldPosition(new THREE.Vector3());
    const dir = b.clone().sub(a).normalize();
    const world = new THREE.Matrix4().compose(
      a.clone().lerp(b, 0.45),
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir),
      new THREE.Vector3(1, 1, 1),
    );
    return upper.matrixWorld.clone().invert().multiply(world);
  }

  // Direction the character faces, from heel to toe in the rest pose.
  characterForward(gltf) {
    const scene = gltf.scene;
    const foot = scene.getObjectByName('FootL').getWorldPosition(new THREE.Vector3());
    const toe = scene.getObjectByName('FootL_end').getWorldPosition(new THREE.Vector3());
    const f = toe.sub(foot);
    f.y = 0;
    return f.lengthSq() > 1e-8 ? f.normalize() : new THREE.Vector3(0, 0, 1);
  }

  create() {
    return new Soldier(this);
  }
}

// --- Two-bone arm IK -----------------------------------------------------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _reach = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _grip = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _side = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _pole = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function worldQuat(obj, out) {
  obj.matrixWorld.decompose(_pos, out, _scl);
  return out;
}

// Rotates `bone` so the point `childNow` (world) swings onto `target` (world).
function aimBone(bone, childNow, target) {
  const origin = _pos.setFromMatrixPosition(bone.matrixWorld);
  _from.subVectors(childNow, origin).normalize();
  _to.subVectors(target, origin).normalize();
  _dq.setFromUnitVectors(_from, _to);
  worldQuat(bone, _q1).premultiply(_dq);
  worldQuat(bone.parent, _q2).invert();
  bone.quaternion.copy(_q2.multiply(_q1));
  bone.updateMatrixWorld(true);
}

function solveArm(arm, target, pole) {
  _a.setFromMatrixPosition(arm.upper.matrixWorld);
  _b.setFromMatrixPosition(arm.lower.matrixWorld);
  _c.setFromMatrixPosition(arm.hand.matrixWorld);
  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);
  _t.subVectors(target, _a);
  const d = Math.min(Math.max(_t.length(), Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
  _t.normalize();
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _bend.subVectors(pole, _a);
  _bend.addScaledVector(_t, -_bend.dot(_t)).normalize();
  _elbow.copy(_a).addScaledVector(_t, l1 * cosA).addScaledVector(_bend, l1 * sinA);
  _reach.copy(_a).addScaledVector(_t, d);
  aimBone(arm.upper, _b, _elbow);
  aimBone(arm.lower, _c.setFromMatrixPosition(arm.hand.matrixWorld), _reach);
}

export class Soldier {
  constructor(factory) {
    this.factory = factory;
    this.root = SkeletonUtils.clone(factory.template);
    this.mesh = this.root.getObjectByName('soldierMesh');
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = {};
    this.current = null;
    const get = (n) => this.root.getObjectByName(n);
    this.bones = {
      head: get('Head'), headEnd: get('Head_end'), neck: get('Neck'), hips: get('Hips'),
      footL: get('FootL'), footR: get('FootR'), chest: get('Chest'),
    };
    this.armR = { upper: get('UpperArmR'), lower: get('LowerArmR'), hand: get('WristR') };
    this.armL = { upper: get('UpperArmL'), lower: get('LowerArmL'), hand: get('WristL') };

    this.rifle = new THREE.Mesh(factory.rifleGeometry, factory.rifleMaterial);
    this.rifle.castShadow = true;
    this.bones.chest.add(this.rifle);
    this.aimBlend = 0;
    this.aimTarget = null;
    this.ik = true;
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.flying = false;

    this.head = new THREE.Vector3();
    this.torso = new THREE.Vector3();
    this.legs = new THREE.Vector3();
    this.muzzle = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this.setRiflePose(0);
  }

  setType(key) {
    this.type = key;
    this.def = ENEMY_TYPES[key];
    this.mesh.geometry = this.factory.geometries[key];
    this.root.scale.setScalar(this.def.scale);
  }

  action(name) {
    if (!this.actions[name]) this.actions[name] = this.mixer.clipAction(this.factory.clips[name]);
    return this.actions[name];
  }

  play(name, { fade = 0.25, once = false, timeScale = 1 } = {}) {
    const next = this.action(name);
    next.timeScale = timeScale;
    if (this.current === next) return;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.enabled = true;
    next.setEffectiveWeight(1);
    if (this.current && fade > 0) next.crossFadeFrom(this.current, fade, false);
    else if (this.current) this.current.stop();
    next.play();
    this.current = next;
  }

  resetAnimation() {
    this.mixer.stopAllAction();
    this.current = null;
    this.aimBlend = 0;
    this.aimTarget = null;
    this.ik = true;
    this.flying = false;
    this.root.rotation.set(0, this.root.rotation.y, 0);
    this.setRiflePose(0);
  }

  // Blend the rifle between the low carry (0) and the shouldered aim at aimTarget (1).
  setRiflePose(blend) {
    const { carry, aim } = this.factory.riflePoses;
    const r = this.rifle;
    r.position.copy(carry.position).lerp(aim.position, blend);
    r.scale.copy(carry.scale);
    r.quaternion.copy(carry.quaternion);
    if (blend <= 0) return;
    let aimQuat = aim.quaternion;
    if (this.aimTarget) {
      // Point the muzzle at the target: a world look rotation expressed in chest space.
      _c.setFromMatrixPosition(this.bones.chest.matrixWorld);
      _to.subVectors(this.aimTarget, _c).normalize();
      _from.crossVectors(WORLD_UP, _to).normalize();
      _bend.crossVectors(_to, _from);
      _m.makeBasis(_from, _bend, _to);
      _q1.setFromRotationMatrix(_m);
      aimQuat = worldQuat(this.bones.chest, _q2).invert().multiply(_q1);
    }
    r.quaternion.slerp(aimQuat, blend);
  }

  // Pose the rifle, then put the right hand on the grip and the left on the handguard.
  updatePose() {
    this.root.updateMatrixWorld(true);
    this.setRiflePose(this.aimBlend);
    this.rifle.updateMatrixWorld(true);
    if (!this.ik) return;
    const e = this.rifle.matrixWorld.elements;
    _grip.setFromMatrixPosition(this.rifle.matrixWorld);
    _side.set(e[0], e[1], e[2]).normalize();
    _up.set(e[4], e[5], e[6]).normalize();
    _fwd.set(e[8], e[9], e[10]).normalize();
    const s = this.def.scale;
    // Elbows point down and out to the sides (rifle local +X is the soldier's left).
    _hand.copy(_grip).addScaledVector(_fwd, -0.06 * s).addScaledVector(_up, -0.03 * s);
    _pole.copy(_grip).addScaledVector(_side, -0.5).addScaledVector(WORLD_UP, -0.5).addScaledVector(_fwd, -0.3);
    solveArm(this.armR, _hand, _pole);
    _hand.copy(_grip).addScaledVector(_fwd, 0.3 * s).addScaledVector(_up, -0.03 * s);
    _pole.copy(_hand).addScaledVector(_side, 0.5).addScaledVector(WORLD_UP, -0.6);
    solveArm(this.armL, _hand, _pole);
  }

  // Hit spheres follow the animated bones.
  updateHitboxes() {
    const b = this.bones;
    this._a.setFromMatrixPosition(b.head.matrixWorld);
    this._b.setFromMatrixPosition(b.headEnd.matrixWorld);
    this.head.copy(this._a).lerp(this._b, 0.5);
    this._a.setFromMatrixPosition(b.hips.matrixWorld);
    this._b.setFromMatrixPosition(b.neck.matrixWorld);
    this.torso.copy(this._a).lerp(this._b, 0.5);
    this.legs.setFromMatrixPosition(b.footL.matrixWorld);
    this._b.setFromMatrixPosition(b.footR.matrixWorld);
    this.legs.add(this._b).multiplyScalar(0.5).lerp(this._a, 0.5);
    this.muzzle.copy(this.factory.muzzleLocal).applyMatrix4(this.rifle.matrixWorld);
  }
}
