import { events } from './events.js';

const BLOCKED = new Set(['Space', 'ShiftLeft', 'ShiftRight', 'Tab', 'ArrowUp', 'ArrowDown']);

// Keyboard + mouse state with pointer lock.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.firing = false;
    this.missileHeld = false;
    this.locked = false;

    addEventListener('keydown', (e) => {
      if (BLOCKED.has(e.code)) e.preventDefault();
      if (!e.repeat) events.emit('key', e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.firing = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Some browsers emit occasional huge spikes right after locking.
      this.mouseDX += Math.max(-250, Math.min(250, e.movementX));
      this.mouseDY += Math.max(-250, Math.min(250, e.movementY));
    });
    // Wheel (normalised to pixels) climbs/descends while the mouse is captured.
    document.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.wheel += e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    }, { passive: false });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.firing = true;
      if (e.button === 2) this.missileHeld = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
      if (e.button === 2) this.missileHeld = false;
    });
    document.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.firing = false;
        this.missileHeld = false;
      }
      this.mouseDX = this.mouseDY = 0;
      events.emit('pointerlock', this.locked);
    });
  }

  async lock() {
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try {
        await this.canvas.requestPointerLock();
      } catch {
        events.emit('pointerlockerror');
      }
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  consumeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  consumeMouse() {
    const d = [this.mouseDX, this.mouseDY];
    this.mouseDX = this.mouseDY = 0;
    return d;
  }

  axis(negCodes, posCodes) {
    const pos = posCodes.some((c) => this.keys.has(c)) ? 1 : 0;
    const neg = negCodes.some((c) => this.keys.has(c)) ? 1 : 0;
    return pos - neg;
  }
}
