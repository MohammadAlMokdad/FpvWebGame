import * as THREE from 'three';

const MAX = 80;
const SHOW_FOR = 3;      // seconds a bar stays after the soldier was last hurt
const FADE = 0.6;        // fade-out time at the end
const ABOVE_HEAD = 0.55; // metres above the head centre

// Health bars over wounded soldiers. They are camera-facing quads drawn in the 3D scene (so
// they bend with the FPV lens like everything else) and keep a readable on-screen size.
// A bar only appears after the soldier's health changes, then fades out.
export class HealthBars {
  constructor(scene) {
    const geometry = new THREE.PlaneGeometry(1, 0.13);
    this.health = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aHealth', this.health);
    geometry.setAttribute('aAlpha', this.alpha);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aHealth;
        attribute float aAlpha;
        varying vec2 vUv;
        varying float vHealth;
        varying float vAlpha;
        void main() {
          vUv = uv;
          vHealth = aHealth;
          vAlpha = aAlpha;
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          // Grow with distance so the bar stays ~60 px wide, but never tiny up close.
          float scale = max(0.6, -center.z * 0.14);
          gl_Position = projectionMatrix * vec4(center.xy + position.xy * scale, center.z, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vHealth;
        varying float vAlpha;
        void main() {
          // Dark frame, then the fill coloured from red (low) to green (full).
          vec2 border = step(vec2(0.03, 0.18), vUv) * step(vUv, vec2(0.97, 0.82));
          float inside = border.x * border.y;
          vec3 fill = mix(vec3(0.95, 0.15, 0.1), vec3(0.3, 0.95, 0.35), smoothstep(0.2, 0.75, vHealth));
          vec3 col = vUv.x < vHealth ? fill : vec3(0.12);
          col = mix(vec3(0.02), col, inside);
          gl_FragColor = vec4(col * 1.6, vAlpha * 0.9);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
    this.m = new THREE.Matrix4();
    this.p = new THREE.Vector3();
  }

  update(soldiers, now) {
    let n = 0;
    for (const s of soldiers) {
      if (!s.alive || n >= MAX) continue;
      const age = now - s.hurtAt;
      if (!(age >= 0 && age < SHOW_FOR)) continue;
      this.p.copy(s.head);
      this.p.y += ABOVE_HEAD * s.def.scale;
      this.m.makeTranslation(this.p.x, this.p.y, this.p.z);
      this.mesh.setMatrixAt(n, this.m);
      this.health.setX(n, Math.max(0, s.hp / s.maxHp));
      this.alpha.setX(n, Math.min(1, (SHOW_FOR - age) / FADE));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.health.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  clear() {
    this.mesh.count = 0;
  }
}
