import * as THREE from 'three';
import './ui/hud.css';
import { AMMO, DEBUG, DRONE, QUALITY } from './config.js';
import { events } from './core/events.js';
import { settings, setSetting } from './core/settings.js';
import { loadAssets } from './core/assets.js';
import { Input } from './core/input.js';
import { Game } from './core/game.js';
import { damp, clamp } from './core/noise.js';
import { createPaths } from './world/paths.js';
import { createTerrain } from './world/terrain.js';
import { createEnvironment } from './world/environment.js';
import { createGrass } from './world/grass.js';
import { Drone } from './drone/drone.js';
import { Weapon } from './drone/weapon.js';
import { SoldierFactory } from './enemies/soldier.js';
import { EnemyManager } from './enemies/enemyManager.js';
import { WaveManager } from './enemies/waveManager.js';
import { createPostFX, HOT_LAYER } from './fx/postfx.js';
import { Particles } from './fx/particles.js';
import { Tracers } from './fx/tracers.js';
import { Explosions } from './fx/explosions.js';
import { HealthBars } from './fx/healthbars.js';
import { GameAudio } from './audio/audio.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';

const TYPE_LABEL = { rifleman: 'RIFLEMAN', runner: 'RUNNER', heavy: 'HEAVY', gunner: 'GUNNER' };
const WAVE_INTRO = 10; // seconds the opening countdown is titled "DEFEND THE OUTPOST"
const SMOKE_POINTS = [new THREE.Vector3(-7, 3.3, 6), new THREE.Vector3(15.5, 9.8, 15.5), new THREE.Vector3(-12, 0.5, -6), new THREE.Vector3(9, 0.5, 9)];

const screens = new Screens();
screens.show('loading');

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.info.autoReset = false;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(DRONE.fov, innerWidth / innerHeight, 0.1, 800);
camera.layers.enable(HOT_LAYER);
scene.add(camera); // so the camera-mounted IR illuminator is part of the scene

const VISIONS = ['thermal', 'green', 'white'];
const VISION_GAIN = { thermal: 7, green: 8, white: 8 };
const IR_INTENSITY = 26;

async function boot() {
  const audio = new GameAudio(camera);
  const [assets] = await Promise.all([
    loadAssets(renderer, (p) => screens.setProgress(p)),
    audio.load(),
  ]);
  const paths = createPaths();
  const terrain = createTerrain(paths, assets.textures);
  const env = createEnvironment(scene, renderer, assets, terrain, paths);
  const grass = createGrass(scene, terrain);
  const factory = new SoldierFactory(assets.soldier, assets.models.ak47);
  const particles = new Particles(scene);
  const tracers = new Tracers(scene, camera);
  const explosions = new Explosions(scene, particles, terrain);
  const healthBars = new HealthBars(scene);
  const drone = new Drone(camera, terrain, env.colliders, env.respawnPoint);
  const input = new Input(renderer.domElement);
  const enemies = new EnemyManager(scene, factory, { terrain, colliders: env.colliders, drone, particles, tracers, camera });
  const waves = new WaveManager(enemies, paths);
  const weapon = new Weapon({ scene, camera, drone, enemies, terrain, colliders: env.colliders, particles, tracers, explosions });
  const post = createPostFX(renderer, scene, camera);
  const hud = new Hud();
  document.getElementById('audio-mode').textContent = `AUDIO: ${audio.mode.toUpperCase()}`;
  const game = new Game({ enemies, waves, drone, particles, tracers, hud });

  hud.setMuted(audio.muted);

  // --- Day / night and the night-vision camera --------------------------------
  // IR illuminator under the drone: lights the ground ahead in the night-vision modes.
  const irLight = new THREE.SpotLight(0xffffff, 0, 160, 0.85, 0.95, 1);
  irLight.position.set(0, -0.3, 0);
  irLight.target.position.set(0, -0.3, -1);
  camera.add(irLight, irLight.target);
  function applyVision() {
    const night = settings.timeOfDay === 'night';
    const mode = night ? settings.vision : 'day';
    env.setTimeOfDay(night ? 'night' : 'day', mode === 'thermal');
    post.setVision(mode, VISION_GAIN[mode] ?? 1);
    irLight.intensity = night && mode !== 'thermal' ? IR_INTENSITY : 0;
    hud.setVision(mode);
  }
  applyVision();

  // --- Graphics quality & resolution ---------------------------------------
  let preset = QUALITY.auto;
  const dyn = { scale: 1, acc: 0, frames: 0, good: 0, ceiling: 1, ceilingTimer: 0, capped: 0 };
  const sceneSize = new THREE.Vector2();

  function applyScale(scale) {
    dyn.scale = scale;
    post.configure({ msaa: preset.msaa, renderScale: scale });
    renderer.getDrawingBufferSize(sceneSize);
    particles.setViewport(sceneSize.y * scale, camera.fov);
  }

  function applyQuality() {
    preset = QUALITY[DEBUG.quality] ?? QUALITY[settings.quality] ?? QUALITY.auto;
    renderer.setPixelRatio(Math.min(devicePixelRatio, preset.pixelRatio));
    renderer.setSize(innerWidth, innerHeight);
    env.setShadowQuality(preset.shadowSize, preset.treeShadows);
    grass.setDensity(preset.grass);
    dyn.ceiling = preset.dynamic?.max ?? preset.renderScale;
    applyScale(preset.dynamic ? Math.min(dyn.scale, dyn.ceiling) : preset.renderScale);
  }

  // "Auto" lowers the 3D render resolution when the frame rate dips and raises it again
  // when there is headroom; a resolution that caused a dip is avoided for a while.
  function adaptResolution(rawDt) {
    dyn.acc += rawDt;
    dyn.frames++;
    if (dyn.acc < 0.5) return;
    const fps = dyn.frames / dyn.acc;
    dyn.acc = 0;
    dyn.frames = 0;
    dyn.ceilingTimer -= 0.5;
    if (dyn.ceilingTimer <= 0) dyn.ceiling = preset.dynamic?.max ?? 1;
    // A steady ~30 FPS usually means the browser itself caps the frame rate.
    dyn.capped = fps > 27 && fps < 32 ? dyn.capped + 0.5 : 0;
    screens.showPerfHint(dyn.capped > 6);
    if (!preset.dynamic) return;
    const { min, max } = preset.dynamic;
    if (fps < 54 && dyn.scale > min) {
      dyn.ceiling = Math.max(min, dyn.scale - 0.05);
      dyn.ceilingTimer = 20;
      applyScale(Math.max(min, dyn.scale - (fps < 40 ? 0.15 : 0.08)));
      dyn.good = 0;
    } else if (fps > 58) {
      dyn.good += 0.5;
      if (dyn.good >= 3 && dyn.scale < Math.min(max, dyn.ceiling)) {
        applyScale(Math.min(max, dyn.ceiling, dyn.scale + 0.05));
        dyn.good = 0;
      }
    } else {
      dyn.good = 0;
    }
  }

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    applyQuality();
  }
  addEventListener('resize', resize);
  resize();

  events.on('settings', ({ key, value }) => {
    if (key === 'timeOfDay' || key === 'vision') applyVision();
    if (key === 'music') audio.setMusicVolume(value);
    if (key === 'fx') audio.setFxVolume(value);
    if (key === 'quality') {
      dyn.scale = 1;
      applyQuality();
    }
  });

  // Pre-compile shaders (soldiers, rifles, explosion lights) so the first wave doesn't hitch.
  Object.keys(factory.geometries).forEach((type, i) => enemies.spawn(type, paths.lanes[i % paths.lanes.length], 1));
  explosions.spawn(new THREE.Vector3(0, 0, 30), 'ground');
  camera.position.set(0, 40, 60);
  camera.lookAt(0, 0, 0);
  await renderer.compileAsync(scene, camera);
  enemies.clear();
  explosions.clear();

  // --- Flow between screens -------------------------------------------------
  let pendingStart = false;
  document.addEventListener('pointerdown', () => audio.unlock());
  const issueAmmo = (wave) => weapon.refill(AMMO.gun(wave), AMMO.missiles(wave));
  let dryTimer = 0;
  const beginRun = () => {
    weapon.clear();
    explosions.clear();
    healthBars.clear();
    dryTimer = 0;
    game.start();
    issueAmmo(DEBUG.startWave);
    screens.hideAll();
    hud.setVisible(true);
  };
  const requestStart = () => {
    audio.unlock();
    screens.setLockHint('');
    if (DEBUG.autostart) {
      beginRun();
      return;
    }
    pendingStart = true;
    input.lock();
  };
  const toMenu = () => {
    game.exitToMenu();
    weapon.clear();
    explosions.clear();
    healthBars.clear();
    hud.setVisible(false);
    screens.setMenuHighScore(game.highScore);
    screens.show('menu');
  };
  screens.onClick('deploy', requestStart);
  screens.onClick('redeploy', requestStart);
  screens.onClick('resume', () => {
    audio.unlock();
    input.lock();
  });
  screens.onClick('exit', toMenu);
  screens.onClick('to-menu', toMenu);

  events.on('pointerlock', (locked) => {
    if (locked && pendingStart) {
      pendingStart = false;
      beginRun();
    } else if (locked && game.state === 'paused') {
      game.resume();
      screens.hideAll();
    } else if (!locked && game.state === 'playing') {
      game.pause();
      screens.show('pause');
    }
  });
  events.on('pointerlockerror', () => {
    pendingStart = false;
    screens.setLockHint('Mouse capture was blocked. Wait a second and click again.');
  });

  // --- Feedback ------------------------------------------------------------
  const fx = { noise: 0, glitch: 0, flash: 0 };
  events.on('shot', ({ kind }) => (kind === 'missile' ? audio.missileLaunch() : audio.shot()));
  events.on('dryFire', () => audio.dryFire());
  events.on('impact', ({ position, distance, big }) => {
    audio.explosion(position, big);
    const reach = big ? 70 : 30;
    if (distance < reach) {
      drone.addShake((1 - distance / reach) * (big ? 1.5 : 0.9));
      fx.flash = Math.max(fx.flash, (1 - distance / reach) * (big ? 0.6 : 0.35));
      if (big) fx.glitch = Math.max(fx.glitch, (1 - distance / reach) * 0.5);
    }
  });
  events.on('hit', ({ headshot, killed }) => {
    hud.hitMarker(headshot, killed);
    audio.hit(headshot);
  });
  events.on('killScored', ({ type, headshot, points }) => {
    hud.killFeed(`${headshot ? 'HEADSHOT' : TYPE_LABEL[type]} KIA  +${points}`, headshot);
    audio.kill(headshot);
  });
  events.on('enemyBurst', ({ position }) => audio.enemyBurst(position));
  events.on('enemyShot', ({ nearMiss, position }) => {
    if (nearMiss) audio.whiz(position);
  });
  events.on('droneHit', ({ angle }) => {
    hud.damageArrow(angle);
    // Video breaks up for a moment; no red tint.
    fx.noise = Math.max(fx.noise, 0.55);
    fx.glitch = Math.max(fx.glitch, 0.85);
    audio.droneHit();
  });
  events.on('droneDown', () => audio.droneDown());
  events.on('droneRespawn', () => hud.showBanner('LINK RESTORED', 'DRONE RELAUNCHED FROM BASE', 1.8));
  events.on('breach', ({ position }) => {
    if (game.state !== 'playing' && game.state !== 'gameover') return;
    hud.showAlert('PERIMETER BREACH');
    fx.glitch = Math.max(fx.glitch, 0.6);
    fx.noise = Math.max(fx.noise, 0.3);
    audio.breach(position);
  });
  events.on('waveStart', ({ wave, count }) => {
    issueAmmo(wave);
    hud.showBanner(`WAVE ${wave}`, `${count} HOSTILES  ·  ${weapon.ammo} ROUNDS  ·  ${weapon.rockets} MISSILES`, 3.2);
    audio.waveStart();
  });
  events.on('waveCleared', ({ wave, bonus }) => {
    hud.showBanner(`WAVE ${wave} CLEARED`, `+${bonus.toLocaleString()}  ·  BASE REPAIRED`, 3);
    audio.waveCleared();
  });
  events.on('gameOver', (stats) => {
    input.unlock();
    hud.setVisible(false);
    fx.glitch = 1;
    screens.showGameOver(stats);
    screens.setMenuHighScore(game.highScore);
    audio.gameOver();
  });
  events.on('key', (code) => {
    if (code === 'KeyM') hud.setMuted(audio.toggleMute());
    // V cycles the night-vision camera mode mid-mission (night only).
    if (code === 'KeyV' && settings.timeOfDay === 'night' && game.state === 'playing') {
      setSetting('vision', VISIONS[(VISIONS.indexOf(settings.vision) + 1) % VISIONS.length]);
      fx.glitch = Math.max(fx.glitch, 0.6);
      fx.noise = Math.max(fx.noise, 0.5);
      audio.tone({ freq: 1800, freq2: 900, duration: 0.06, type: 'square', gain: 0.05 });
    }
    if (code === 'Backquote') debugEl.classList.toggle('hidden');
  });

  // --- Main loop -------------------------------------------------------------
  const debugEl = document.getElementById('debug');
  const shadowFocus = new THREE.Vector3();
  let time = 0;
  let smokeAcc = 0;
  let fps = 60;
  let cpuMs = 0;
  let last = performance.now();
  let menuAngle = 0.6;

  function frame(now) {
    requestAnimationFrame(frame);
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(0.05, rawDt);
    time += dt;
    fps = damp(fps, 1 / Math.max(rawDt, 1e-3), 3, dt);
    adaptResolution(rawDt);
    const state = game.state;
    const cpuStart = performance.now();

    if (state === 'playing') {
      game.missionTime += dt;
      drone.update(dt, input, true);
      weapon.update(dt, input.firing, input.missileHeld);
      enemies.update(dt);
      waves.update(dt, game.integrity);
      // Out of rounds and missiles with soldiers still coming: the outpost is lost (after a
      // short grace period so the last shots can land).
      const dry = waves.state === 'active' && weapon.ammo <= 0 && weapon.rockets <= 0 && !weapon.inFlight && waves.remaining > 0;
      dryTimer = dry ? dryTimer + dt : 0;
      if (dryTimer > 1.5) game.gameOver('ammo');
    } else if (state === 'menu') {
      menuAngle += dt * 0.04;
      camera.position.set(Math.cos(menuAngle) * 75, 34, Math.sin(menuAngle) * 75);
      camera.lookAt(0, 2, 0);
      input.consumeMouse();
    } else {
      input.consumeMouse();
    }
    if (state !== 'paused') {
      particles.update(dt);
      tracers.update(dt);
      explosions.update(dt);
    }
    healthBars.update(enemies.active, enemies.time);
    audio.updateListener();

    // Smoke rises from the outpost as it takes damage.
    const damage = 1 - game.integrity / 100;
    if (state !== 'menu' && damage > 0.25) {
      smokeAcc += dt * damage * 10;
      while (smokeAcc > 1) {
        smokeAcc -= 1;
        particles.smoke(SMOKE_POINTS[Math.floor(Math.random() * SMOKE_POINTS.length)], damage);
      }
    }

    camera.getWorldDirection(shadowFocus);
    shadowFocus.y = 0;
    shadowFocus.normalize().multiplyScalar(35).add(camera.position);
    env.update(shadowFocus, camera.position);
    grass.update(camera.position, time);

    // Video feed condition.
    fx.noise = damp(fx.noise, 0, 2.5, dt);
    fx.glitch = damp(fx.glitch, 0, 3, dt);
    fx.flash = damp(fx.flash, 0, 12, dt);
    if (Math.random() < dt * 0.12) fx.glitch = Math.max(fx.glitch, 0.25);
    const u = post.uniforms;
    const playingView = state === 'playing' || state === 'paused';
    u.uNoise.value = clamp(Math.max(playingView ? (1 - drone.signal) * 0.9 : 0.05, fx.noise), 0, 1);
    u.uGlitch.value = state === 'gameover' ? Math.max(0.5, fx.glitch) : fx.glitch;
    u.uLoss.value = state === 'gameover' ? 0.3 : playingView ? drone.lossLevel : 0;
    u.uFlash.value = fx.flash;
    audio.setLoops(drone.throttle, state === 'playing' && !drone.downed, Math.max(u.uLoss.value, u.uNoise.value * 0.6));

    renderer.info.reset();
    post.render(time);
    cpuMs = damp(cpuMs, performance.now() - cpuStart, 3, dt);

    if (playingView) {
      hud.update(dt, {
        drone,
        missionTime: game.missionTime,
        wave: waves.wave,
        hostiles: waves.remaining,
        score: game.score,
        highScore: game.highScore,
        integrity: game.integrity,
        enemies: enemies.active,
        weapon,
        muzzleFlash: weapon.flash,
        countdown: waves.state === 'countdown' ? waves.countdown : null,
        countdownTitle: waves.wave === DEBUG.startWave && game.missionTime < WAVE_INTRO ? 'DEFEND THE OUTPOST' : `WAVE ${waves.wave}`,
      });
    }
    if (!debugEl.classList.contains('hidden')) {
      const info = renderer.info.render;
      debugEl.textContent = `FPS ${fps.toFixed(0)}  CPU ${cpuMs.toFixed(1)}ms  3D ${post.size} (${Math.round(dyn.scale * 100)}%)  DRAWS ${info.calls}  TRIS ${(info.triangles / 1000).toFixed(0)}k  SOLDIERS ${enemies.active.length}`;
    }
  }

  game.state = 'menu';
  screens.setMenuHighScore(game.highScore);
  if (DEBUG.active) screens.setDebugNote(`DEBUG MODE${DEBUG.startWave > 1 ? ` · START WAVE ${DEBUG.startWave}` : ''}${DEBUG.god ? ' · BASE INVULNERABLE' : ''} · HIGH SCORE NOT SAVED`);
  screens.show('menu');
  if (DEBUG.autostart) requestStart();
  requestAnimationFrame(frame);

  // Exposed for debugging from the browser console.
  window.__game = { game, drone, enemies, waves, camera, scene, renderer, env, terrain, input, weapon, tracers, particles, explosions, post, audio };
}

boot().catch((err) => {
  console.error(err);
  const panel = document.querySelector('#loading .panel');
  panel.insertAdjacentHTML('beforeend', `<p class="red">Failed to start: ${String(err.message || err).replace(/</g, '&lt;')}</p>`);
});
