// Every gameplay tunable lives here.

export const WORLD = {
  size: 560,             // terrain edge length (m); the playable area is the inner circle
  segments: 280,         // terrain grid resolution (2 m per cell)
  baseHalf: 20,          // compound walls sit at ±baseHalf
  gateWidth: 6,
  spawnRadius: 178,
  spawnAngles: [20, 80, 140, 200, 260, 320], // degrees, atan2(z, x)
  playRadius: 205,       // soft boundary: drone pushed back past this
  signalFadeStart: 185,  // video static grows beyond the spawn ring
  fogDensity: 0.003,
  seed: 1337,
};

export const DRONE = {
  accel: 42,
  maxSpeed: 22,
  verticalAccel: 26,
  maxVerticalSpeed: 10,
  minClearance: 2.5,     // metres above terrain
  ceiling: 90,           // metres above the base pad
  radius: 0.45,
  fov: 105,
  mouseSensitivity: 0.0022,
  pitchMin: -85,         // degrees
  pitchMax: 25,
  maxHp: 100,
  regenDelay: 4,         // seconds without damage before regen
  regenRate: 8,          // hp per second
  respawnTime: 4,
};

// Slow-firing gun with small high-explosive rounds (left mouse button).
export const WEAPON = {
  fireRate: 4,           // rounds per second
  damage: 130,           // direct hit
  headshotMultiplier: 2,
  splashRadius: 3.5,     // metres
  splashDamage: 100,     // at the centre; falloff 1 - (d / radius)^1.5
  knockback: 9,          // launch speed (m/s) for soldiers killed by a blast
  projectileSpeed: 420,  // m/s; the round explodes when the tracer arrives
  spreadDeg: 0.35,
  range: 320,
};

// Missiles (right mouse button): slower to fire, much bigger blast.
export const MISSILE = {
  cooldown: 0.9,         // seconds between launches
  startSpeed: 70,        // m/s at launch
  maxSpeed: 190,
  accel: 160,            // m/s²
  maxLife: 4,            // seconds before self-destruct
  damage: 300,           // direct hit
  headshotMultiplier: 1,
  splashRadius: 9,
  splashDamage: 240,
  knockback: 15,
};

export const ENEMY_TYPES = {
  rifleman: { hp: 60, speed: 3.2, breach: 8, score: 100, clip: 'Run', clipSpeed: 4.6, uniform: 0x4b5a32, gear: 0x24261d, scale: 1.0 },
  runner:   { hp: 40, speed: 6.0, breach: 6, score: 150, clip: 'Run', clipSpeed: 4.6, uniform: 0x8a7b58, gear: 0x3d3527, scale: 0.95 },
  heavy:    { hp: 150, speed: 2.2, breach: 15, score: 300, clip: 'Walk', clipSpeed: 1.7, uniform: 0x2f3437, gear: 0x121416, scale: 1.15 },
  gunner:   { hp: 80, speed: 3.0, breach: 10, score: 250, clip: 'Run', clipSpeed: 4.6, uniform: 0x4b5a32, gear: 0x24261d, scale: 1.0, armband: 0xb3201c },
};

export const GUNNER = {
  engageRange: 70,
  burstRounds: 3,
  burstInterval: 0.11,
  cooldownMin: 1.4,
  cooldownMax: 2.6,
  maxEngageTime: 6,       // seconds before resuming the advance
  reengageDelay: 3,
  accuracy: (wave) => Math.min(0.55, 0.24 + 0.025 * (wave - 4)),
  damage: (wave) => Math.min(14, 6 + 0.5 * (wave - 4)),
};

export const WAVES = {
  count: (n) => 8 + 5 * (n - 1),
  maxAlive: 60,
  spawnInterval: (n) => Math.max(0.35, 2.0 * Math.pow(0.9, n - 1)),
  activeSpawns: (n) => Math.min(6, 2 + Math.floor(n / 2)),
  hpMul: (n) => 1 + 0.07 * (n - 1),
  speedMul: (n) => Math.min(1.6, 1 + 0.04 * (n - 1)),
  mix: (n) => ({
    runner: n >= 2 ? Math.min(0.3, 0.1 + 0.03 * (n - 2)) : 0,
    heavy: n >= 3 ? Math.min(0.25, 0.08 + 0.025 * (n - 3)) : 0,
    gunner: n >= 4 ? Math.min(0.35, 0.1 + 0.03 * (n - 4)) : 0,
  }),
  firstDelay: 4,
  intermission: 6,
  repairOnClear: 10,     // integrity percent restored per cleared wave
  clearBonus: (n, integrity) => Math.round(500 * n * (integrity / 100)),
};

// Ammunition issued at the start of each wave (it replaces what is left). Sized to be enough
// to clear the wave with reasonable aim. Running out of both before the wave is cleared loses.
export const AMMO = {
  gun: (n) => Math.ceil(WAVES.count(n) * 4 * WAVES.hpMul(n)),
  missiles: (n) => 2 + Math.ceil(WAVES.count(n) / 6),
};

export const SCORING = {
  headshotBonus: 0.5,
};

// Graphics presets. pixelRatio caps the canvas resolution (× CSS pixels, never above the
// display's devicePixelRatio); renderScale is the 3D scene's share of that resolution.
// "auto" adapts renderScale between dynamic.min and dynamic.max to hold ~60 FPS.
export const QUALITY = {
  low: { pixelRatio: 1, renderScale: 0.6, msaa: 0, shadowSize: 1024, treeShadows: false, grass: 0.45 },
  medium: { pixelRatio: 1, renderScale: 0.85, msaa: 0, shadowSize: 2048, treeShadows: false, grass: 0.75 },
  high: { pixelRatio: 1.5, renderScale: 1, msaa: 4, shadowSize: 2048, treeShadows: true, grass: 1 },
  auto: { pixelRatio: 1, renderScale: 1, msaa: 0, shadowSize: 2048, treeShadows: false, grass: 0.75, dynamic: { min: 0.55, max: 1 } },
};

export const ASSETS = {
  soldier: 'assets/models/soldier.glb',
  music: 'assets/audio/music.mp3',
  // Sample banks: each key maps to one or more files in public/assets/audio/. An entry can be
  // { name, offset } to start playback partway into the file (seconds).
  sounds: {
    gun: ['gun_30mm', 'gun_autocannon_1', 'gun_autocannon_2'],
    explosion: ['expl_grenade_1', 'expl_grenade_2', 'expl_grenade_3'],
    enemyBurst: ['rifle_burst_1', 'rifle_burst_2', 'rifle_burst_3'],
    enemyShot: ['ak47_shot'],
    whiz: [{ name: 'bullet_ricochet', offset: 1.616 }],
    missileLaunch: ['missile_launch'],
    explosionBig: ['expl_big'],
    clank: ['metal_clank'],
    motor: ['quad_motor_loop'],
    static: ['static_loop'],
    siren: ['air_raid'],
  },
  hdri: 'assets/hdri/sky.hdr',
  models: ['rock_07', 'rock_09', 'dead_tree_trunk', 'wooden_military_crate', 'barrel_03',
    'concrete_road_barrier_02', 'old_tyre', 'sack_trench', 'sack_trench_small', 'debris_pile', 'tank_wreck', 'ak47'],
  textures: ['aerial_grass_rock', 'dirt_aerial_03', 'aerial_mud_1', 'gravel_road',
    'concrete_layers', 'damaged_plaster', 'rubble', 'rusty_corrugated_iron'],
};

const params = new URLSearchParams(location.search);
export const DEBUG = {
  startWave: Math.max(1, parseInt(params.get('wave') ?? '1', 10) || 1),
  god: params.has('god'),
  autostart: params.has('autostart'), // start without pointer lock (for automated screenshots)
  quality: params.get('quality'),      // force a graphics preset (low / medium / high / auto)
};
DEBUG.active = DEBUG.startWave > 1 || DEBUG.god;
