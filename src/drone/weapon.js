import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPON, MISSILE } from '../config.js';
import { events } from '../core/events.js';
import { PLAYER_TRACER } from '../fx/tracers.js';

// Gun is slung under the camera, slightly right, so tracer streaks are visible on screen;
// the missile rail sits on the left.
const MUZZLE_OFFSET = new THREE.Vector3(0.18, -0.4, -0.3);
const MISSILE_OFFSET = new THREE.Vector3(-0.3, -0.38, -0.2);
const MAX_MISSILES = 6;

function missileGeometry() {
  const body = new THREE.CylinderGeometry(0.055, 0.055, 0.85, 10);
  const nose = new THREE.ConeGeometry(0.055, 0.2, 10);
  nose.translate(0, 0.525, 0);
  const fins = [0, 1, 2, 3].map((i) => {
    const fin = new THREE.BoxGeometry(0.22, 0.14, 0.01);
    fin.translate(0, -0.36, 0);
    fin.rotateY((i * Math.PI) / 2);
    return fin;
  });
  const g = mergeGeometries([body, nose, ...fins].map((p) => p.toNonIndexed()));
  g.rotateX(Math.PI / 2); // nose along +Z
  return g;
}

// The drone's weapons: a slow-firing gun with small high-explosive rounds (left button) and
// guided-straight missiles with a large blast (right button). Ammunition is issued per wave.
export class Weapon {
  constructor({ scene, camera, drone, enemies, terrain, colliders, particles, tracers, explosions }) {
    Object.assign(this, { camera, drone, enemies, terrain, colliders, particles, tracers, explosions });
    this.cooldown = 0;
    this.missileCooldown = 0;
    this.dryCooldown = 0;
    this.dir = new THREE.Vector3();
    this.muzzle = new THREE.Vector3();
    this.flash = 0;
    this.pending = [];
    this.missiles = [];
    this.ammo = 0;
    this.rockets = 0;
    this.issued = { ammo: 1, rockets: 1 };
    const geo = missileGeometry();
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a4f3c, roughness: 0.6, metalness: 0.4 });
    this.pool = Array.from({ length: MAX_MISSILES }, () => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.castShadow = true;
      scene.add(mesh);
      return mesh;
    });
  }

  // Rounds or missiles still flying (the wave can still be won with these).
  get inFlight() {
    return this.pending.length > 0 || this.missiles.length > 0;
  }

  refill(ammo, rockets) {
    this.ammo = ammo;
    this.rockets = rockets;
    this.issued = { ammo, rockets };
    events.emit('ammo', { refill: true });
  }

  update(dt, firing, missileRequested) {
    this.cooldown -= dt;
    this.missileCooldown -= dt;
    this.dryCooldown -= dt;
    this.flash = Math.max(0, this.flash - dt);
    for (const round of this.pending) {
      round.time -= dt;
      if (round.time <= 0) this.detonate(round.point, round.surface, round.direct, WEAPON);
    }
    this.pending = this.pending.filter((r) => r.time > 0);
    this.updateMissiles(dt);
    if (this.drone.downed) return;

    if (missileRequested && this.missileCooldown <= 0) {
      if (this.rockets > 0) this.launchMissile();
      else this.dryFire();
    }
    if (!firing) {
      this.cooldown = Math.max(this.cooldown, 0);
      return;
    }
    while (this.cooldown <= 0) {
      if (this.ammo <= 0) {
        this.dryFire();
        this.cooldown = 1 / WEAPON.fireRate;
        break;
      }
      this.fire();
      this.cooldown += 1 / WEAPON.fireRate;
    }
  }

  clear() {
    this.pending.length = 0;
    for (const m of this.missiles) m.mesh.visible = false;
    this.missiles.length = 0;
  }

  dryFire() {
    if (this.dryCooldown > 0) return;
    this.dryCooldown = 0.35;
    events.emit('dryFire');
  }

  aimDirection(spreadDeg) {
    const spread = THREE.MathUtils.degToRad(spreadDeg);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    return this.dir.set(Math.cos(a) * r, Math.sin(a) * r, -1).normalize().applyQuaternion(this.camera.quaternion);
  }

  // Nearest thing hit along a ray: { t, surface, direct } (t = Infinity if nothing).
  trace(origin, dir, maxDist) {
    const enemyHit = this.enemies.raycast(origin, dir, maxDist);
    const wallT = this.colliders.raycast(origin, dir, maxDist);
    const groundT = this.terrain.raycast(origin, dir, maxDist);
    const enemyT = enemyHit ? enemyHit.t : Infinity;
    const t = Math.min(enemyT, wallT, groundT);
    if (t === Infinity || t > maxDist) return { t: Infinity };
    if (enemyHit && enemyT <= t) {
      return { t, surface: 'body', direct: { soldier: enemyHit.soldier, headshot: enemyHit.part === 'head' } };
    }
    return { t, surface: wallT <= groundT ? 'wall' : 'ground', direct: null };
  }

  fire() {
    const cam = this.camera;
    const dir = this.aimDirection(WEAPON.spreadDeg);
    const hit = this.trace(cam.position, dir, WEAPON.range);
    const t = Math.min(hit.t, WEAPON.range);
    const point = cam.position.clone().addScaledVector(dir, t);
    this.muzzle.copy(MUZZLE_OFFSET).applyQuaternion(cam.quaternion).add(cam.position);
    this.tracers.spawn(this.muzzle, point, PLAYER_TRACER, { speed: WEAPON.projectileSpeed, length: 6, width: 1.6 });
    if (hit.t !== Infinity) {
      this.pending.push({ point, time: t / WEAPON.projectileSpeed, surface: hit.surface, direct: hit.direct });
    }
    this.ammo--;
    this.drone.addRecoil(THREE.MathUtils.degToRad(0.7));
    this.drone.addShake(0.06);
    this.flash = 0.07;
    events.emit('shot', { kind: 'gun' });
    events.emit('ammo', {});
  }

  launchMissile() {
    const cam = this.camera;
    const mesh = this.pool.find((m) => !m.visible);
    if (!mesh) return;
    this.rockets--;
    this.missileCooldown = MISSILE.cooldown;
    const dir = this.aimDirection(0).clone();
    const pos = MISSILE_OFFSET.clone().applyQuaternion(cam.quaternion).add(cam.position);
    // Aim so the missile converges on the crosshair point rather than flying parallel to it.
    const aim = this.trace(cam.position, dir, 400);
    const target = cam.position.clone().addScaledVector(dir, Math.min(aim.t, 400));
    const flightDir = target.sub(pos).normalize();
    mesh.visible = true;
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), flightDir);
    this.missiles.push({ mesh, pos, start: pos.clone(), dir: flightDir, speed: MISSILE.startSpeed, life: 0, trail: 0 });
    this.drone.addShake(0.35);
    this.drone.addRecoil(THREE.MathUtils.degToRad(1.2));
    events.emit('shot', { kind: 'missile', position: pos.clone() });
    events.emit('ammo', {});
  }

  updateMissiles(dt) {
    const keep = [];
    for (const m of this.missiles) {
      m.speed = Math.min(MISSILE.maxSpeed, m.speed + MISSILE.accel * dt);
      m.life += dt;
      const step = m.speed * dt;
      const hit = this.trace(m.pos, m.dir, step);
      if (hit.t !== Infinity || m.life > MISSILE.maxLife) {
        const point = m.pos.clone().addScaledVector(m.dir, hit.t === Infinity ? 0 : hit.t);
        this.detonate(point, hit.surface ?? 'air', hit.direct ?? null, MISSILE);
        m.mesh.visible = false;
        continue;
      }
      m.pos.addScaledVector(m.dir, step);
      m.mesh.position.copy(m.pos);
      // Exhaust and smoke trail, starting a few metres out so it doesn't fog the lens.
      m.trail += dt;
      const clear = m.pos.distanceTo(m.start) > 6;
      while (m.trail > 0.012) {
        m.trail -= 0.012;
        if (clear) this.particles.trail(m.pos.clone().addScaledVector(m.dir, -0.5 - Math.random() * step));
      }
      keep.push(m);
    }
    this.missiles = keep;
  }

  detonate(point, surface, direct, spec) {
    const big = spec === MISSILE;
    const { hits, kills } = this.enemies.explode(point, direct, spec);
    this.explosions.spawn(point, surface, big);
    if (hits) events.emit('hit', { headshot: !!direct?.headshot, killed: kills > 0 });
    events.emit('impact', { position: point, distance: point.distanceTo(this.camera.position), big });
  }
}
