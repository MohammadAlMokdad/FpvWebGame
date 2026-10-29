import { settings, setSetting } from '../core/settings.js';
import { events } from '../core/events.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['loading', 'menu', 'pause', 'gameover'];

const format = {
  sensitivity: (v) => Number(v).toFixed(2),
  music: (v) => `${Math.round(v * 100)}%`,
  fx: (v) => `${Math.round(v * 100)}%`,
};

// Full-screen overlays: loading, main menu, pause and game over. Every control marked
// data-setting="…" edits the shared settings and stays in sync across screens.
export class Screens {
  constructor() {
    this.controls = [...document.querySelectorAll('[data-setting]')];
    for (const el of this.controls) {
      const key = el.dataset.setting;
      el.addEventListener('input', () => {
        const value = el.tagName === 'SELECT' ? el.value : parseFloat(el.value);
        setSetting(key, value);
      });
    }
    events.on('settings', () => this.syncSettings());
    this.syncSettings();
  }

  syncSettings() {
    for (const el of this.controls) {
      const key = el.dataset.setting;
      if (String(el.value) !== String(settings[key])) el.value = settings[key];
    }
    // Night vision only applies to night missions.
    for (const el of document.querySelectorAll('[data-setting="vision"]')) el.disabled = settings.timeOfDay !== 'night';
    for (const el of document.querySelectorAll('[data-value]')) {
      const key = el.dataset.value;
      el.textContent = format[key] ? format[key](settings[key]) : settings[key];
    }
  }

  show(name) {
    for (const s of SCREENS) $(s).classList.toggle('hidden', s !== name);
  }

  hideAll() {
    this.show(null);
  }

  setProgress(p) {
    $('progress-fill').style.width = `${Math.round(p * 100)}%`;
  }

  setMenuHighScore(v) {
    $('menu-hi').textContent = v.toLocaleString();
  }

  setDebugNote(text) {
    const el = $('debug-note');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  setLockHint(text) {
    $('lock-hint').textContent = text;
  }

  showPerfHint(show) {
    for (const el of document.querySelectorAll('.perf-hint')) el.classList.toggle('hidden', !show);
  }

  showGameOver({ score, wave, kills, headshots, accuracy, highScore, newHigh, reason }) {
    const ammo = reason === 'ammo';
    $('go-title').textContent = ammo ? 'OUT OF AMMUNITION' : 'BASE OVERRUN';
    $('go-sub').textContent = ammo ? 'THE OUTPOST CAN NO LONGER BE DEFENDED' : 'THE OUTPOST HAS FALLEN';
    $('go-score').textContent = score.toLocaleString();
    $('go-wave').textContent = wave;
    $('go-kills').textContent = kills;
    $('go-heads').textContent = headshots;
    $('go-acc').textContent = `${Math.round(accuracy * 100)}%`;
    $('go-hi').textContent = highScore.toLocaleString();
    $('newhi').classList.toggle('hidden', !newHigh);
    this.show('gameover');
  }

  onClick(id, fn) {
    $(id).addEventListener('click', fn);
  }
}
