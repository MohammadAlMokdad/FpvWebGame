import * as THREE from 'three';
import { ASSETS } from '../config.js';
import { load, save } from '../core/storage.js';
import { settings } from '../core/settings.js';

const base = import.meta.env.BASE_URL;
const SPEED_OF_SOUND = 343;
const DEG = Math.PI / 180;
// 5.1 output channel order (WebAudio "speakers"): L, R, C, LFE, SL, SR. Azimuths are
// clockwise from straight ahead.
const SPEAKERS = [
  { ch: 2, az: 0 },          // centre
  { ch: 1, az: 30 * DEG },   // front right
  { ch: 5, az: 110 * DEG },  // surround right
  { ch: 4, az: -110 * DEG }, // surround left
  { ch: 0, az: -30 * DEG },  // front left
];

const _rel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// Constant-power gains across the pair of 5.1 speakers that bracket azimuth `az`.
function surroundGains(az) {
  const gains = [0, 0, 0, 0, 0, 0];
  const ring = [...SPEAKERS].sort((a, b) => a.az - b.az);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const span = wrapAngle(b.az - a.az) || Math.PI * 2;
    const off = wrapAngle(az - a.az);
    const width = span < 0 ? span + Math.PI * 2 : span;
    const pos = off < 0 ? off + Math.PI * 2 : off;
    if (pos <= width) {
      const t = pos / width;
      gains[a.ch] = Math.cos(t * Math.PI / 2);
      gains[b.ch] = Math.sin(t * Math.PI / 2);
      return gains;
    }
  }
  gains[2] = 1;
  return gains;
}

// Recorded CC0 sound effects (see CREDITS.md) on an effects bus, the soundtrack on its own
// volume control, plus a few synthesised UI blips.
//
// Surround: every in-world sound is a 3D source. With a 5.1 (or larger) output device, sounds
// are panned across the five main speakers by their direction from the drone; otherwise HRTF
// binaural panning gives front/back/up/down cues on headphones. Both apply distance falloff,
// air absorption and the speed-of-sound delay, and follow the camera as it turns.
export class GameAudio {
  constructor(camera) {
    this.camera = camera;
    this.muted = load('muted', false);
    this.ctx = new AudioContext();
    const dest = this.ctx.destination;
    this.surround = dest.maxChannelCount >= 6;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    if (this.surround) {
      dest.channelCount = 6;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'speakers';
      this.master.connect(dest);
    } else {
      // The compressor is stereo-only, so it is used just for the stereo/binaural path.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 5;
      this.master.connect(comp).connect(dest);
    }
    this.fx = this.ctx.createGain();
    this.fx.gain.value = settings.fx;
    this.fx.connect(this.master);
    this.buffers = {};
    this.voices = []; // active 5.1-panned sources (gains follow the camera)

    this.music = new Audio(`${base}${ASSETS.music}`);
    this.music.loop = true;
    this.music.preload = 'auto';
    this.music.volume = settings.music;
    this.music.muted = this.muted;

    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  get mode() {
    return this.surround ? '5.1 surround' : '3D (HRTF)';
  }

  // Decodes every sample bank; a missing file only silences that sound.
  async load() {
    const jobs = [];
    for (const [bank, entries] of Object.entries(ASSETS.sounds)) {
      this.buffers[bank] = [];
      for (const entry of entries) {
        const { name, offset = 0 } = typeof entry === 'string' ? { name: entry } : entry;
        jobs.push(fetch(`${base}assets/audio/${name}.mp3`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
          .then((buf) => this.ctx.decodeAudioData(buf))
          .then((audio) => this.buffers[bank].push({ audio, offset }))
          .catch((err) => console.warn(`[audio] ${name}: ${err.message}`)));
      }
    }
    await Promise.all(jobs);
    this.buildLoops();
  }

  // Must be called from a user gesture (browser autoplay policy).
  unlock() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.music.paused) this.music.play().catch(() => {});
  }

  setMusicVolume(v) {
    this.music.volume = v;
  }

  setFxVolume(v) {
    this.fx.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  toggleMute() {
    this.muted = !this.muted;
    save('muted', this.muted);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.05);
    this.music.muted = this.muted;
    return this.muted;
  }

  buildLoops() {
    const ctx = this.ctx;
    // Drone motors: recorded quad loop pitched by throttle, plus four detuned saw "motors"
    // through a resonant band-pass for the characteristic FPV whine.
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.motorGain.connect(this.fx);
    const motorBuf = this.buffers.motor?.[0]?.audio;
    if (motorBuf) {
      this.motorSrc = ctx.createBufferSource();
      this.motorSrc.buffer = motorBuf;
      this.motorSrc.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0.9;
      this.motorSrc.connect(g).connect(this.motorGain);
      this.motorSrc.start();
    }
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.value = 900;
    this.whineFilter = bp;
    const whine = ctx.createGain();
    whine.gain.value = 0.22;
    bp.connect(whine).connect(this.motorGain);
    this.motors = [-9, 4, 13, -2].map((detune) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = detune;
      o.frequency.value = 220;
      o.connect(bp);
      o.start();
      return o;
    });
    // Prop wash: band-passed noise that rises with speed.
    const wash = this.loopBuffer(this.noise);
    const washBp = ctx.createBiquadFilter();
    washBp.type = 'bandpass';
    washBp.frequency.value = 1400;
    washBp.Q.value = 0.6;
    this.washGain = ctx.createGain();
    this.washGain.gain.value = 0;
    wash.connect(washBp).connect(this.washGain).connect(this.fx);
    // Video static hiss.
    this.staticGain = ctx.createGain();
    this.staticGain.gain.value = 0;
    this.staticGain.connect(this.fx);
    this.loopBuffer(this.buffers.static?.[0]?.audio ?? this.noise).connect(this.staticGain);
  }

  loopBuffer(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(0, Math.random() * Math.min(1.5, buffer.duration * 0.5));
    return src;
  }

  // Continuous layers, called every frame.
  setLoops(throttle, active, staticLevel) {
    if (!this.motorGain) return;
    const t = this.ctx.currentTime;
    const rate = 0.78 + throttle * 0.55;
    this.motorSrc?.playbackRate.setTargetAtTime(rate, t, 0.06);
    const f = 190 + throttle * 330;
    this.motors.forEach((o) => o.frequency.setTargetAtTime(f, t, 0.05));
    this.whineFilter.frequency.setTargetAtTime(f * 3.2, t, 0.05);
    this.motorGain.gain.setTargetAtTime(active ? 0.22 + throttle * 0.2 : 0, t, 0.12);
    this.washGain.gain.setTargetAtTime(active ? throttle * 0.06 : 0, t, 0.15);
    this.staticGain.gain.setTargetAtTime(Math.min(0.5, staticLevel * 0.5), t, 0.05);
  }

  // Moves the listener with the camera and re-pans active 5.1 voices. Call every frame.
  updateListener() {
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(cam.position.x, t);
      l.positionY.setValueAtTime(cam.position.y, t);
      l.positionZ.setValueAtTime(cam.position.z, t);
      l.forwardX.setValueAtTime(_fwd.x, t);
      l.forwardY.setValueAtTime(_fwd.y, t);
      l.forwardZ.setValueAtTime(_fwd.z, t);
      l.upX.setValueAtTime(_up.x, t);
      l.upY.setValueAtTime(_up.y, t);
      l.upZ.setValueAtTime(_up.z, t);
    } else {
      l.setPosition(cam.position.x, cam.position.y, cam.position.z);
      l.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
    if (!this.voices.length) return;
    const now = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => v.end > now);
    for (const v of this.voices) this.panVoice(v);
  }

  panVoice(v) {
    const cam = this.camera;
    _rel.subVectors(v.position, cam.position);
    const d = Math.max(0.5, _rel.length());
    cam.getWorldDirection(_fwd);
    _fwd.y = 0;
    _fwd.normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
    const az = Math.atan2(_rel.dot(_right), _rel.dot(_fwd));
    const gains = surroundGains(az);
    const atten = v.ref / (v.ref + Math.max(0, d - v.ref));
    const t = this.ctx.currentTime;
    gains.forEach((g, ch) => v.gains[ch].gain.setTargetAtTime(g * atten, t, 0.03));
  }

  // Plays a random sample from a bank. Options: gain, rate, delay, lowpass (Hz), duration
  // (seconds, then fades out), position (THREE.Vector3 → 3D source), ref (metres at which a
  // positional sound is at full volume).
  play(bank, { gain = 1, rate = 1, delay = 0, lowpass = 0, duration = 0, position = null, ref = 10 } = {}) {
    const list = this.buffers[bank];
    if (!list?.length || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const sample = list[Math.floor(Math.random() * list.length)];
    let d = 0;
    if (position) {
      d = position.distanceTo(this.camera.position);
      delay += d / SPEED_OF_SOUND;
      lowpass = lowpass || THREE.MathUtils.clamp(18000 * Math.exp(-d / 90), 900, 18000);
    }
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = sample.audio;
    src.playbackRate.value = rate;
    let node = src;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node = node.connect(f);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    if (duration) g.gain.setTargetAtTime(0, t + duration * 0.7, duration * 0.15);
    node = node.connect(g);
    const length = (duration || (sample.audio.duration - sample.offset) / rate) + 0.3;

    if (position && this.surround) {
      const merger = ctx.createChannelMerger(6);
      const voice = { position: position.clone(), ref, gains: [], end: t + length };
      for (let ch = 0; ch < 6; ch++) {
        const cg = ctx.createGain();
        cg.gain.value = 0;
        node.connect(cg).connect(merger, 0, ch);
        voice.gains.push(cg);
      }
      merger.connect(this.fx);
      this.panVoice(voice);
      this.voices.push(voice);
    } else if (position) {
      const panner = new PannerNode(ctx, {
        panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, rolloffFactor: 1, maxDistance: 2000,
        positionX: position.x, positionY: position.y, positionZ: position.z,
      });
      node.connect(panner).connect(this.fx);
    } else {
      node.connect(this.fx);
    }
    src.start(t, sample.offset);
    src.stop(t + length);
  }

  tone({ freq, freq2 = freq, duration, type = 'sine', gain = 0.2, delay = 0 }) {
    if (this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq2, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    o.connect(g).connect(this.fx);
    o.start(t);
    o.stop(t + duration + 0.05);
  }

  shot() {
    this.play('gun', { gain: 0.75, rate: 0.95 + Math.random() * 0.1 });
  }

  missileLaunch() {
    this.play('missileLaunch', { gain: 0.9, duration: 2.6 });
    this.tone({ freq: 90, freq2: 40, duration: 0.35, gain: 0.25 });
  }

  explosion(position, big = false) {
    if (big) {
      this.play('explosionBig', { position, gain: 2.2, ref: 30 });
      this.play('explosion', { position, gain: 1.6, rate: 0.7, ref: 30 });
    } else {
      this.play('explosion', { position, gain: 1.5, rate: 0.9 + Math.random() * 0.2, ref: 16 });
    }
  }

  dryFire() {
    this.tone({ freq: 2400, freq2: 1800, duration: 0.03, type: 'square', gain: 0.06 });
    this.tone({ freq: 700, duration: 0.05, type: 'triangle', gain: 0.06, delay: 0.03 });
  }

  hit(headshot) {
    this.tone({ freq: headshot ? 2400 : 1600, duration: 0.05, type: 'triangle', gain: 0.1 });
  }

  kill(headshot) {
    this.tone({ freq: 900, duration: 0.07, type: 'square', gain: 0.05 });
    this.tone({ freq: headshot ? 1800 : 1350, duration: 0.12, type: 'square', gain: 0.05, delay: 0.07 });
  }

  enemyBurst(position) {
    this.play('enemyBurst', { position, gain: 1.2, rate: 0.95 + Math.random() * 0.1, ref: 12 });
  }

  // A round snapping past the drone, placed on the shooter's side.
  whiz(from) {
    const cam = this.camera.position;
    _rel.subVectors(from, cam).setY(0).normalize();
    const pos = cam.clone().addScaledVector(_rel, 2).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() - 0.5, (Math.random() - 0.5) * 2));
    this.play('whiz', { position: pos, gain: 1.1, rate: 0.95 + Math.random() * 0.1, ref: 3, lowpass: 18000 });
  }

  droneHit() {
    this.play('clank', { gain: 0.9, rate: 1.1 + Math.random() * 0.3 });
  }

  droneDown() {
    this.play('explosion', { gain: 1.2, rate: 0.8 });
    this.tone({ freq: 600, freq2: 60, duration: 1.2, type: 'sawtooth', gain: 0.08 });
  }

  breach(position) {
    this.play('explosion', { position, gain: 1.6, rate: 0.75, ref: 25 });
    this.play('siren', { position: new THREE.Vector3(0, 8, 0), gain: 0.9, duration: 3, ref: 40 });
  }

  waveStart() {
    this.tone({ freq: 110, duration: 0.9, type: 'sawtooth', gain: 0.08 });
    this.tone({ freq: 165, duration: 0.9, type: 'sawtooth', gain: 0.05 });
  }

  waveCleared() {
    [660, 880, 1320].forEach((f, i) => this.tone({ freq: f, duration: 0.18, type: 'triangle', gain: 0.1, delay: i * 0.12 }));
  }

  gameOver() {
    this.play('explosion', { gain: 1.5, rate: 0.7 });
    this.tone({ freq: 440, freq2: 55, duration: 2.2, type: 'sawtooth', gain: 0.08 });
  }
}
