import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldState } from '../WorldState';
import { hashId, mulberry32, pointInPolygon } from '../geo';
import { SIDEWALK_WIDTH, hasSidewalk } from './roadGeometry';

function colored(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng.attributes.uv) ng.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const n = ng.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return ng;
}

const POLE_H = 9;
const ARM_Y = 8.6;

/**
 * Poste brasileiro típico: concreto afunilado, cruzeta com isoladores,
 * braço curvo com luminária "cabeça de cobra" e fiação aérea entre postes.
 * Tudo instanciado; luz noturna é emissiva + decal aditivo (sem luz real).
 */
function poleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // poste de concreto (seção quase quadrada, afunilado)
  parts.push(colored(new THREE.CylinderGeometry(0.1, 0.17, POLE_H, 5, 1, true).translate(0, POLE_H / 2 - 0.3, 0), '#a9a59c'));
  // cruzeta + isoladores (perpendicular à rua: eixo z local)
  parts.push(colored(new THREE.BoxGeometry(0.1, 0.1, 1.8).translate(0, ARM_Y, 0), '#6b5a46'));
  for (const z of [-0.75, 0, 0.75]) parts.push(colored(new THREE.BoxGeometry(0.07, 0.15, 0.07).translate(0, ARM_Y + 0.12, z), '#d8d6cf'));
  // transformador em alguns postes fica para depois; braço curvo da luminária (+x = rua)
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 7.2, 0), new THREE.Vector3(0.2, 8.2, 0), new THREE.Vector3(1.9, 8.0, 0));
  parts.push(colored(new THREE.TubeGeometry(curve, 5, 0.035, 3), '#7c8086'));
  return mergeGeometries(parts.map((g) => (g.attributes.normal ? g : (g.computeVertexNormals(), g))))!;
}

function headGeometry(): THREE.BufferGeometry {
  // luminária "cabeça de cobra": corpo achatado + lente embaixo
  const body = new THREE.SphereGeometry(0.32, 6, 3).scale(1.4, 0.38, 0.8).translate(2.05, 7.97, 0);
  return body;
}

export class StreetLights {
  readonly group = new THREE.Group();
  private headMat: THREE.MeshStandardMaterial;
  private poolMat: THREE.MeshBasicMaterial;
  private pools: THREE.InstancedMesh;
  readonly count: number;

  constructor(world: WorldState) {
    const hf = world.height;
    const spots: { x: number; z: number; y: number; ang: number }[] = [];
    const wires: number[] = [];
    for (const s of world.data.streets) {
      if (!hasSidewalk(s)) continue;
      const rng = mulberry32(hashId(s.osmId) ^ 0x1a2b);
      const spacing = 32 + rng() * 6;
      let along = rng() * spacing;
      // postes de um lado só (padrão das redes de distribuição)
      const side = rng() < 0.5 ? 1 : -1;
      let prev: { x: number; z: number; y: number; ang: number } | null = null;
      for (let i = 0; i < s.points.length - 1; i++) {
        const [ax, az] = s.points[i];
        const [bx, bz] = s.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        while (along < len) {
          const off = s.width / 2 + SIDEWALK_WIDTH * 0.75;
          const x = ax + ux * along - uz * off * side;
          const z = az + uz * along + ux * off * side;
          if (world.isInsideBounds(x, z, 50) && !world.buildingsNear(x, z, 1).some((b) => pointInPolygon(x, z, b.outer))) {
            // braço aponta para a rua
            const spot = { x, z, y: hf.sample(x, z) + 0.2, ang: Math.atan2(ux * side, uz * side) };
            spots.push(spot);
            if (prev && Math.hypot(prev.x - x, prev.z - z) < spacing * 1.6) this.wire(wires, prev, spot);
            prev = spot;
          } else prev = null;
          along += spacing;
        }
        along -= len;
      }
    }
    this.count = spots.length;

    const poleGeo = poleGeometry();
    const headGeo = headGeometry();
    const poolGeo = new THREE.CircleGeometry(6, 18).rotateX(-Math.PI / 2).translate(2.0, 0.28, 0);

    const poleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
    this.headMat = new THREE.MeshStandardMaterial({ color: '#c9ccd0', roughness: 0.4, metalness: 0.5, emissive: '#ffc779', emissiveIntensity: 0 });
    this.poolMat = new THREE.MeshBasicMaterial({
      map: radialTexture(),
      color: '#ffc982',
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
    poles.receiveShadow = true;
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
    this.pools = pools;

    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    const wireLines = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: '#2b2b2b', transparent: true, opacity: 0.7 }));
    wireLines.name = 'fiação';
    this.group.add(poles, heads, pools, wireLines);
  }

  /** 3 fios com catenária (flecha de ~0,5 m) entre dois postes */
  private wire(out: number[], a: { x: number; z: number; y: number; ang: number }, b: { x: number; z: number; y: number; ang: number }) {
    const SEG = 6;
    for (const off of [-0.75, 0, 0.75]) {
      // cruzeta é perpendicular ao braço: eixo z local -> mundo
      const ax = a.x + Math.sin(a.ang) * off;
      const az = a.z + Math.cos(a.ang) * off;
      const bx = b.x + Math.sin(b.ang) * off;
      const bz = b.z + Math.cos(b.ang) * off;
      const ay = a.y + ARM_Y + 0.2;
      const by = b.y + ARM_Y + 0.2;
      let px = ax;
      let py = ay;
      let pz = az;
      for (let k = 1; k <= SEG; k++) {
        const t = k / SEG;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const y = ay + (by - ay) * t - Math.sin(Math.PI * t) * 0.5;
        out.push(px, py, pz, x, y, z);
        px = x;
        py = y;
        pz = z;
      }
    }
  }

  /** night: 0 (dia) .. 1 (noite) */
  setNight(night: number) {
    const on = THREE.MathUtils.smoothstep(night, 0.25, 0.6);
    this.headMat.emissiveIntensity = on * 3;
    this.poolMat.opacity = on * 0.6;
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
