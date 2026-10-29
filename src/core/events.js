// Tiny synchronous event bus shared by game systems, HUD and audio.

const listeners = new Map();

export const events = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  },
  emit(name, payload) {
    const set = listeners.get(name);
    if (set) for (const fn of set) fn(payload);
  },
};
