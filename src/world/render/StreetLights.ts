import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldState } from '../WorldState';
import { hashId, mulberry32, pointInPolygon } from '../geo';
import { SIDEWALK_WIDTH, hasSidewalk } from './roadGeometry';

/**
 * Postes de iluminação: InstancedMesh para poste, luminária (emissiva) e
 * "poça de luz" no chão (decal aditivo). Nenhuma luz real => barato.
 */
export class StreetLights {
  readonly group = new THREE.Group();
  private headMat: THREE.MeshStandardMaterial;
  private poolMat: THREE.MeshBasicMaterial;
  readonly count: number;

  constructor(world: WorldState) {
    const hf = world.height;
    const spots: { x: number; z: number; y: number; ang: number }[] = [];
    for (const s of world.data.streets) {
      if (!hasSidewalk(s)) continue;
      const rng = mulberry32(hashId(s.osmId) ^ 0x1a2b);
      const spacing = s.width >= 8 ? 30 : 38;
      let along = rng() * spacing;
      let side = rng() < 0.5 ? 1 : -1;
      for (let i = 0; i < s.points.length - 1; i++) {
        const [ax, az] = s.points[i];
        const [bx, bz] = s.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        while (along < len) {
          const off = s.width / 2 + SIDEWALK_WIDTH * 0.6;
          const x = ax + ux * along - uz * off * side;
          const z = az + uz * along + ux * off * side;
          if (world.isInsideBounds(x, z, 50) && !world.buildingsNear(x, z, 1).some((b) => pointInPolygon(x, z, b.outer))) {
            // braço aponta para a rua
            spots.push({ x, z, y: hf.sample(x, z), ang: Math.atan2(ux * side, uz * side) });
          }
          along += spacing;
          side = -side;
        }
        along -= len;
      }
    }
    this.count = spots.length;

    const pole = new THREE.CylinderGeometry(0.08, 0.11, 6.2, 5).translate(0, 3.1, 0);
    const arm = new THREE.BoxGeometry(1.4, 0.08, 0.08).translate(0.65, 6.1, 0);
    const poleGeo = mergeGeometries([pole.toNonIndexed(), arm.toNonIndexed()])!;
    const headGeo = new THREE.BoxGeometry(0.55, 0.16, 0.3).translate(1.3, 6.0, 0);
    const poolGeo = new THREE.CircleGeometry(5.5, 16).rotateX(-Math.PI / 2).translate(1.3, 0.25, 0);

    const poleMat = new THREE.MeshStandardMaterial({ color: '#5a5f66', roughness: 0.6, metalness: 0.3 });
    this.headMat = new THREE.MeshStandardMaterial({ color: '#dddddd', emissive: '#ffd59a', emissiveIntensity: 0 });
    this.poolMat = new THREE.MeshBasicMaterial({
      map: radialTexture(),
      color: '#ffcf8a',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length);
    const heads = new THREE.InstancedMesh(headGeo, this.headMat, spots.length);
    const pools = new THREE.InstancedMesh(poolGeo, this.poolMat, spots.length);
    poles.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    spots.forEach((s, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.ang);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, one);
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      pools.setMatrixAt(i, m);
    });
    for (const im of [poles, heads, pools]) {
      im.computeBoundingSphere();
      im.instanceMatrix.needsUpdate = true;
    }
    pools.renderOrder = 2;
    pools.visible = false;
    this.group.add(poles, heads, pools);
    this.pools = pools;
  }

  private pools: THREE.InstancedMesh;

  /** night: 0 (dia) .. 1 (noite) */
  setNight(night: number) {
    const on = THREE.MathUtils.smoothstep(night, 0.25, 0.6);
    this.headMat.emissiveIntensity = on * 2.2;
    this.poolMat.opacity = on * 0.55;
    this.pools.visible = on > 0.01;
  }
}

function radialTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
