import * as THREE from 'three';

const MAX = 1200;

// Soft round point sprites sized in world metres; one alpha-blended and one additive pool.
class ParticlePool {
  constructor(scene, additive) {
    this.count = 0;
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.size0 = new Float32Array(MAX);
    this.size1 = new Float32Array(MAX);
    this.color = new Float32Array(MAX * 3);
    this.alpha0 = new Float32Array(MAX);
    this.gravity = new Float32Array(MAX);
    this.drag = new Float32Array(MAX);

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aColor', this.aColor);
    g.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 500 } }]),
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute vec4 aColor;
        uniform float uScale;
        varying vec4 vColor;
        #include <fog_pars_vertex>
        void main() {
          vColor = aColor;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(aSize * uScale / -mvPosition.z, 600.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        #include <fog_pars_fragment>
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.1, d) * vColor.a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor.rgb, a);
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, size0, size1, r, g, b, alpha, gravity = 0, drag = 0) {
    if (this.count >= MAX) return;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.color.set([r, g, b], i * 3);
    this.alpha0[i] = alpha;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
  }

  update(dt, wind) {
    let w = 0;
    const pa = this.aPos.array;
    const sa = this.aSize.array;
    const ca = this.aColor.array;
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i3] = this.vel[i3] * k + wind.x * dt;
      this.vel[i3 + 1] = this.vel[i3 + 1] * k - this.gravity[i] * dt;
      this.vel[i3 + 2] = this.vel[i3 + 2] * k + wind.z * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      // Compact live particles to the front of every array.
      if (w !== i) {
        const w3 = w * 3;
        for (let c = 0; c < 3; c++) {
          this.pos[w3 + c] = this.pos[i3 + c];
          this.vel[w3 + c] = this.vel[i3 + c];
          this.color[w3 + c] = this.color[i3 + c];
        }
        this.life[w] = this.life[i];
        this.maxLife[w] = this.maxLife[i];
        this.size0[w] = this.size0[i];
        this.size1[w] = this.size1[i];
        this.alpha0[w] = this.alpha0[i];
        this.gravity[w] = this.gravity[i];
        this.drag[w] = this.drag[i];
      }
      const w3 = w * 3;
      pa[w3] = this.pos[w3];
      pa[w3 + 1] = this.pos[w3 + 1];
      pa[w3 + 2] = this.pos[w3 + 2];
      sa[w] = this.size0[w] + (this.size1[w] - this.size0[w]) * Math.sqrt(t);
      ca[w * 4] = this.color[w3];
      ca[w * 4 + 1] = this.color[w3 + 1];
      ca[w * 4 + 2] = this.color[w3 + 2];
      ca[w * 4 + 3] = this.alpha0[w] * (1 - t) * Math.min(1, t * 12 + 0.3);
      w++;
    }
    this.count = w;
    this.points.geometry.setDrawRange(0, w);
    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aColor.needsUpdate = true;
  }

  clear() {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
  }
}

const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;

export class Particles {
  constructor(scene) {
    this.soft = new ParticlePool(scene, false);
    this.glow = new ParticlePool(scene, true);
    this.wind = new THREE.Vector3(0.6, 0, 0.25);
  }

  setViewport(height, fovDeg) {
    const scale = height / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    this.soft.material.uniforms.uScale.value = scale;
    this.glow.material.uniforms.uScale.value = scale;
  }

  dust(p, strength = 1) {
    for (let i = 0; i < 5; i++) {
      this.soft.emit(p.x, p.y + 0.1, p.z, rnd(1.5), 1 + Math.random() * 2.2, rnd(1.5),
        0.7 + Math.random() * 0.6, 0.35 * strength, (1.6 + Math.random()) * strength, 0.2, 0.17, 0.13, 0.6, 0.6, 1.5);
    }
    for (let i = 0; i < 4; i++) {
      this.soft.emit(p.x, p.y + 0.05, p.z, rnd(2.5), 3 + Math.random() * 4, rnd(2.5),
        0.6, 0.09, 0.06, 0.12, 0.1, 0.08, 0.9, 14, 0.2);
    }
  }

  sparks(p) {
    for (let i = 0; i < 4; i++) {
      this.glow.emit(p.x, p.y, p.z, rnd(5), Math.random() * 5, rnd(5), 0.18, 0.12, 0.05, 6, 3.5, 1.2, 1, 9, 0);
    }
    this.soft.emit(p.x, p.y, p.z, rnd(0.5), 0.8, rnd(0.5), 0.8, 0.3, 1.3, 0.3, 0.29, 0.27, 0.45, 0, 1.5);
  }

  blood(p) {
    for (let i = 0; i < 6; i++) {
      this.soft.emit(p.x, p.y, p.z, rnd(1.2), rnd(1) + 0.4, rnd(1.2), 0.45 + Math.random() * 0.2, 0.2, 0.75, 0.28, 0.02, 0.02, 0.8, 2, 2);
    }
  }

  flash(p, size = 0.8) {
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.06, size, size * 1.3, 5, 3.2, 1.2, 1);
  }

  explosion(p) {
    for (let i = 0; i < 4; i++) {
      this.glow.emit(p.x + rnd(1), p.y + 1 + rnd(0.5), p.z + rnd(1), rnd(2), 2 + Math.random() * 3, rnd(2), 0.35, 3, 7, 8, 3.5, 0.9, 1);
    }
    for (let i = 0; i < 16; i++) {
      this.soft.emit(p.x + rnd(1.5), p.y + 0.5, p.z + rnd(1.5), rnd(3), 2 + Math.random() * 3, rnd(3),
        2.5 + Math.random() * 1.5, 1.5, 6 + Math.random() * 3, 0.16, 0.15, 0.14, 0.75, -0.3, 0.8);
    }
    this.dust(p, 2);
  }

  // High-explosive impact: flash, fireball, smoke, a dust skirt and thrown dirt clods (or
  // blood mist on a body). Gun rounds (big = false) keep the smoke light so the target stays
  // visible; missiles (big = true) make a large, lingering blast.
  blast(p, kind = 'dirt', big = false) {
    const k = big ? 2.4 : 1;
    this.glow.emit(p.x, p.y + 0.5 * k, p.z, 0, 0, 0, 0.1 * (big ? 1.6 : 1), 3.5 * k, 6 * k, 10, 7, 3, 1);
    for (let i = 0; i < (big ? 18 : 7); i++) {
      this.glow.emit(p.x + rnd(0.6 * k), p.y + 0.4 * k, p.z + rnd(0.6 * k), rnd(4 * k), (2 + Math.random() * 4) * k, rnd(4 * k),
        (0.25 + Math.random() * 0.2) * (big ? 1.5 : 1), 1.2 * k, (2.8 + Math.random() * 1.5) * k, 7, 2.6, 0.5, 0.9, -2, 2.5);
    }
    // Smoke: a light puff for gun rounds, a dark column for missiles.
    const smoke = big
      ? { n: 18, life: 3.5, size: 9, alpha: 0.85, rise: 3 }
      : { n: 5, life: 1.4, size: 2.6, alpha: 0.4, rise: 1.5 };
    for (let i = 0; i < smoke.n; i++) {
      this.soft.emit(p.x + rnd(0.8 * k), p.y + 0.5 + Math.random() * k, p.z + rnd(0.8 * k), rnd(1.4 * k), smoke.rise + Math.random() * 2, rnd(1.4 * k),
        smoke.life + Math.random() * smoke.life * 0.5, 1.2 * k, smoke.size * (0.8 + Math.random() * 0.4), 0.07, 0.065, 0.06, smoke.alpha, -0.3, 0.9);
    }
    // Brown dust skirt rolling outward along the ground.
    for (let i = 0; i < (big ? 20 : 7); i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (4 + Math.random() * 3) * k;
      this.soft.emit(p.x, p.y + 0.3, p.z, Math.cos(a) * v, 0.5 + Math.random(), Math.sin(a) * v,
        (big ? 2.5 : 1.1) + Math.random(), 1.2 * k, (big ? 7 : 3.2) + Math.random() * 2, 0.24, 0.2, 0.15, big ? 0.6 : 0.35, 0, 1.6);
    }
    // Debris clods (or blood mist) thrown up and out.
    const [r, g, b, al] = kind === 'blood' ? [0.25, 0.02, 0.02, 0.9] : [0.06, 0.045, 0.03, 1];
    for (let i = 0; i < (big ? 40 : 18); i++) {
      this.soft.emit(p.x, p.y + 0.3, p.z, rnd(6 * k), (5 + Math.random() * 9) * (big ? 1.4 : 1), rnd(6 * k),
        1.2 + Math.random() * 0.6, (0.18 + Math.random() * 0.14) * (big ? 1.5 : 1), 0.14, r, g, b, al, 18, 0.2);
    }
  }

  // Missile exhaust: a hot glow at the nozzle and a grey smoke trail left in the air.
  trail(p) {
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.7, 0.4, 8, 4, 1.2, 1);
    this.soft.emit(p.x + rnd(0.05), p.y + rnd(0.05), p.z + rnd(0.05), rnd(0.3), 0.3 + Math.random() * 0.3, rnd(0.3),
      1.4 + Math.random() * 0.7, 0.3, 1.3 + Math.random() * 0.8, 0.42, 0.41, 0.4, 0.35, -0.15, 0.6);
  }

  smoke(p, intensity) {
    this.soft.emit(p.x + rnd(0.6), p.y, p.z + rnd(0.6), rnd(0.4), 2 + Math.random() * 1.5, rnd(0.4),
      4 + Math.random() * 2, 1.2, 6 + Math.random() * 4, 0.1, 0.1, 0.1, 0.35 + intensity * 0.35, -0.1, 0.3);
  }

  update(dt) {
    this.soft.update(dt, this.wind);
    this.glow.update(dt, this.wind);
  }

  clear() {
    this.soft.clear();
    this.glow.clear();
  }
}
