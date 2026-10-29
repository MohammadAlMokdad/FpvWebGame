import { WAVES } from '../config.js';
import { events } from '../core/events.js';

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Builds each wave's roster and feeds soldiers into the enemy manager.
export class WaveManager {
  constructor(enemies, paths) {
    this.enemies = enemies;
    this.paths = paths;
    this.reset(1);
  }

  reset(startWave) {
    this.wave = startWave;
    this.state = 'countdown';
    this.countdown = WAVES.firstDelay;
    this.queue = [];
    this.activeLanes = [];
    this.spawnTimer = 0;
    this.enemies.wave = startWave;
  }

  get remaining() {
    return this.queue.length + this.enemies.aliveCount;
  }

  startWave() {
    const n = this.wave;
    const count = WAVES.count(n);
    const mix = WAVES.mix(n);
    const roster = [];
    for (const [type, share] of Object.entries(mix)) {
      for (let i = 0; i < Math.round(count * share); i++) roster.push(type);
    }
    while (roster.length < count) roster.push('rifleman');
    this.queue = shuffle(roster);
    this.activeLanes = shuffle([...this.paths.lanes]).slice(0, WAVES.activeSpawns(n));
    this.spawnTimer = 0;
    this.state = 'active';
    this.enemies.wave = n;
    events.emit('waveStart', { wave: n, count, lanes: this.activeLanes.map((l) => l.id) });
  }

  update(dt, integrity) {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) this.startWave();
      return;
    }
    this.spawnTimer -= dt;
    if (this.queue.length && this.spawnTimer <= 0 && this.enemies.aliveCount < WAVES.maxAlive) {
      const lane = this.activeLanes[Math.floor(Math.random() * this.activeLanes.length)];
      this.enemies.spawn(this.queue.pop(), lane, this.wave);
      this.spawnTimer = WAVES.spawnInterval(this.wave) * (0.7 + Math.random() * 0.6);
    }
    if (!this.queue.length && this.enemies.aliveCount === 0) {
      events.emit('waveCleared', { wave: this.wave, bonus: WAVES.clearBonus(this.wave, integrity) });
      this.wave++;
      this.state = 'countdown';
      this.countdown = WAVES.intermission;
    }
  }
}
