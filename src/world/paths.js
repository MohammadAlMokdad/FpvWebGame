import * as THREE from 'three';
import { WORLD } from '../config.js';
import { mulberry32 } from '../core/noise.js';

const H = WORLD.baseHalf;

// Four gates in the middle of each compound wall; normal points out of the base.
export const GATES = [
  { name: 'E', pos: new THREE.Vector2(H, 0), normal: new THREE.Vector2(1, 0), angle: 0 },
  { name: 'S', pos: new THREE.Vector2(0, H), normal: new THREE.Vector2(0, 1), angle: 90 },
  { name: 'W', pos: new THREE.Vector2(-H, 0), normal: new THREE.Vector2(-1, 0), angle: 180 },
  { name: 'N', pos: new THREE.Vector2(0, -H), normal: new THREE.Vector2(0, -1), angle: 270 },
];

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function distToSegmentSq(px, pz, a, b) {
  const abx = b.x - a.x;
  const abz = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (pz - a.y) * abz) / (abx * abx + abz * abz)));
  const dx = a.x + abx * t - px;
  const dz = a.y + abz * t - pz;
  return dx * dx + dz * dz;
}

// Spawn lanes: each is a winding polyline from the map edge to a gate, ending just inside the wall.
export function createPaths() {
  const rand = mulberry32(WORLD.seed + 7);
  const lanes = WORLD.spawnAngles.map((deg, id) => {
    const a = THREE.MathUtils.degToRad(deg);
    const start = new THREE.Vector2(Math.cos(a), Math.sin(a)).multiplyScalar(WORLD.spawnRadius);
    const gate = GATES.reduce((best, g) => (angleDiff(g.angle, deg) < angleDiff(best.angle, deg) ? g : best));
    const approach = gate.pos.clone().addScaledVector(gate.normal, 26);

    const dir = approach.clone().sub(start);
    const perp = new THREE.Vector2(-dir.y, dir.x).normalize();
    const phase = rand() * Math.PI * 2;
    const amp = 9 + rand() * 9;
    const points = [start];
    const steps = 7;
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const wiggle = Math.sin(t * Math.PI * 1.6 + phase) * amp * Math.sin(t * Math.PI);
      points.push(start.clone().addScaledVector(dir, t).addScaledVector(perp, wiggle));
    }
    points.push(approach);
    points.push(gate.pos.clone().addScaledVector(gate.normal, 7));
    const gateIndex = points.length;
    points.push(gate.pos.clone());
    points.push(gate.pos.clone().addScaledVector(gate.normal, -4)); // breach point inside the wall

    // The road keeps going past the spawn point toward the map edge.
    const roadStart = new THREE.Vector2(Math.cos(a), Math.sin(a)).multiplyScalar(WORLD.size * 0.5);
    const road = [roadStart, ...points.slice(0, gateIndex + 1)];
    return { id, angle: deg, gate, points, road };
  });

  const segments = [];
  for (const lane of lanes) {
    for (let i = 0; i < lane.road.length - 1; i++) segments.push([lane.road[i], lane.road[i + 1]]);
  }

  function distanceToRoads(x, z) {
    let best = Infinity;
    for (const [a, b] of segments) {
      const d = distToSegmentSq(x, z, a, b);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  return { lanes, gates: GATES, distanceToRoads };
}
