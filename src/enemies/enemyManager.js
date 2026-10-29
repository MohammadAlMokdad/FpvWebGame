import * as THREE from 'three';
import { GUNNER, WAVES, WEAPON } from '../config.js';
import { events } from '../core/events.js';
import { ENEMY_TRACER } from '../fx/tracers.js';
import { HOT_LAYER } from '../fx/postfx.js';

const HEAD_R = 0.2;
const TORSO_R = 0.38;
const LEGS_R = 0.32;
const ANIM_LOD_DIST = 80;   // beyond this, animation updates at ~15 Hz
const IK_DIST = 110;        // beyond this, arms are not posed onto the rifle
const SINK_START = 3.5;
const REMOVE_AT = 7;
const GRAVITY = 18;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();

// Ray / sphere intersection; returns distance or Infinity.
function raySphere(o, d, c, r) {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

export class EnemyManager {
  constructor(scene, factory, { terrain, colliders, drone, particles, tracers, camera }) {
    this.scene = scene;
    this.factory = factory;
    this.terrain = terrain;
    this.colliders = colliders;
    this.drone = drone;
    this.particles = particles;
    this.tracers = tracers;
    this.camera = camera;
    this.pool = [];
    this.active = [];
    this.wave = 1;
    this.god = false;
    this.time = 0;
  }

  get aliveCount() {
    let n = 0;
    for (const s of this.active) if (s.alive) n++;
    return n;
  }

  spawn(typeKey, lane, wave) {
    const s = this.pool.pop() ?? this.factory.create();
    s.setType(typeKey);
    const def = s.def;
    s.lane = lane;
    s.wp = 1;
    s.lateral = (Math.random() - 0.5) * 5;
    s.alive = true;
    s.state = 'advance';
    s.hp = def.hp * WAVES.hpMul(wave);
    s.speed = def.speed * WAVES.speedMul(wave) * (0.92 + Math.random() * 0.16);
    s.timer = 0;
    s.flinch = 0;
    s.animAcc = 0;
    s.engageCooldown = 1 + Math.random() * 2;
    s.losTimer = 0;
    s.burstLeft = 0;
    s.fireTimer = 0;
    s.engageTime = 0;
    s.push = s.push ?? new THREE.Vector3();
    s.push.set(0, 0, 0);
    s.maxHp = s.hp;
    s.hurtAt = -Infinity;
    const start = lane.points[0];
    const next = lane.points[1];
    _dir.set(next.x - start.x, 0, next.y - start.y).normalize();
    const x = start.x - _dir.z * s.lateral;
    const z = start.y + _dir.x * s.lateral;
    s.root.position.set(x, this.terrain.getHeight(x, z), z);
    s.yaw = Math.atan2(_dir.x, _dir.z);
    s.root.rotation.set(0, s.yaw, 0);
    s.root.visible = true;
    s.mesh.layers.enable(HOT_LAYER);
    s.resetAnimation();
    this.playLocomotion(s);
    s.mixer.update(Math.random());
    if (!s.root.parent) this.scene.add(s.root);
    s.updatePose();
    s.updateHitboxes();
    this.active.push(s);
    return s;
  }

  playLocomotion(s, fade = 0.25) {
    s.play(s.def.clip, { fade, timeScale: s.speed / s.def.clipSpeed });
  }

  // Nearest soldier hit by the ray: { soldier, t, part } or null.
  raycast(origin, dir, maxDist) {
    let best = null;
    let bestT = maxDist;
    for (const s of this.active) {
      if (!s.alive) continue;
      // Cheap reject with a sphere around the whole body.
      if (raySphere(origin, dir, s.torso, 1.6 * s.def.scale) === Infinity) continue;
      const sc = s.def.scale;
      const th = raySphere(origin, dir, s.head, HEAD_R * sc);
      const tt = raySphere(origin, dir, s.torso, TORSO_R * sc);
      const tl = raySphere(origin, dir, s.legs, LEGS_R * sc);
      if (th < bestT) { bestT = th; best = { soldier: s, t: th, part: 'head' }; }
      if (tt < bestT) { bestT = tt; best = { soldier: s, t: tt, part: 'torso' }; }
      if (tl < bestT) { bestT = tl; best = { soldier: s, t: tl, part: 'legs' }; }
    }
    return best;
  }

  // Applies damage; `blast` = { center, strength 0..1, knockback } launches the body if it kills.
  damage(s, amount, headshot, blast = null) {
    if (!s.alive) return false;
    s.hp -= amount;
    s.hurtAt = this.time;
    if (s.hp <= 0) {
      this.kill(s, headshot, blast);
      return true;
    }
    if (blast) {
      _dir.subVectors(s.root.position, blast.center).setY(0);
      if (_dir.lengthSq() < 1e-4) _dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      s.push.addScaledVector(_dir.normalize(), 3.5 * blast.strength);
    }
    if (s.state !== 'engage') {
      s.flinch = 0.4;
      s.play('HitRecieve', { fade: 0.06, once: true, timeScale: 1.4 });
    }
    return false;
  }

  // Explosion: direct hit plus splash damage that falls off with distance, so a round landing
  // a few metres away wounds rather than kills. `spec` is WEAPON (gun) or MISSILE.
  // Returns { hits, kills } for hit-marker feedback.
  explode(center, direct, spec = WEAPON) {
    let hits = 0;
    let kills = 0;
    const reach = spec.splashRadius + 0.4;
    const knockback = spec.knockback;
    if (direct?.soldier.alive) {
      const dmg = spec.damage * (direct.headshot ? spec.headshotMultiplier : 1);
      hits++;
      if (this.damage(direct.soldier, dmg, direct.headshot, { center, strength: 1, knockback })) kills++;
    }
    for (const s of this.active) {
      if (!s.alive || s === direct?.soldier) continue;
      const d = Math.min(s.torso.distanceTo(center), s.legs.distanceTo(center));
      if (d > reach) continue;
      const strength = 1 - Math.pow(d / reach, 1.5);
      hits++;
      if (this.damage(s, spec.splashDamage * strength, false, { center, strength, knockback })) kills++;
    }
    return { hits, kills };
  }

  kill(s, headshot, blast) {
    s.alive = false;
    s.mesh.layers.disable(HOT_LAYER); // the dead no longer stand out in night vision
    s.state = 'dying';
    s.timer = 0;
    s.ik = false;
    s.aimBlend = 0;
    s.play('Death', { fade: 0.1, once: true, timeScale: 1.1 });
    if (blast) {
      // Thrown away from the explosion, tumbling.
      _dir.subVectors(s.root.position, blast.center).setY(0);
      if (_dir.lengthSq() < 1e-4) _dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      _dir.normalize();
      const k = (blast.knockback ?? WEAPON.knockback) * (0.45 + 0.55 * blast.strength);
      s.vel.set(_dir.x * k, 3 + 5 * blast.strength + Math.random() * 1.5, _dir.z * k);
      // Tumble backwards relative to the push direction.
      const yaw = s.root.rotation.y;
      const along = _dir.x * Math.sin(yaw) + _dir.z * Math.cos(yaw);
      const across = _dir.x * Math.cos(yaw) - _dir.z * Math.sin(yaw);
      s.spin.set(-along * (4 + Math.random() * 3), 0, across * (4 + Math.random() * 3));
      s.flying = true;
      s.bounced = false;
    }
    events.emit('kill', { type: s.type, headshot, position: s.root.position.clone() });
  }

  release(s) {
    s.root.visible = false;
    s.resetAnimation();
    this.pool.push(s);
  }

  clear() {
    for (const s of this.active) this.release(s);
    this.active.length = 0;
  }

  update(dt) {
    this.time += dt;
    const camPos = this.camera.position;
    const keep = [];
    for (const s of this.active) {
      const dist = s.root.position.distanceTo(camPos);
      if (s.state === 'dying') {
        this.updateDying(s, dt);
        if (s.timer > REMOVE_AT) {
          this.release(s);
          continue;
        }
      } else if (s.state === 'engage') {
        this.updateEngage(s, dt, dist);
      } else if (this.updateAdvance(s, dt)) {
        continue; // breached
      }
      // Animation level of detail: distant soldiers animate at ~15 Hz.
      s.animAcc += dt;
      if (dist < ANIM_LOD_DIST || s.animAcc >= 1 / 15) {
        s.mixer.update(s.animAcc);
        s.animAcc = 0;
        s.ik = s.alive && dist < IK_DIST;
        s.updatePose();
      }
      if (s.alive) s.updateHitboxes();
      keep.push(s);
    }
    this.active = keep;
    this.separate(dt);
  }

  updateDying(s, dt) {
    s.timer += dt;
    const p = s.root.position;
    if (s.flying) {
      s.vel.y -= GRAVITY * dt;
      p.addScaledVector(s.vel, dt);
      s.root.rotation.x += s.spin.x * dt;
      s.root.rotation.z += s.spin.z * dt;
      const ground = this.terrain.getHeight(p.x, p.z);
      if (p.y <= ground) {
        p.y = ground;
        if (!s.bounced && s.vel.y < -4) {
          s.vel.set(s.vel.x * 0.4, -s.vel.y * 0.25, s.vel.z * 0.4);
          s.spin.multiplyScalar(0.4);
          s.bounced = true;
        } else {
          s.flying = false;
        }
      }
      return;
    }
    // Settle flat so the death pose lies on the ground, then sink out of sight.
    s.root.rotation.x *= Math.exp(-8 * dt);
    s.root.rotation.z *= Math.exp(-8 * dt);
    if (s.timer > SINK_START) p.y -= 0.3 * dt;
  }

  // Returns true if the soldier breached the base this frame.
  updateAdvance(s, dt) {
    if (s.flinch > 0) {
      s.flinch -= dt;
      if (s.flinch <= 0) this.playLocomotion(s, 0.2);
    }
    s.aimBlend = Math.max(0, s.aimBlend - dt * 3);
    const pts = s.lane.points;
    const target = pts[s.wp];
    const prev = pts[s.wp - 1];
    // Narrow the lateral spread near the gate so soldiers file through the opening.
    const spread = s.wp >= pts.length - 3 ? 0.25 : 1;
    _dir.set(target.x - prev.x, 0, target.y - prev.y).normalize();
    _target.set(target.x - _dir.z * s.lateral * spread, 0, target.y + _dir.x * s.lateral * spread);
    _v.set(_target.x - s.root.position.x, 0, _target.z - s.root.position.z);
    const d = _v.length();
    if (d < 1.6) {
      s.wp++;
      if (s.wp >= pts.length) {
        this.breach(s);
        return true;
      }
    }
    const speed = s.flinch > 0 ? s.speed * 0.25 : s.speed;
    if (d > 1e-4) _v.multiplyScalar(Math.min(d, speed * dt) / d);
    s.root.position.x += _v.x + s.push.x * dt;
    s.root.position.z += _v.z + s.push.z * dt;
    s.push.multiplyScalar(Math.exp(-5 * dt));
    s.root.position.y = this.terrain.getHeight(s.root.position.x, s.root.position.z);
    const yaw = Math.atan2(_v.x, _v.z);
    s.yaw += Math.atan2(Math.sin(yaw - s.yaw), Math.cos(yaw - s.yaw)) * Math.min(1, dt * 6);
    s.root.rotation.y = s.yaw;

    if (s.type === 'gunner') this.considerEngaging(s, dt);
    return false;
  }

  considerEngaging(s, dt) {
    s.engageCooldown -= dt;
    if (s.engageCooldown > 0 || this.drone.downed || s.flinch > 0) return;
    const dp = this.drone.position;
    if (s.root.position.distanceTo(dp) > GUNNER.engageRange) return;
    s.losTimer -= dt;
    if (s.losTimer > 0) return;
    s.losTimer = 0.4;
    if (!this.hasLineOfSight(s)) return;
    s.state = 'engage';
    s.engageTime = 0;
    s.burstLeft = 0;
    s.fireTimer = 0.6 + Math.random() * 0.4;
    s.aimTarget = this.drone.position;
    s.play('Idle_Gun_Pointing', { fade: 0.25 });
  }

  hasLineOfSight(s) {
    _w.copy(s.torso);
    _dir.copy(this.drone.position).sub(_w);
    const dist = _dir.length();
    _dir.divideScalar(dist);
    if (this.colliders.raycast(_w, _dir, dist) < dist - 0.5) return false;
    return this.terrain.raycast(_w, _dir, dist) >= dist - 0.5;
  }

  updateEngage(s, dt, dist) {
    const dp = this.drone.position;
    const yaw = Math.atan2(dp.x - s.root.position.x, dp.z - s.root.position.z);
    s.yaw += Math.atan2(Math.sin(yaw - s.yaw), Math.cos(yaw - s.yaw)) * Math.min(1, dt * 8);
    s.root.rotation.y = s.yaw;
    s.root.position.y = this.terrain.getHeight(s.root.position.x, s.root.position.z);
    s.aimBlend = Math.min(1, s.aimBlend + dt * 3);
    s.engageTime += dt;
    const horizontal = Math.hypot(dp.x - s.root.position.x, dp.z - s.root.position.z);
    if (this.drone.downed || s.engageTime > GUNNER.maxEngageTime || horizontal > GUNNER.engageRange * 1.15) {
      s.state = 'advance';
      s.engageCooldown = GUNNER.reengageDelay + Math.random() * 2;
      this.playLocomotion(s, 0.3);
      return;
    }
    s.fireTimer -= dt;
    if (s.fireTimer > 0 || s.aimBlend < 0.9) return;
    if (s.burstLeft <= 0) {
      s.burstLeft = GUNNER.burstRounds;
      events.emit('enemyBurst', { position: s.muzzle.clone(), distance: dist });
    }
    this.fireAtDrone(s, dist);
    s.burstLeft--;
    s.fireTimer = s.burstLeft > 0
      ? GUNNER.burstInterval
      : GUNNER.cooldownMin + Math.random() * (GUNNER.cooldownMax - GUNNER.cooldownMin);
  }

  fireAtDrone(s, dist) {
    const drone = this.drone;
    const muzzle = _w.copy(s.muzzle);
    _dir.copy(drone.position).sub(muzzle).normalize();
    const rangeFactor = Math.max(0.15, 1 - dist / (GUNNER.engageRange * 1.3));
    const evasion = 1 - Math.min(0.65, drone.speed / 32);
    const hit = Math.random() < GUNNER.accuracy(this.wave) * rangeFactor * evasion && this.hasLineOfSight(s);
    _target.copy(drone.position);
    if (hit) {
      _target.y -= 0.3;
    } else {
      const miss = 1.5 + Math.random() * 3;
      _target.x += (Math.random() - 0.5) * 2 * miss;
      _target.y += (Math.random() - 0.5) * 2 * miss;
      _target.z += (Math.random() - 0.5) * 2 * miss;
      _target.addScaledVector(_dir, 25);
    }
    this.tracers.spawn(muzzle, _target, ENEMY_TRACER);
    this.particles.flash(muzzle, 0.5);
    events.emit('enemyShot', { position: muzzle.clone(), distance: dist, hit, nearMiss: !hit && Math.random() < 0.35 });
    if (hit) drone.takeDamage(GUNNER.damage(this.wave), s.root.position);
  }

  breach(s) {
    s.alive = false;
    this.particles.explosion(s.root.position);
    events.emit('breach', { type: s.type, damage: this.god ? 0 : s.def.breach, position: s.root.position.clone() });
    this.release(s);
  }

  // Keeps soldiers from walking through each other.
  separate(dt) {
    const list = this.active;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      const pa = a.root.position;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const pb = b.root.position;
        const dx = pb.x - pa.x;
        const dz = pb.z - pa.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 1.1 * 1.1 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (1.1 - d) * 0.5 * Math.min(1, dt * 10) / d;
        pa.x -= dx * push;
        pa.z -= dz * push;
        pb.x += dx * push;
        pb.z += dz * push;
      }
    }
  }
}
