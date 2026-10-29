import * as THREE from 'three';

// Night sky dome: dark gradient, a procedural star field and a moon with a soft halo. It follows
// the camera and is drawn behind everything; distance fog fades the terrain into its horizon.
export function createNightSky(moonDir, horizon) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uMoon: { value: moonDir.clone().normalize() },
      uHorizon: { value: horizon.clone() },
      uZenith: { value: new THREE.Color(0.004, 0.006, 0.014) },
      uTime: { value: 0 },
      uStars: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uMoon, uHorizon, uZenith;
      uniform float uTime, uStars;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float up = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uZenith, pow(up, 0.45));
        // Stars: one candidate per grid cell on the sky, gently twinkling.
        vec3 cell = floor(d * 260.0);
        float h = hash(cell);
        float star = step(0.9965, h) * smoothstep(0.02, 0.15, d.y);
        float twinkle = 0.65 + 0.35 * sin(uTime * (1.5 + h * 4.0) + h * 40.0);
        col += vec3(0.75, 0.8, 1.0) * star * twinkle * (0.25 + 0.75 * fract(h * 97.0)) * 0.6 * uStars;
        // Moon disc and halo.
        float m = dot(d, uMoon);
        col += (vec3(0.85, 0.9, 1.0) * smoothstep(0.99955, 0.9997, m) * 2.5
          + vec3(0.25, 0.3, 0.45) * pow(max(m, 0.0), 220.0) * 0.6 + vec3(0.03, 0.04, 0.07) * pow(max(m, 0.0), 12.0)) * uStars;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), material);
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  dome.visible = false;
  return dome;
}
