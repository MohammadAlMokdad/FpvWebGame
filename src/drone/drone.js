import * as THREE from 'three';
import { DRONE, WORLD } from '../config.js';
import { clamp, damp, smoothstep } from '../core/noise.js';
import { events } from '../core/events.js';
import { settings } from '../core/settings.js';

const DEG = Math.PI / 180;

// Arcade FPV flight model. The camera *is* the drone; there is no drone mesh.
export class Drone {
  constructor(camera, terrain, colliders, respawnPoint) {
    this.camera = camera;
    this.terrain = terrain;
    this.colliders = colliders;
    this.respawnPoint = respawnPoint;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.accel = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.time = 0;
    this.reset();
  }

  reset() {
    this.position.copy(this.respawnPoint);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = -14 * DEG;
    this.tiltPitch = 0;
    this.roll = 0;
    this.recoil = 0;
    this.shake = 0;
    this.knock = null;
    this.wheelLift = 0;
    this.hp = DRONE.maxHp;
    this.lastHit = -Infinity;
    this.downed = false;
    this.downTimer = 0;
    this.spin = 0;
    this.lossLevel = 0;
    this.protectedUntil = this.time + 2;
    this.throttle = 0;
    this.applyCamera(0);
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get altitude() {
    return this.position.y;
  }

  // Compass heading in degrees, 0 = north (-Z), clockwise.
  get heading() {
    return ((-this.yaw / DEG) % 360 + 360) % 360;
  }

  get distanceFromBase() {
    return Math.hypot(this.position.x, this.position.z);
  }

  // 1 = full signal, 0 = lost; fades toward the map edge.
  get signal() {
    return 1 - smoothstep(WORLD.signalFadeStart, WORLD.playRadius + 10, this.distanceFromBase);
  }

  // Camera shake from firing and nearby explosions (decays quickly).
  addShake(amount) {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  addRecoil(amount) {
    this.recoil = Math.min(this.recoil + amount, 2.5 * DEG);
  }

  takeDamage(amount, sourcePos) {
    if (this.downed || this.time < this.protectedUntil) return;
    this.hp = Math.max(0, this.hp - amount);
    this.lastHit = this.time;
    const dx = sourcePos.x - this.position.x;
    const dz = sourcePos.z - this.position.z;
    const sideOfSource = dx * this.right.x + dz * this.right.z;
    const angle = Math.atan2(sideOfSource, dx * this.forward.x + dz * this.forward.z);
    // Knocked away from the shooter, then rocks left and right while the motors fight back.
    this.knock = { t: 0, offset: 0, side: sideOfSource > 0 ? -1 : 1, strength: 0.7 + Math.min(1, amount / 12) * 0.5 };
    this.velocity.y -= 1.5;
    events.emit('droneHit', { amount, angle });
    if (this.hp <= 0) {
      this.downed = true;
      this.downTimer = DRONE.respawnTime;
      this.spin = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 3);
      events.emit('droneDown');
    }
  }

  update(dt, input, controlsActive) {
    this.time += dt;
    const [mdx, mdy] = controlsActive && !this.downed ? input.consumeMouse() : (input.consumeMouse(), [0, 0]);
    const sens = DRONE.mouseSensitivity * settings.sensitivity;
    this.yaw -= mdx * sens;
    this.pitch = clamp(this.pitch - mdy * sens, DRONE.pitchMin * DEG, DRONE.pitchMax * DEG);

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    if (this.downed) {
      this.updateDowned(dt);
      return;
    }

    let fwd = 0;
    let side = 0;
    let up = 0;
    // Mouse wheel: scrolling up climbs, down descends; the effect fades shortly after scrolling stops.
    const wheel = input.consumeWheel();
    this.wheelLift = clamp(damp(this.wheelLift, 0, 2, dt) - wheel * 0.004, -1, 1);
    if (controlsActive) {
      fwd = input.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
      side = input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
      up = clamp(input.axis(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'KeyC'], ['Space']) + this.wheelLift, -1, 1);
    }
    const len = Math.hypot(fwd, side) || 1;
    this.accel.set(0, 0, 0)
      .addScaledVector(this.forward, (fwd / len) * DRONE.accel)
      .addScaledVector(this.right, (side / len) * DRONE.accel);
    this.accel.y = up * DRONE.verticalAccel;

    const drag = DRONE.accel / DRONE.maxSpeed;
    const vDrag = DRONE.verticalAccel / DRONE.maxVerticalSpeed;
    this.velocity.x += (this.accel.x - drag * this.velocity.x) * dt;
    this.velocity.z += (this.accel.z - drag * this.velocity.z) * dt;
    this.velocity.y += (this.accel.y - vDrag * this.velocity.y) * dt;

    // Soft boundary: pushed back toward the base past the play radius.
    const r = this.distanceFromBase;
    if (r > WORLD.playRadius) {
      const push = (r - WORLD.playRadius) * 6 * dt;
      this.velocity.x -= (this.position.x / r) * push;
      this.velocity.z -= (this.position.z / r) * push;
    }

    this.position.addScaledVector(this.velocity, dt);
    if (this.knock) {
      // Hit: the drone rocks left-right-left (a decaying sideways offset) while it recovers.
      const k = this.knock;
      k.t += dt;
      const offset = k.side * k.strength * 1.3 * Math.sin(k.t * 9) * Math.exp(-k.t * 2.6);
      this.position.addScaledVector(this.right, offset - k.offset);
      k.offset = offset;
      if (k.t > 1.5) this.knock = null;
    }
    if (r > WORLD.playRadius + 15) {
      this.position.x *= (WORLD.playRadius + 15) / r;
      this.position.z *= (WORLD.playRadius + 15) / r;
    }
    this.colliders.resolveSphere(this.position, DRONE.radius, this.velocity);

    const floor = this.terrain.getHeight(this.position.x, this.position.z) + DRONE.minClearance;
    if (this.position.y < floor) {
      this.position.y = floor;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
    if (this.position.y > DRONE.ceiling) {
      this.position.y = DRONE.ceiling;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }

    if (this.time - this.lastHit > DRONE.regenDelay) this.hp = Math.min(DRONE.maxHp, this.hp + DRONE.regenRate * dt);

    // Visual attitude: dip when accelerating forward, bank into turns.
    const fa = clamp((this.accel.x * this.forward.x + this.accel.z * this.forward.z) / DRONE.accel, -1.5, 1.5);
    const sa = clamp((this.accel.x * this.right.x + this.accel.z * this.right.z) / DRONE.accel, -1.5, 1.5);
    this.tiltPitch = damp(this.tiltPitch, -fa * 6 * DEG, 5, dt);
    this.roll = damp(this.roll, -sa * 10 * DEG, 5, dt);
    this.throttle = damp(this.throttle, clamp(Math.hypot(fwd, side) * 0.7 + Math.abs(up) * 0.5 + this.speed / DRONE.maxSpeed * 0.3, 0, 1), 4, dt);
    this.lossLevel = damp(this.lossLevel, 0, 3, dt);
    this.applyCamera(dt);
  }

  updateDowned(dt) {
    this.downTimer -= dt;
    this.velocity.x *= Math.exp(-0.8 * dt);
    this.velocity.z *= Math.exp(-0.8 * dt);
    this.velocity.y -= 22 * dt;
    this.position.addScaledVector(this.velocity, dt);
    const floor = this.terrain.getHeight(this.position.x, this.position.z) + 0.3;
    if (this.position.y < floor) {
      this.position.y = floor;
      this.velocity.set(0, 0, 0);
      this.spin = 0;
    }
    this.roll += this.spin * dt;
    this.pitch = damp(this.pitch, -60 * DEG, 2, dt);
    this.lossLevel = damp(this.lossLevel, 1, 4, dt);
    this.applyCamera(dt);
    if (this.downTimer <= 0) {
      this.reset();
      events.emit('droneRespawn');
    }
  }

  // The camera is stabilised: it only moves with the drone's attitude, recoil, explosion
  // rumble and hit jolts — no idle vibration.
  applyCamera(dt) {
    this.recoil = damp(this.recoil, 0, 14, dt);
    this.shake = damp(this.shake, 0, 7, dt);
    const t = this.time;
    const amp = this.downed ? 0 : this.shake * 0.012;
    let jx = (Math.sin(t * 23.1) * 0.6 + Math.sin(t * 37.3 + 1.3) * 0.4) * amp;
    let jy = (Math.sin(t * 29.7 + 0.7) * 0.6 + Math.sin(t * 41.9) * 0.4) * amp;
    let jr = 0;
    if (this.knock) {
      // Hit: the frame rolls and twists hard in step with the sideways rocking, then settles.
      const { t: kt, side, strength } = this.knock;
      const decay = Math.exp(-kt * 3.2) * strength;
      jr = side * 22 * DEG * Math.sin(kt * 10) * decay;
      jy += side * 5 * DEG * Math.sin(kt * 8 + 0.6) * decay;
      jx += 3 * DEG * Math.sin(kt * 14) * decay;
    }
    this.euler.set(this.pitch + this.tiltPitch + this.recoil + jx, this.yaw + jy, this.roll + jr);
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.position.copy(this.position);
  }
}
