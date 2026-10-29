import { DEBUG, ENEMY_TYPES, SCORING, WAVES } from '../config.js';
import { events } from './events.js';
import { load, save } from './storage.js';

// Game state machine, score and base integrity.
// States: loading → menu → playing ⇄ paused → gameover → playing …
export class Game {
  constructor(systems) {
    this.sys = systems;
    this.state = 'loading';
    this.highScore = load('highScore', 0);
    this.resetStats();

    events.on('kill', ({ type, headshot }) => {
      if (this.state !== 'playing') return;
      const base = ENEMY_TYPES[type].score;
      const pts = Math.round(base * (headshot ? 1 + SCORING.headshotBonus : 1));
      this.score += pts;
      events.emit('killScored', { type, headshot, points: pts });
      this.kills++;
      if (headshot) this.headshots++;
    });
    events.on('hit', () => this.hits++);
    events.on('shot', () => this.shots++);
    events.on('breach', ({ damage }) => {
      if (this.state !== 'playing') return;
      this.integrity = Math.max(0, this.integrity - damage);
      if (this.integrity <= 0) this.gameOver();
    });
    events.on('waveCleared', ({ bonus }) => {
      if (this.state !== 'playing') return;
      this.score += bonus;
      this.integrity = Math.min(100, this.integrity + WAVES.repairOnClear);
      this.saveHighScore();
    });
  }

  resetStats() {
    this.score = 0;
    this.kills = 0;
    this.headshots = 0;
    this.shots = 0;
    this.hits = 0;
    this.integrity = 100;
    this.missionTime = 0;
    this.recordSet = false;
  }

  // Fresh run from the configured start wave.
  start() {
    const { enemies, waves, drone, particles, tracers, hud } = this.sys;
    this.resetStats();
    enemies.clear();
    enemies.god = DEBUG.god;
    particles.clear();
    tracers.clear();
    drone.reset();
    waves.reset(DEBUG.startWave);
    hud.clearTransient();
    this.state = 'playing';
    events.emit('gameStart');
  }

  pause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      events.emit('paused');
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = 'playing';
      events.emit('resumed');
    }
  }

  // Abandon the run (pause menu "Exit"). A beaten high score still counts.
  exitToMenu() {
    this.saveHighScore();
    const { enemies, particles, tracers, hud } = this.sys;
    enemies.clear();
    particles.clear();
    tracers.clear();
    hud.clearTransient();
    this.state = 'menu';
    events.emit('exitToMenu');
  }

  // reason: 'base' (integrity reached 0) or 'ammo' (rounds and missiles ran out mid-wave).
  gameOver(reason = 'base') {
    this.state = 'gameover';
    this.saveHighScore();
    const newHigh = this.recordSet;
    events.emit('gameOver', {
      score: this.score,
      wave: this.sys.waves.wave,
      kills: this.kills,
      headshots: this.headshots,
      accuracy: this.shots ? this.hits / this.shots : 0,
      highScore: this.highScore,
      newHigh,
      reason,
    });
  }

  // Debug runs never count toward the high score.
  saveHighScore() {
    if (DEBUG.active || this.score <= this.highScore) return;
    this.highScore = this.score;
    this.recordSet = true;
    save('highScore', this.highScore);
  }
}
