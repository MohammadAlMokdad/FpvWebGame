# FpvWebGame

**FPV Drone Defense** is a 3D browser game seen entirely through the video feed of an armed FPV combat drone. You defend a walled outpost against endless waves of infantry.

Infantry advance on a small walled outpost from several directions, and you shoot them from the air before they reach the walls. The waves never end and keep getting harder. When the outpost's integrity reaches 0%, the run is over and you start again from wave 1. Your high score is saved in the browser.

Built with [three.js](https://threejs.org) and [Vite](https://vite.dev). There is no backend; the build is a static site.

## Features

- First-person FPV drone flight with an analogue-video look: fisheye lens, chromatic fringing, grain, scanlines, tearing glitches, static on signal loss, and an OSD HUD with a compass, radar, altitude, speed, hull, ammo and score.
- Two weapons: a high-explosive gun with splash damage, and missiles with a large blast and knockback. Ammunition is issued fresh each wave.
- Four enemy types: riflemen, fast runners, armoured heavies, and gunners who shoot back at the drone.
- Endless waves that scale in size, spawn rate, number of approach roads, enemy health and enemy speed.
- Day or night missions. At night you fly with a choice of three night-vision cameras: colour thermal, green phosphor and white phosphor.
- 3D positional audio: 5.1 surround panning on multichannel outputs, HRTF on stereo and headphones.
- An adaptive graphics preset that scales render resolution to hold the frame rate, plus fixed Low, Medium and High presets.
- Procedural terrain, grass, outpost, ruined houses and trees (EZ-Tree), combined with CC0 photo-scanned props and textures.

## Controls

The game captures the mouse when you click **Deploy Drone**.

| Input | Action |
|---|---|
| Mouse | Look and aim (bullets go where the crosshair is) |
| Left click (hold) | Gun: 4 high-explosive rounds per second, small blast |
| Right click | Missile: large blast and knockback (one every 0.9 s) |
| W A S D / arrow keys | Fly forward, back, left, right |
| Space | Climb |
| Shift / Ctrl / C | Descend |
| Mouse wheel | Climb (scroll up) or descend (scroll down) |
| Esc | Pause: resume, change settings, or exit to the main menu |
| V | Cycle the night-vision camera (night missions only) |
| M | Mute all sound |
| `` ` `` (backtick) | Toggle the FPS / draw-call counter |

The main menu and the pause screen have settings for mouse sensitivity, music volume, effects volume and graphics quality:

- **Auto (default)** lowers the 3D render resolution when the frame rate drops below about 55 FPS, and raises it again when there is headroom.
- **Low / Medium / High** use a fixed render resolution, shadow quality, tree shadows and grass density.

If the game sits at exactly 30 FPS on a laptop, Chrome's Energy Saver is probably capping it, because it limits pages to 30 FPS on battery. Plug in, or turn Energy Saver off under Settings > Performance. The game shows this hint when it detects a 30 FPS cap.

## Gameplay

- **Weapons:** gun rounds fly along their tracer and explode on impact, doing direct-hit damage plus a 3.5 m splash. Missiles accelerate to 190 m/s, leave a smoke trail and explode on contact with a 9 m blast. Splash damage falls off with distance, so a round that lands a few metres away wounds a soldier rather than killing him. Soldiers killed by a blast are thrown through the air.
- **Ammunition:** every wave issues its own load of gun rounds and missiles, sized to clear that wave. The load is shown in the wave banner and on the right of the OSD, and it replaces whatever you had left. If both run out while soldiers remain, the outpost is lost ("OUT OF AMMUNITION").
- **Enemies:** riflemen appear from wave 1, fast runners from wave 2, armoured heavies from wave 3, and gunners with red armbands from wave 4. All of them carry AK-47s. Gunners stop and shoot at the drone when it is within about 70 m, and flying fast makes you much harder to hit.
- **Health bars:** a bar appears over a soldier only after his health changes, and fades out after 3 seconds.
- **Base integrity:** every soldier who gets through a gate removes 6 to 15% integrity, depending on his type. Clearing a wave repairs 10% and pays a bonus of 500 × wave × integrity.
- **Drone:** if the hull reaches 0, the feed cuts to static and the drone relaunches from the base pad after 4 seconds. The hull regenerates after a few seconds without taking fire.
- **Difficulty:** each wave has 5 more soldiers than the last, spawns them faster, uses more spawn roads, and makes the enemies tougher and faster. Every tunable is in [`src/config.js`](src/config.js).
- **Scoring:** points per kill depend on the enemy type, with +50% for headshots, plus the wave-clear bonuses.

The compass marks the direction home with `H`. The radar shows the outpost and every hostile, with gunners in orange.

### Day and night

Pick the time of day on the main menu. Night missions are flown through a night-vision camera. Choose the mode on the menu, or press **V** in flight to cycle through them:

- **Thermal** (`IR-COLOR`) colours the image by temperature: cold ground is blue, soldiers are hot red, and explosions are white-hot. The stars and moon are invisible against the cold sky.
- **Green NV** (`NV-GRN`) is a green-phosphor image intensifier in which soldiers glow.
- **White NV** (`NV-MONO`) is a black-and-white intensifier in which soldiers glow.

Soldiers are detected from a heat mask. It respects walls and terrain, so a soldier behind a wall stays hidden, but it shows through smoke. Dead bodies stop glowing. The two NV modes add an IR illuminator under the drone that lights the ground ahead.

### Audio

Every in-world sound is a 3D source that follows the camera as you turn: explosions, enemy fire, near misses and the breach siren. On a 5.1 (or larger) output, the game pans sounds across the five main speakers. On stereo or headphones, it uses HRTF for front, back and height cues. The main menu shows which mode is active.

### Debug URL flags

| Flag | Effect |
|---|---|
| `?wave=8` | Start at wave 8 |
| `?god` | The base cannot lose integrity |
| `?autostart` | Start immediately without capturing the mouse (for automated screenshots) |
| `?quality=low\|medium\|high\|auto` | Force a graphics preset |

High scores are not saved while `?wave` or `?god` is in use.

## Tech stack

- [three.js](https://threejs.org) for WebGL rendering, glTF and HDR loading, and the post-processing shader
- [EZ-Tree](https://github.com/dgreenheck/ez-tree) for procedural trees and bushes
- The Web Audio API for sample playback, 3D and 5.1 panning, and synthesised UI tones
- [Vite](https://vite.dev) for the dev server and build
- An asset pipeline built on [glTF Transform](https://gltf-transform.dev), [meshoptimizer](https://github.com/zeux/meshoptimizer) and [sharp](https://sharp.pixelplumbing.com). It is used only by `npm run assets`.

## Prerequisites

- [Node.js](https://nodejs.org) 20.19+ or 22.12+ (required by Vite 8), with npm
- A desktop browser with WebGL 2 and Pointer Lock, such as a recent Chrome, Edge or Firefox. You also need a mouse and keyboard.

## Getting started

```bash
git clone https://github.com/MohammadAlMokdad/FpvWebGame.git
cd FpvWebGame
npm install
npm run dev
```

Open the URL that Vite prints (by default http://localhost:5173). The dev server listens on all network interfaces (`server.host: true` in `vite.config.js`), so you can also open the game from another device on your LAN.

### npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server with hot reload |
| `npm run build` | Build a static site into `dist/`. Paths are relative (`base: './'`), so it can be hosted from any folder or static host. |
| `npm run preview` | Serve the production build from `dist/` locally |
| `npm run assets` | Re-download and re-optimise the third-party assets (see [Assets](#assets)) |

## Configuration

The game needs no environment variables or API keys. All gameplay, graphics and asset settings are in [`src/config.js`](src/config.js), and player settings and the high score are stored in `localStorage`.

## Assets

All runtime assets are committed in `public/assets/` (about 13 MB), so the game works straight after `npm install`. Third-party assets are CC0, except the AKM rifle model, which is CC-BY 3.0. Full attribution is in [CREDITS.md](CREDITS.md).

- **Soldier:** Quaternius "SWAT" (animated), recoloured per enemy type. The AK-47 is J-Toastie's "AKM", and two-bone arm IK places the soldier's hands on it.
- **Sky and lighting:** the Poly Haven "kloofendal_48d_partly_cloudy_puresky" HDRI. The sun light is aimed from the sun's position in the photo.
- **Textures and props:** ground, concrete, plaster, rubble and rusty-iron textures, and props (rocks, crates, barrels, barriers, tyres and a dead trunk), all from Poly Haven.
- **Sandbags, debris and the tank wreck:** Quaternius, via Poly Pizza.
- **Sound effects:** CC0 recordings from Freesound: 30 mm and autocannon shots, grenade explosions, rifle bursts, a bullet fly-by, a quadcopter motor, static and an air-raid siren.
- **Music:** `public/assets/audio/music.mp3`, supplied by the project owner.
- **Generated in code:** trees and bushes (EZ-Tree, MIT), grass, terrain, the base buildings, ruined houses and effects.

### Rebuilding the assets

`npm run assets` runs [`scripts/fetch-assets.mjs`](scripts/fetch-assets.mjs) and needs an internet connection. The script:

1. downloads the textures, HDRI and props from the Poly Haven API, the models from Poly Pizza, and the sound previews from Freesound, after checking each Poly Pizza and Freesound licence first;
2. caches the raw downloads in `.asset-cache/`, which is git-ignored;
3. simplifies and meshopt-compresses the meshes and converts the textures to WebP. The MP3 previews are used as downloaded;
4. writes the results to `public/assets/` and regenerates `CREDITS.md`.

The script does not touch the music file.

### Using a different soldier model

Replace `public/assets/models/soldier.glb` with any rigged humanoid glTF, for example a Mixamo character converted with Blender or FBX2glTF. Then update:

- the clip names in `ENEMY_TYPES` (`clip`) in `src/config.js`, and the clips used in [`src/enemies/enemyManager.js`](src/enemies/enemyManager.js) (`HitRecieve`, `Death`, `Idle_Gun_Pointing`);
- the bone names in [`src/enemies/soldier.js`](src/enemies/soldier.js) (`Head`, `Head_end`, `Neck`, `Hips`, `Chest`, `FootL`, `FootL_end`, `FootR`, `UpperArmL/R`, `LowerArmL/R`, `WristL/R`). three.js strips `.` from bone names, so `Wrist.R` becomes `WristR`.

## Project structure

```
index.html               page shell: HUD markup, menus, loading screen
vite.config.js           Vite config (relative base, LAN dev server, EZ-Tree source alias)
public/assets/           runtime assets: audio/, hdri/, models/, textures/
scripts/fetch-assets.mjs asset download and optimisation pipeline
src/
  main.js                boot, main loop, screen flow, feedback wiring
  config.js              every gameplay tunable and the debug flags
  core/                  game state and scoring, input, asset loading, events, settings, storage, noise
  world/                 terrain, spawn roads, outpost, props, trees, grass, night sky, colliders
  drone/                 flight model and weapons
  enemies/               soldier model and animation, enemy AI, wave director
  fx/                    FPV video / night-vision shader, explosions, particles, tracers, health bars
  ui/                    OSD HUD, menu / pause / game-over screens, styles
  audio/                 Web Audio engine (samples, 3D / 5.1 panning, synth tones)
CREDITS.md               third-party asset attribution
```

## Credits

See [CREDITS.md](CREDITS.md) for every third-party asset, its author, its source and its licence.
