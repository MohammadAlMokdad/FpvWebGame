import { load, save } from './storage.js';
import { events } from './events.js';

const DEFAULTS = { sensitivity: 1, music: 0.55, fx: 0.85, quality: 'auto', timeOfDay: 'day', vision: 'thermal' };

// Player options, persisted in localStorage. Older builds stored sensitivity on its own.
export const settings = { ...DEFAULTS, sensitivity: load('sensitivity', DEFAULTS.sensitivity), ...load('settings', {}) };

export function setSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  save('settings', settings);
  events.emit('settings', { key, value });
}
