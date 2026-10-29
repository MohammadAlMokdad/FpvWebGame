import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ASSETS } from '../config.js';

const base = import.meta.env.BASE_URL;

// Loads every asset in parallel; onProgress receives 0..1.
export async function loadAssets(renderer, onProgress) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url, loaded, total) => onProgress(loaded / total);

  const gltfLoader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const texLoader = new THREE.TextureLoader(manager);
  const hdrLoader = new HDRLoader(manager);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const loadTexture = async (name, kind) => {
    const tex = await texLoader.loadAsync(`${base}assets/textures/${name}_${kind}.webp`);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = maxAniso;
    tex.colorSpace = kind === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tex;
  };

  const texturePromises = ASSETS.textures.map(async (name) => {
    const [diff, nor] = await Promise.all([loadTexture(name, 'diff'), loadTexture(name, 'nor')]);
    return [name, { diff, nor }];
  });
  const modelPromises = ASSETS.models.map(async (name) => [name, await gltfLoader.loadAsync(`${base}assets/models/${name}.glb`)]);

  const [textures, models, soldier, hdri] = await Promise.all([
    Promise.all(texturePromises).then(Object.fromEntries),
    Promise.all(modelPromises).then(Object.fromEntries),
    gltfLoader.loadAsync(`${base}${ASSETS.soldier}`),
    hdrLoader.loadAsync(`${base}${ASSETS.hdri}`),
  ]);
  hdri.mapping = THREE.EquirectangularReflectionMapping;

  return { textures, models, soldier, hdri };
}

// Flattens a glTF scene into [{ geometry, material }] with node transforms baked in.
// Skinned meshes are frozen in their rest pose.
export function extractMeshes(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    let geometry = obj.geometry.clone();
    if (obj.isSkinnedMesh) {
      geometry = bakeSkinnedPose(obj);
    } else {
      geometry.applyMatrix4(obj.matrixWorld);
    }
    parts.push({ geometry, material: obj.material });
  });
  return parts;
}

function bakeSkinnedPose(mesh) {
  const src = mesh.geometry;
  const pos = src.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    mesh.applyBoneTransform(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    out.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (src.index) g.setIndex(Array.from(src.index.array));
  // Flat normals suit these low-poly models.
  const flat = g.index ? g.toNonIndexed() : g;
  flat.computeVertexNormals();
  return flat;
}
