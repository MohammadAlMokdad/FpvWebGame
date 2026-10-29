import * as THREE from 'three';

const MAX = 160;
const SPEED = 340;      // default streak speed, m/s
const LENGTH = 10;      // default streak length in metres
const START_OFFSET = 1.5; // metres ahead of the muzzle, so streaks never fill the lens
const UP = new THREE.Vector3(0, 1, 0);

export const PLAYER_TRACER = new THREE.Color(2.4, 0.62, 0.08);
export const ENEMY_TRACER = new THREE.Color(0.35, 1.9, 0.2);

// Glowing streaks that fly from muzzle to impact point.
export class Tracers {
  constructor(scene, camera) {
    this.camera = camera;
    const geo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 4;
    this.mesh.setColorAt(0, PLAYER_TRACER);
    scene.add(this.mesh);
    this.items = [];
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.s = new THREE.Vector3();
    this.mid = new THREE.Vector3();
  }

  spawn(from, to, color, { speed = SPEED, length = LENGTH, width = 1 } = {}) {
    if (this.items.length >= MAX) this.items.shift();
    const dir = to.clone().sub(from);
    let dist = dir.length();
    if (dist < START_OFFSET + 0.5) return;
    dir.divideScalar(dist);
    const start = from.clone().addScaledVector(dir, START_OFFSET);
    dist -= START_OFFSET;
    this.items.push({ from: start, dir, dist, travelled: 0, color, speed, length, width });
  }

  update(dt) {
    let n = 0;
    this.items = this.items.filter((t) => {
      t.travelled += t.speed * dt;
      return t.travelled - t.length < t.dist;
    });
    for (const t of this.items) {
      const head = Math.min(t.travelled, t.dist);
      const tail = Math.max(0, t.travelled - t.length);
      const len = head - tail;
      if (len <= 0.01) continue;
      this.mid.copy(t.from).addScaledVector(t.dir, (head + tail) / 2);
      // Keep a minimum on-screen thickness at range.
      const width = Math.max(0.04, this.mid.distanceTo(this.camera.position) * 0.005) * t.width;
      this.q.setFromUnitVectors(UP, t.dir);
      this.s.set(width, len, width);
      this.m.compose(this.mid, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, t.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.items.length = 0;
    this.mesh.count = 0;
  }
}
