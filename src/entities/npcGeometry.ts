import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worldUniforms } from '../world/render/materials';

/**
 * Modelos procedurais "game-ready" (poucos triângulos, silhueta realista)
 * para instanciar centenas de NPCs. Frente = +z, chão = y 0.
 */

export function paint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng.attributes.uv) ng.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const n = ng.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!ng.attributes.normal) ng.computeVertexNormals();
  return ng;
}

export const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** Extruda um perfil lateral (z, y) na largura, centralizado em x. */
function sideExtrude(profile: [number, number][], width: number, bevel = 0.06): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // perfil no plano xy -> comprimento em z, largura em x
  g.rotateY(-Math.PI / 2);
  g.translate(width / 2 - bevel, 0, 0);
  return g;
}

function wheel(r: number, w: number, x: number, z: number): THREE.BufferGeometry[] {
  const side = Math.sign(x);
  const tire = new THREE.CylinderGeometry(r, r, w, 10).rotateZ(Math.PI / 2).translate(x, r, z);
  const rim = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.03, 8, 1).rotateZ(Math.PI / 2).translate(x + side * (w / 2 + 0.005), r, z);
  return [paint(tire, '#1b1b1d'), paint(rim, '#b9bcc0')];
}

export interface VehicleModel {
  name: string;
  /** carroceria pintada (cor por instância) */
  paint: THREE.BufferGeometry;
  /** vidros (material brilhante) */
  glass: THREE.BufferGeometry;
  /** pneus, aros, faróis, grade, para-choques (vertex colors) */
  trim: THREE.BufferGeometry;
  /** brilho de faróis/lanternas (aditivo, à noite) */
  glow: THREE.BufferGeometry;
  length: number;
  width: number;
  /** probabilidade relativa na frota */
  weight: number;
  bus?: boolean;
}

interface CarSpec {
  name: string;
  L: number;
  W: number;
  H: number;
  belt: number;
  hood: number;
  trunk: number;
  wheelR: number;
  weight: number;
  pickup?: boolean;
}

function car(s: CarSpec): VehicleModel {
  const { L, W, H, belt, wheelR } = s;
  const r = L / 2;
  const clear = 0.32;
  // corpo inferior até a linha de cintura
  const body: [number, number][] = [
    [-r + 0.05, clear],
    [-r - 0.02, belt - 0.25],
    [-r + 0.12, belt],
    [r - s.hood, belt + 0.02],
    [r - 0.15, belt - 0.12],
    [r + 0.02, belt - 0.38],
    [r - 0.03, clear],
  ];
  const rearGlassZ = -r + s.trunk;
  const frontGlassZ = r - s.hood;
  const roofR = rearGlassZ + (s.pickup ? 0.15 : 0.45);
  const roofF = frontGlassZ - 0.65;
  const cabin: [number, number][] = s.pickup
    ? [
        [rearGlassZ, belt],
        [roofR - 0.05, H - 0.02],
        [roofF, H],
        [frontGlassZ, belt],
      ]
    : [
        [rearGlassZ, belt],
        [roofR, H - 0.02],
        [roofF, H],
        [frontGlassZ, belt],
      ];
  const paintParts = [sideExtrude(body, W, 0.07), sideExtrude([[roofR + 0.02, H - 0.06], [roofF - 0.02, H - 0.04], [roofF - 0.04, H + 0.03], [roofR + 0.04, H + 0.02]], W - 0.14, 0.03)];
  // colunas (A e C) para não parecer uma bolha de vidro
  paintParts.push(box(W - 0.12, 0.06, 0.08, 0, H - 0.08, roofR + 0.05), box(W - 0.12, 0.06, 0.08, 0, H - 0.06, roofF - 0.05));
  if (s.pickup) {
    // caçamba aberta: laterais
    const bedL = rearGlassZ - (-r + 0.1);
    paintParts.push(box(0.08, 0.35, bedL, W / 2 - 0.08, belt + 0.12, -r + 0.1 + bedL / 2), box(0.08, 0.35, bedL, -W / 2 + 0.08, belt + 0.12, -r + 0.1 + bedL / 2));
  }
  const glass = sideExtrude(cabin, W - 0.16, 0.04);
  const wb = L * 0.31;
  const trim = [
    ...wheel(wheelR, 0.24, W / 2 - 0.14, wb),
    ...wheel(wheelR, 0.24, -W / 2 + 0.14, wb),
    ...wheel(wheelR, 0.24, W / 2 - 0.14, -wb),
    ...wheel(wheelR, 0.24, -W / 2 + 0.14, -wb),
    paint(box(W * 0.94, 0.16, 0.12, 0, clear + 0.06, r + 0.02), '#2a2c30'), // para-choque dianteiro
    paint(box(W * 0.94, 0.16, 0.12, 0, clear + 0.06, -r - 0.02), '#2a2c30'),
    paint(box(W * 0.5, 0.12, 0.04, 0, belt - 0.32, r + 0.02), '#1d1f22'), // grade
    paint(box(0.32, 0.11, 0.05, W / 2 - 0.3, belt - 0.2, r - 0.02), '#f4f1e6'), // faróis
    paint(box(0.32, 0.11, 0.05, -W / 2 + 0.3, belt - 0.2, r - 0.02), '#f4f1e6'),
    paint(box(0.3, 0.12, 0.05, W / 2 - 0.25, belt - 0.12, -r + 0.01), '#a3201c'), // lanternas
    paint(box(0.3, 0.12, 0.05, -W / 2 + 0.25, belt - 0.12, -r + 0.01), '#a3201c'),
    paint(box(0.04, 0.08, 0.22, W / 2 + 0.06, belt + 0.05, frontGlassZ - 0.15), '#1d1f22'), // retrovisores
    paint(box(0.04, 0.08, 0.22, -W / 2 - 0.06, belt + 0.05, frontGlassZ - 0.15), '#1d1f22'),
  ];
  return {
    name: s.name,
    paint: mergeGeometries(paintParts.map((g) => paint(g, '#ffffff')))!,
    glass: paint(glass, '#ffffff'),
    trim: mergeGeometries(trim)!,
    glow: lightsGlow(L, W, belt - 0.2),
    length: L,
    width: W,
    weight: s.weight,
  };
}

function bus(): VehicleModel {
  const L = 11;
  const W = 2.5;
  const H = 3.1;
  const body = sideExtrude(
    [
      [-L / 2, 0.45],
      [-L / 2, H - 0.15],
      [-L / 2 + 0.2, H],
      [L / 2 - 0.3, H],
      [L / 2, H - 0.25],
      [L / 2 + 0.05, 0.45],
    ],
    W,
    0.08,
  );
  // faixa de janelas (vidro) dos dois lados + para-brisa
  const glass = mergeGeometries([
    paint(box(W + 0.02, 1.0, L - 2.2, 0, 2.15, -0.5), '#ffffff'),
    paint(box(W - 0.2, 1.4, 0.05, 0, 2.0, L / 2 + 0.06), '#ffffff'),
  ])!;
  const wb = L * 0.3;
  const trim = [
    ...wheel(0.5, 0.3, W / 2 - 0.2, wb),
    ...wheel(0.5, 0.3, -W / 2 + 0.2, wb),
    ...wheel(0.5, 0.3, W / 2 - 0.2, -wb),
    ...wheel(0.5, 0.3, -W / 2 + 0.2, -wb),
    paint(box(W, 0.3, 0.12, 0, 0.6, L / 2 + 0.07), '#2a2c30'),
    paint(box(1.6, 0.35, 0.05, 0, H - 0.3, L / 2 + 0.03), '#141414'), // letreiro
    paint(box(0.35, 0.15, 0.05, W / 2 - 0.3, 0.95, L / 2 + 0.07), '#f4f1e6'),
    paint(box(0.35, 0.15, 0.05, -W / 2 + 0.3, 0.95, L / 2 + 0.07), '#f4f1e6'),
    paint(box(0.3, 0.2, 0.05, W / 2 - 0.25, 1.0, -L / 2 - 0.02), '#a3201c'),
    paint(box(0.3, 0.2, 0.05, -W / 2 + 0.25, 1.0, -L / 2 - 0.02), '#a3201c'),
  ];
  return {
    name: 'ônibus',
    paint: paint(body, '#ffffff'),
    glass,
    trim: mergeGeometries(trim)!,
    glow: lightsGlow(L + 0.1, W, 0.95),
    length: L,
    width: W,
    weight: 0.04,
    bus: true,
  };
}

function truck(): VehicleModel {
  const W = 2.3;
  const cab = sideExtrude(
    [
      [1.7, 0.6],
      [1.7, 2.5],
      [3.2, 2.5],
      [3.5, 2.2],
      [3.55, 0.6],
    ],
    W,
    0.07,
  );
  const cargo = box(W + 0.05, 2.5, 4.6, 0, 1.95, -0.75);
  const glass = mergeGeometries([paint(box(W - 0.25, 0.8, 0.05, 0, 1.85, 3.52), '#ffffff'), paint(box(W + 0.02, 0.6, 0.8, 0, 1.95, 2.85), '#ffffff')])!;
  const trim = [
    ...wheel(0.48, 0.3, W / 2 - 0.2, 2.6),
    ...wheel(0.48, 0.3, -W / 2 + 0.2, 2.6),
    ...wheel(0.48, 0.3, W / 2 - 0.2, -1.8),
    ...wheel(0.48, 0.3, -W / 2 + 0.2, -1.8),
    paint(box(W, 0.25, 0.15, 0, 0.55, 3.6), '#2a2c30'),
    paint(box(W * 0.9, 0.25, 4.8, 0, 0.62, -0.6), '#2a2c30'), // chassi
    paint(box(0.3, 0.15, 0.05, W / 2 - 0.3, 0.95, 3.58), '#f4f1e6'),
    paint(box(0.3, 0.15, 0.05, -W / 2 + 0.3, 0.95, 3.58), '#f4f1e6'),
  ];
  return {
    name: 'caminhão',
    paint: mergeGeometries([paint(cab, '#ffffff'), paint(cargo, '#f2f2f2')])!,
    glass,
    trim: mergeGeometries(trim)!,
    glow: lightsGlow(7.2, W, 0.95, 0.4),
    length: 7.2,
    width: W,
    weight: 0.05,
  };
}

/** faróis/lanternas + facho no chão (material aditivo) */
function lightsGlow(length: number, width: number, y: number, zOffset = 0): THREE.BufferGeometry {
  const fz = length / 2 + 0.03 + zOffset;
  const rz = -length / 2 - 0.03 + zOffset;
  const fx = width / 2 - 0.3;
  return mergeGeometries([
    paint(box(0.4, 0.16, 0.05, fx, y, fz), '#fff2c8'),
    paint(box(0.4, 0.16, 0.05, -fx, y, fz), '#fff2c8'),
    paint(box(0.36, 0.14, 0.05, fx, y + 0.08, rz), '#ff2a1a'),
    paint(box(0.36, 0.14, 0.05, -fx, y + 0.08, rz), '#ff2a1a'),
    paint(box(1.7, 0.02, 6, 0, 0.08, fz + 3.1), '#4a3e22'),
  ])!;
}

/** Frota: hatch, sedã, SUV, picape, ônibus, caminhão. */
export function vehicleModels(): VehicleModel[] {
  return [
    car({ name: 'hatch', L: 3.9, W: 1.72, H: 1.48, belt: 0.98, hood: 0.95, trunk: 0.35, wheelR: 0.31, weight: 0.38 }),
    car({ name: 'sedã', L: 4.45, W: 1.76, H: 1.46, belt: 0.98, hood: 1.05, trunk: 0.95, wheelR: 0.32, weight: 0.24 }),
    car({ name: 'SUV', L: 4.4, W: 1.84, H: 1.68, belt: 1.12, hood: 1.0, trunk: 0.35, wheelR: 0.36, weight: 0.17 }),
    car({ name: 'picape', L: 5.0, W: 1.85, H: 1.75, belt: 1.12, hood: 1.15, trunk: 1.75, wheelR: 0.37, weight: 0.12, pickup: true }),
    bus(),
    truck(),
  ];
}

// ------------------------------------------------------------------ pedestre

/**
 * Pedestre com partes nomeadas no atributo `part`:
 *  0 pele, 1 camisa, 2 calça, 3 sapato/cabelo (escuro)
 * e `limb` para animação na GPU: 0 rígido, 1/2 pernas, 3/4 braços.
 */
export function pedestrianGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, part: number, limb: number) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng.attributes.uv) ng.deleteAttribute('uv');
    const n = ng.attributes.position.count;
    ng.setAttribute('part', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
    ng.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n).fill(limb), 1));
    parts.push(ng);
  };
  // pernas (calça) + sapatos
  for (const [s, limb] of [
    [-1, 1],
    [1, 2],
  ] as const) {
    add(new THREE.CylinderGeometry(0.075, 0.06, 0.82, 6).translate(0.1 * s, 0.5, 0), 2, limb);
    add(box(0.11, 0.08, 0.24, 0.1 * s, 0.05, 0.04), 3, limb);
  }
  // quadril + tronco (camisa) com ombros
  add(box(0.32, 0.18, 0.2, 0, 0.98, 0), 2, 0);
  add(new THREE.CylinderGeometry(0.2, 0.16, 0.55, 8).scale(1, 1, 0.62).translate(0, 1.33, 0), 1, 0);
  // braços: manga + antebraço (pele)
  for (const [s, limb] of [
    [-1, 3],
    [1, 4],
  ] as const) {
    add(new THREE.CylinderGeometry(0.055, 0.05, 0.3, 6).translate(0.25 * s, 1.43, 0), 1, limb);
    add(new THREE.CylinderGeometry(0.045, 0.04, 0.32, 6).translate(0.25 * s, 1.13, 0.01), 0, limb);
  }
  // pescoço, cabeça, cabelo
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 6).translate(0, 1.64, 0), 0, 0);
  add(new THREE.SphereGeometry(0.11, 8, 5).scale(0.9, 1.08, 1).translate(0, 1.78, 0), 0, 0);
  add(new THREE.SphereGeometry(0.115, 8, 3, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.92, 1.05, 1.02).translate(0, 1.8, -0.01), 3, 0);
  return mergeGeometries(parts)!;
}

/**
 * Balanço de membros na GPU: pernas giram no quadril, braços no ombro.
 * `rider` = pose de piloto por instância (`aPose`: x/y = ângulo base de
 * pernas/braços, negativo = à frente; w/z = quanto pernas/braços balançam).
 */
function limbShader(rider: boolean) {
  const decl = `attribute float part;
attribute float limb;
attribute vec3 aWalk;
${rider ? 'attribute vec4 aPose;' : ''}
uniform float uTime;
float pedLimbAngle() {
  float sw = sin(uTime * aWalk.y + aWalk.x) * aWalk.z;
${
  rider
    ? `  if (limb < 2.5) return aPose.x + (limb < 1.5 ? sw : -sw) * 0.5 * aPose.w;
  return aPose.y + (limb < 3.5 ? -sw : sw) * 0.45 * aPose.z;`
    : '  return limb < 1.5 ? sw * 0.5 : limb < 2.5 ? -sw * 0.5 : limb < 3.5 ? -sw * 0.45 : sw * 0.45;'
}
}
vec3 pedRotX(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}`;
  const move = `if (limb > 0.5) {
  float pivot = limb < 2.5 ? 0.93 : 1.56;
  vec3 p = transformed - vec3(0.0, pivot, 0.0);
${
  rider
    ? `  if (limb < 2.5) {
    // montado: pernas (sem joelho) mais curtas e abertas quando esticadas à frente (tanque da moto)
    p.y *= 1.0 - 0.2 * step(0.1, -aPose.x);
    p.x += sign(p.x) * max(0.0, -p.y) * clamp(-aPose.x - 0.6, 0.0, 1.0) * 0.25;
  }
`
    : ''
}  transformed = pedRotX(p, pedLimbAngle()) + vec3(0.0, pivot, 0.0);
}`;
  return { decl, move };
}

/** Material do pedestre: cores por parte (pele/camisa/calça) e balanço de membros na GPU. */
export function createPedestrianMaterial(rider = false): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  const { decl, move } = limbShader(rider);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = worldUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 aSkin;\nattribute vec3 aShirt;\nattribute vec3 aPants;\n${decl}`)
      .replace(
        '#include <beginnormal_vertex>',
        rider ? '#include <beginnormal_vertex>\nif (limb > 0.5) objectNormal = pedRotX(objectNormal, pedLimbAngle());' : '#include <beginnormal_vertex>',
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${move}`)
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
vColor.rgb = part < 0.5 ? aSkin : part < 1.5 ? aShirt : part < 2.5 ? aPants : vec3(0.05, 0.045, 0.04);`,
      );
  };
  m.customProgramCacheKey = () => (rider ? 'pedestrian-rider-v1' : 'pedestrian-v1');
  return m;
}

/** Profundidade (sombra) com a mesma pose — senão a sombra do piloto sai de pé. */
export function createPedestrianDepthMaterial(rider = false): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const { decl, move } = limbShader(rider);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = worldUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${decl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${move}`);
  };
  m.customProgramCacheKey = () => (rider ? 'pedestrian-depth-rider-v1' : 'pedestrian-depth-v1');
  return m;
}
