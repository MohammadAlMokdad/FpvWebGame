import * as THREE from 'three';

const MAX_SCORCH = 64;
const LIGHTS = 3;
const UP = new THREE.Vector3(0, 1, 0);

function scorchTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(8,6,5,0.95)');
  grad.addColorStop(0.45, 'rgba(18,14,10,0.75)');
  grad.addColorStop(1, 'rgba(25,20,15,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // Ragged splatter.
  for (let i = 0; i < 70; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 20 + Math.random() * 38;
    g.fillStyle = `rgba(10,8,6,${0.2 + Math.random() * 0.4})`;
    g.beginPath();
    g.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 1 + Math.random() * 4, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Visual side of a high-explosive round: fireball, smoke and dirt, a brief light flash and
// a scorch mark left on the ground.
export class Explosions {
  constructor(scene, particles, terrain) {
    this.particles = particles;
    this.terrain = terrain;
    this.lights = [];
    for (let i = 0; i < LIGHTS; i++) {
      const light = new THREE.PointLight(0xffa458, 0, 22, 2);
      light.userData.life = 0;
      scene.add(light);
      this.lights.push(light);
    }
    this.nextLight = 0;

    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this.scorch = new THREE.InstancedMesh(plane, new THREE.MeshLambertMaterial({
      map: scorchTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }), MAX_SCORCH);
    this.scorch.count = 0;
    this.scorch.frustumCulled = false;
    this.scorch.receiveShadow = true;
    this.scorch.renderOrder = 1;
    scene.add(this.scorch);
    this.nextScorch = 0;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.n = new THREE.Vector3();
  }

  spawn(point, surface, big = false) {
    this.particles.blast(point, surface === 'body' ? 'blood' : 'dirt', big);
    const light = this.lights[this.nextLight];
    this.nextLight = (this.nextLight + 1) % LIGHTS;
    light.position.copy(point).y += big ? 2.5 : 1.2;
    light.userData.peak = big ? 400 : 60;
    light.userData.life = 1;
    light.distance = big ? 45 : 22;
    light.intensity = light.userData.peak;
    if (surface !== 'wall') this.addScorch(point, big ? 3.2 : 1);
  }

  addScorch(point, scale = 1) {
    const t = this.terrain;
    const ground = t.getHeight(point.x, point.z);
    if (point.y - ground > 1.2) return;
    const e = 0.6;
    this.n.set(t.getHeight(point.x - e, point.z) - t.getHeight(point.x + e, point.z), 2 * e,
      t.getHeight(point.x, point.z - e) - t.getHeight(point.x, point.z + e)).normalize();
    this.q.setFromUnitVectors(UP, this.n).multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * Math.PI * 2));
    const size = (1.8 + Math.random() * 1.2) * scale;
    this.m.compose(new THREE.Vector3(point.x, ground + 0.04, point.z), this.q, new THREE.Vector3(size, 1, size));
    this.scorch.setMatrixAt(this.nextScorch, this.m);
    this.nextScorch = (this.nextScorch + 1) % MAX_SCORCH;
    this.scorch.count = Math.min(MAX_SCORCH, this.scorch.count + 1);
    this.scorch.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    for (const light of this.lights) {
      if (light.userData.life <= 0) continue;
      light.userData.life = Math.max(0, light.userData.life - dt * (light.userData.peak > 100 ? 3.5 : 6));
      light.intensity = light.userData.peak * light.userData.life * light.userData.life;
    }
  }

  clear() {
    this.scorch.count = 0;
    this.nextScorch = 0;
    for (const light of this.lights) {
      light.userData.life = 0;
      light.intensity = 0;
    }
  }
}
