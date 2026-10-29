// Downloads and optimizes every third-party asset used by the game into public/assets/.
// All sources are CC0. Run with `npm run assets`. Raw downloads are cached in .asset-cache/.
import { mkdir, writeFile, readFile, copyFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, resample, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.asset-cache');
const OUT = path.join(ROOT, 'public', 'assets');
const UA = 'FpvDroneDefense-asset-fetcher/1.0 (+local build script)';

// Poly Haven texture sets (diffuse + OpenGL normal map).
const PH_TEXTURES = [
  'aerial_grass_rock', 'dirt_aerial_03', 'aerial_mud_1', 'gravel_road',
  'concrete_layers', 'damaged_plaster', 'rubble', 'rusty_corrugated_iron',
];
// Sky-only HDRI: used as the visible sky and for image-based lighting.
const PH_HDRI = 'kloofendal_48d_partly_cloudy_puresky';
const PH_HDRI_RES = '2k';
// Poly Haven props; maxTris caps the simplified triangle count (they are instanced many times).
const PH_MODELS = {
  rock_07: { maxTris: 1200 },
  rock_09: { maxTris: 1200 },
  dead_tree_trunk: { maxTris: 1500 },
  wooden_military_crate: { maxTris: 2000 },
  barrel_03: { maxTris: 2000 },
  concrete_road_barrier_02: { maxTris: 1500 },
  old_tyre: { maxTris: 1500 },
};
// Poly Pizza models (output name → page id, triangle cap). Licence is verified from the page before
// download: CC0 unless ccBy is set, in which case CC-BY is accepted and credited in CREDITS.md.
const PP_MODELS = {
  ak47: { id: 'ZBBoDqAn0A', maxTris: 2200, ccBy: true }, // J-Toastie – AKM (CC-BY 3.0)
  soldier: { id: 'Btfn3G5Xv4' },
  sack_trench: { id: 'LW3jwpPfiN', maxTris: 1600 },
  sack_trench_small: { id: 'iHyRewQQcN', maxTris: 1000 },
  debris_pile: { id: 'WrIiMMxyEP', maxTris: 1000 },
  tank_wreck: { id: 'FA5daiyZQq', maxTris: 6000 },
};
// Freesound CC0 recordings (output name → [sound id, uploader user id]). The public
// "-hq" preview is downloaded; the licence is verified on the sound's page first.
const FS_SOUNDS = {
  gun_30mm: [162258, 71257],          // qubodup – Mk 46 30mm gun, single shot
  gun_autocannon_1: [854183, 71257],  // qubodup – Autocannon Shot 1
  gun_autocannon_2: [854184, 71257],  // qubodup – Autocannon Shot 2
  expl_grenade_1: [67470, 71257],     // qubodup – M67 grenade explosion
  expl_grenade_2: [67472, 71257],
  expl_grenade_3: [67474, 71257],
  rifle_burst_1: [854503, 71257],     // qubodup – Automatic Rifle Burst
  rifle_burst_2: [854504, 71257],
  rifle_burst_3: [854505, 71257],
  ak47_shot: [163457, 2263027],       // LeMudCrab – AK47 Shot
  bullet_ricochet: [30932, 15696],    // aust_paul – bullet ricochet (played from 1.616 s)
  missile_launch: [151858, 2754532],  // NHMWretched – Missile firing
  expl_big: [587193, 13123807],       // derplayer – explosion_big_02
  metal_clank: [151624, 71257],       // qubodup – Clank
  quad_motor_loop: [383852, 2278166], // simeonradivoev – Mini Quadcopter Flying Loop
  static_loop: [395804, 5048136],     // dotY21 – hard static loop
  air_raid: [45933, 279089],          // torn.rugged.audio.35 – air raid siren
};
const SOLDIER_CLIPS = ['Walk', 'Run', 'Run_Shoot', 'Idle_Gun_Pointing', 'Idle_Gun_Shoot', 'Gun_Shoot', 'HitRecieve', 'Death'];

const failures = [];
const credits = [];

async function fetchBuffer(url, { browserUA = false } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': browserUA ? 'Mozilla/5.0' : UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function cached(file, url, opts) {
  const p = path.join(CACHE, file);
  if (existsSync(p)) return readFile(p);
  await mkdir(path.dirname(p), { recursive: true });
  const buf = await fetchBuffer(url, opts);
  await writeFile(p, buf);
  return buf;
}

async function phFiles(id) {
  const res = await fetch(`https://api.polyhaven.com/files/${id}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Poly Haven API ${res.status} for ${id}`);
  return res.json();
}

async function step(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.error(`  FAIL ${label}: ${err.message}`);
  }
}

async function makeIO() {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
}

function triangleCount(doc) {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += idx ? idx.getCount() / 3 : prim.getAttribute('POSITION').getCount() / 3;
    }
  }
  return tris;
}

async function textures() {
  console.log('Textures (Poly Haven)');
  const dir = path.join(OUT, 'textures');
  await mkdir(dir, { recursive: true });
  for (const id of PH_TEXTURES) {
    await step(id, async () => {
      const files = await phFiles(id);
      const maps = { diff: files.Diffuse['1k'].jpg.url, nor: files.nor_gl['1k'].jpg.url };
      for (const [kind, url] of Object.entries(maps)) {
        const raw = await cached(`ph/${id}_${kind}.jpg`, url);
        await sharp(raw).resize(1024, 1024, { fit: 'inside' })
          .webp({ quality: kind === 'nor' ? 90 : 82 })
          .toFile(path.join(dir, `${id}_${kind}.webp`));
      }
      credits.push({ name: id, kind: 'Texture', author: 'Poly Haven', url: `https://polyhaven.com/a/${id}`, license: 'CC0' });
    });
  }
}

async function hdri() {
  console.log('HDRI (Poly Haven)');
  const dir = path.join(OUT, 'hdri');
  await mkdir(dir, { recursive: true });
  await step(PH_HDRI, async () => {
    const files = await phFiles(PH_HDRI);
    const raw = await cached(`ph/${PH_HDRI}_${PH_HDRI_RES}.hdr`, files.hdri[PH_HDRI_RES].hdr.url);
    await writeFile(path.join(dir, 'sky.hdr'), raw);
    credits.push({ name: PH_HDRI, kind: 'HDRI', author: 'Poly Haven', url: `https://polyhaven.com/a/${PH_HDRI}`, license: 'CC0' });
  });
}

async function optimizeStatic(io, doc, maxTris) {
  await doc.transform(dedup(), prune(), weld());
  const tris = triangleCount(doc);
  if (tris > maxTris) {
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: maxTris / tris, error: 0.01, lockBorder: false }));
  }
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 82 }),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  return triangleCount(doc);
}

async function polyHavenModels(io) {
  console.log('Models (Poly Haven)');
  const dir = path.join(OUT, 'models');
  await mkdir(dir, { recursive: true });
  for (const [id, { maxTris }] of Object.entries(PH_MODELS)) {
    await step(id, async () => {
      const files = await phFiles(id);
      const gltf = files.gltf['1k'].gltf;
      const local = path.join(CACHE, 'ph-models', id);
      await cached(`ph-models/${id}/${id}.gltf`, gltf.url);
      for (const [rel, info] of Object.entries(gltf.include)) {
        await cached(`ph-models/${id}/${rel}`, info.url);
      }
      const doc = await io.read(path.join(local, `${id}.gltf`));
      const tris = await optimizeStatic(io, doc, maxTris);
      await io.write(path.join(dir, `${id}.glb`), doc);
      credits.push({ name: id, kind: `Model (${Math.round(tris)} tris after simplify)`, author: 'Poly Haven', url: `https://polyhaven.com/a/${id}`, license: 'CC0' });
    });
  }
}

async function polyPizzaModels(io) {
  console.log('Models (Poly Pizza)');
  const dir = path.join(OUT, 'models');
  await mkdir(dir, { recursive: true });
  for (const [name, { id: pageId, maxTris, ccBy }] of Object.entries(PP_MODELS)) {
    await step(`${name} (${pageId})`, async () => {
      const page = (await fetchBuffer(`https://poly.pizza/m/${pageId}`, { browserUA: true })).toString('utf8');
      const glb = page.match(/static\.poly\.pizza\/([0-9a-f-]{36})\.glb/);
      const licence = page.match(/"Licence":"([^"]*)"/)?.[1] ?? 'unknown';
      const title = page.match(/"Title":"([^"]*)"/)?.[1] ?? name;
      const author = page.match(/"Creator":\{"Username":"([^"]*)"/)?.[1] ?? 'unknown';
      if (!glb) throw new Error('could not find GLB url on page');
      const allowed = licence.startsWith('CC0') || (ccBy && licence.startsWith('CC-BY'));
      if (!allowed) throw new Error(`licence is "${licence}", not allowed for this asset — skipped`);
      const raw = await cached(`pp/${name}.glb`, `https://static.poly.pizza/${glb[1]}.glb`, { browserUA: true });
      const doc = await io.readBinary(new Uint8Array(raw));
      if (name === 'soldier') {
        const keep = new Set(SOLDIER_CLIPS);
        for (const anim of doc.getRoot().listAnimations()) {
          const clip = anim.getName().split('|').pop();
          if (keep.has(clip)) anim.setName(clip); else anim.dispose();
        }
        await doc.transform(dedup(), prune({ keepLeaves: true }), resample(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
        console.log(`       clips kept: ${doc.getRoot().listAnimations().map((a) => a.getName()).join(', ')}`);
      } else {
        await optimizeStatic(io, doc, maxTris);
      }
      await io.write(path.join(dir, `${name}.glb`), doc);
      credits.push({ name: title, kind: 'Model', author, url: `https://poly.pizza/m/${pageId}`, license: licence });
    });
  }
}

async function sounds() {
  console.log('Sounds (Freesound)');
  const dir = path.join(OUT, 'audio');
  await mkdir(dir, { recursive: true });
  for (const [name, [id, user]] of Object.entries(FS_SOUNDS)) {
    await step(`${name} (#${id})`, async () => {
      const page = (await fetchBuffer(`https://freesound.org/s/${id}/`, { browserUA: true })).toString('utf8');
      if (!page.includes('creativecommons.org/publicdomain/zero/')) throw new Error('licence is not CC0 — skipped');
      // Page title reads "Freesound - <title> by <author>".
      const [, title = name, author = 'unknown'] = page.match(/<title>Freesound - (.*) by ([^<]*)<\/title>/) ?? [];
      const raw = await cached(`fs/${name}.mp3`, `https://cdn.freesound.org/previews/${Math.floor(id / 1000)}/${id}_${user}-hq.mp3`, { browserUA: true });
      await writeFile(path.join(dir, `${name}.mp3`), raw);
      credits.push({ name: title.replaceAll('|', '/'), kind: 'Sound', author, url: `https://freesound.org/s/${id}/`, license: 'CC0' });
    });
  }
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

async function writeCredits() {
  const lines = [
    '# Credits',
    '',
    'Third-party assets are CC0 (public domain) unless marked CC-BY below; CC-BY assets require this attribution.',
    '',
    '| Asset | Type | Author | Source | License |',
    '|---|---|---|---|---|',
    ...credits.map((c) => `| ${c.name} | ${c.kind} | ${c.author} | ${c.url} | ${c.license} |`),
    '',
    'Music: "MusicForFPV" supplied by the project owner (public/assets/audio/music.mp3).',
    '',
    'Procedural trees are generated with [EZ-Tree](https://github.com/dgreenheck/ez-tree) by Daniel Greenheck (MIT); its bark and leaf textures ship with the package.',
    '',
    'Asset downloads use the [Poly Haven API](https://polyhaven.com) and [Poly Pizza](https://poly.pizza).',
    '',
  ];
  await writeFile(path.join(ROOT, 'CREDITS.md'), lines.join('\n'));
}

const io = await makeIO();
await mkdir(CACHE, { recursive: true });
await textures();
await hdri();
await polyHavenModels(io);
await polyPizzaModels(io);
await sounds();
await writeCredits();

const mb = (await dirSize(OUT)) / 1024 / 1024;
console.log(`\npublic/assets total: ${mb.toFixed(1)} MB`);
if (failures.length) {
  console.error(`\n${failures.length} asset(s) failed:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
