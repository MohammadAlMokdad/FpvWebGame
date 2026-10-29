import * as THREE from 'three';

// Static axis-aligned boxes used for drone collision, bullet impacts and line of sight.
export class Colliders {
  constructor() {
    this.boxes = [];
  }

  add(min, max) {
    this.boxes.push(new THREE.Box3(min.clone(), max.clone()));
  }

  addCentered(center, size) {
    const h = size.clone().multiplyScalar(0.5);
    this.boxes.push(new THREE.Box3(center.clone().sub(h), center.clone().add(h)));
  }

  clear() {
    this.boxes.length = 0;
  }

  // Distance to the nearest box along a normalized ray, or Infinity.
  raycast(origin, dir, maxDist) {
    let best = maxDist;
    let hit = false;
    for (const box of this.boxes) {
      const t = rayBox(origin, dir, box, best);
      if (t < best) {
        best = t;
        hit = true;
      }
    }
    return hit ? best : Infinity;
  }

  // Pushes a sphere out of every box it overlaps and cancels velocity into the surface.
  resolveSphere(pos, radius, velocity) {
    for (const box of this.boxes) {
      if (pos.x < box.min.x - radius || pos.x > box.max.x + radius
        || pos.y < box.min.y - radius || pos.y > box.max.y + radius
        || pos.z < box.min.z - radius || pos.z > box.max.z + radius) continue;
      const cx = Math.max(box.min.x, Math.min(pos.x, box.max.x));
      const cy = Math.max(box.min.y, Math.min(pos.y, box.max.y));
      const cz = Math.max(box.min.z, Math.min(pos.z, box.max.z));
      let dx = pos.x - cx;
      let dy = pos.y - cy;
      let dz = pos.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= radius * radius) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        dx /= d; dy /= d; dz /= d;
        pos.x += dx * (radius - d);
        pos.y += dy * (radius - d);
        pos.z += dz * (radius - d);
      } else {
        // Centre is inside the box: leave through the nearest face.
        const pens = [
          [pos.x - box.min.x, -1, 0, 0], [box.max.x - pos.x, 1, 0, 0],
          [pos.y - box.min.y, 0, -1, 0], [box.max.y - pos.y, 0, 1, 0],
          [pos.z - box.min.z, 0, 0, -1], [box.max.z - pos.z, 0, 0, 1],
        ].sort((a, b) => a[0] - b[0])[0];
        [, dx, dy, dz] = pens;
        pos.x += dx * (pens[0] + radius);
        pos.y += dy * (pens[0] + radius);
        pos.z += dz * (pens[0] + radius);
      }
      const vn = velocity.x * dx + velocity.y * dy + velocity.z * dz;
      if (vn < 0) {
        velocity.x -= vn * dx;
        velocity.y -= vn * dy;
        velocity.z -= vn * dz;
      }
    }
  }
}

export function rayBox(o, d, box, maxT) {
  let tmin = 0;
  let tmax = maxT;
  for (const axis of ['x', 'y', 'z']) {
    const inv = 1 / d[axis];
    let t0 = (box.min[axis] - o[axis]) * inv;
    let t1 = (box.max[axis] - o[axis]) * inv;
    if (inv < 0) [t0, t1] = [t1, t0];
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmax < tmin) return Infinity;
  }
  return tmin;
}
