import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleKind } from '../economy/catalog';
import { MONO, MONO_LIGHT } from '../world/render/style';
import { box, paint } from './npcGeometry';

/** Física arcade e encaixe do piloto de cada veículo (frente = +z, chão = y 0). */
export interface VehicleSpec {
  kind: VehicleKind;
  name: string;
  /** velocidade máxima (m/s), multiplicador com Shift e ré */
  maxSpeed: number;
  boost: number;
  reverse: number;
  /** aceleração e freio (m/s²) */
  accel: number;
  brake: number;
  /** desaceleração sem acelerar (rolamento/freio-motor, m/s²) e arrasto do ar (1/m) */
  coast: number;
  drag: number;
  /** quanto a ladeira pesa (0..1) */
  slope: number;
  wheelBase: number;
  /** esterço máximo parado / na velocidade máxima (rad) */
  steerLow: number;
  steerHigh: number;
  /** raio dos círculos de colisão (frente, meio, traseira) */
  radius: number;
  /** quadril do piloto e inclinação do tronco (rad) */
  seat: { y: number; z: number; lean: number };
  /** ângulo base de pernas/braços em relação ao tronco (rad, negativo = à frente) */
  pose: { legs: number; arms: number };
  pedals: boolean;
  camDistance: number;
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  bike: {
    kind: 'bike',
    name: 'Bicicleta',
    maxSpeed: 9,
    boost: 1.22,
    reverse: 1.4,
    accel: 2.6,
    brake: 6,
    coast: 0.35,
    drag: 0.004,
    slope: 0.7,
    wheelBase: 1.08,
    steerLow: 0.55,
    steerHigh: 0.12,
    radius: 0.4,
    seat: { y: 0.98, z: -0.24, lean: 0.5 },
    pose: { legs: -0.77, arms: -1.05 },
    pedals: true,
    camDistance: 6.5,
  },
  moto: {
    kind: 'moto',
    name: 'Moto',
    maxSpeed: 17,
    boost: 1.18,
    reverse: 1.2,
    accel: 5.5,
    brake: 8.5,
    coast: 1.1,
    drag: 0.0025,
    slope: 0.3,
    wheelBase: 1.34,
    steerLow: 0.5,
    steerHigh: 0.1,
    radius: 0.48,
    seat: { y: 0.92, z: -0.2, lean: 0.25 },
    pose: { legs: -1.09, arms: -1.0 },
    pedals: false,
    camDistance: 7.5,
  },
};

// ------------------------------------------------------------------ geometria

type V3 = [number, number, number];
const UP = new THREE.Vector3(0, 1, 0);

/** cilindro entre dois pontos */
function tube(a: V3, b: V3, r: number, hex: string, seg = 6): THREE.BufferGeometry {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const g = new THREE.CylinderGeometry(r, r, va.distanceTo(vb), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, vb.clone().sub(va).normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return paint(g, hex);
}

/** par simétrico em x */
const pair = (f: (s: number) => THREE.BufferGeometry) => [f(1), f(-1)];

/** roda centrada na origem, girando em torno de x */
function wheelGeometry(r: number, tire: number, spokes: number, cast: boolean): THREE.BufferGeometry {
  const parts = [
    paint(new THREE.TorusGeometry(r - tire, tire, 6, 22).rotateY(Math.PI / 2), '#1b1b1d'),
    paint(new THREE.CylinderGeometry(0.04, 0.04, cast ? 0.14 : 0.1, 8).rotateZ(Math.PI / 2), '#8a8d91'),
  ];
  if (cast) {
    // roda de liga: disco + raios grossos
    parts.push(paint(new THREE.CylinderGeometry(r - tire * 1.9, r - tire * 1.9, 0.03, 16).rotateZ(Math.PI / 2), '#2a2c30'));
    for (let i = 0; i < spokes; i++) parts.push(paint(box(0.05, r - tire, 0.045, 0, (r - tire) / 2, 0).rotateX((i / spokes) * Math.PI * 2), '#9a9ea3'));
  } else {
    parts.push(paint(new THREE.TorusGeometry(r - tire * 2.2, tire * 0.4, 4, 22).rotateY(Math.PI / 2), '#b9bcc0'));
    for (let i = 0; i < spokes; i++) parts.push(paint(new THREE.BoxGeometry(0.006, (r - tire * 2) * 2, 0.006).rotateX((i / spokes) * Math.PI), '#c9ccd0'));
  }
  return mergeGeometries(parts)!;
}

/** Peças de um veículo montado: rodas e guidão giram, pedal acompanha as pernas. */
export interface RideModel {
  root: THREE.Group;
  /** garfo + guidão + roda dianteira (esterço) */
  front: THREE.Group;
  wheels: THREE.Mesh[];
  wheelRadius: number;
  crank: THREE.Mesh | null;
  /** farol/lanterna (aditivo, à noite) */
  glow: THREE.Mesh[];
}

let solidMat: THREE.MeshStandardMaterial | null = null;
let glowMat: THREE.MeshBasicMaterial | null = null;
const materials = () => {
  solidMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.3 });
  // monocromático: faróis no mesmo amarelo das luzes
  glowMat ??= new THREE.MeshBasicMaterial({ vertexColors: !MONO, color: MONO ? MONO_LIGHT : '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  return { solid: solidMat, glow: glowMat };
};

function mesh(parts: THREE.BufferGeometry[], mat: THREE.Material, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(mergeGeometries(parts)!, mat);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

export function buildRideModel(kind: VehicleKind): RideModel {
  return kind === 'bike' ? bicycle() : motorcycle();
}

function bicycle(): RideModel {
  const { solid } = materials();
  const frameC = '#e9e3d3';
  const dark = '#232427';
  const r = 0.34;
  const rear: V3 = [0, r, -0.53];
  const bb: V3 = [0, 0.3, -0.05];
  const seatTop: V3 = [0, 0.8, -0.22];
  const headTop: V3 = [0, 0.86, 0.4];
  const headBot: V3 = [0, 0.7, 0.44];
  const frame = mesh(
    [
      tube(seatTop, headTop, 0.022, frameC),
      tube(bb, headBot, 0.026, frameC),
      tube(bb, seatTop, 0.022, frameC),
      tube(headBot, headTop, 0.03, frameC),
      ...pair((s) => tube([0.05 * s, bb[1], bb[2]], [0.05 * s, rear[1], rear[2]], 0.012, frameC)),
      ...pair((s) => tube([0.03 * s, seatTop[1], seatTop[2]], [0.05 * s, rear[1], rear[2]], 0.011, frameC)),
      tube(seatTop, [0, 0.94, -0.25], 0.014, '#9a9ea3'),
      paint(box(0.13, 0.05, 0.27, 0, 0.955, -0.26), dark),
      paint(box(0.1, 0.02, 0.06, 0, 0.6, -0.84), '#a3201c'), // refletor
    ],
    solid,
  );
  // dianteira: pivô no tubo de direção
  const pivotZ = 0.42;
  const front = new THREE.Group();
  front.position.z = pivotZ;
  const fz = (z: number) => z - pivotZ;
  const frontWheel = new THREE.Mesh(wheelGeometry(r, 0.028, 8, false), solid);
  frontWheel.position.set(0, r, fz(0.55));
  frontWheel.castShadow = true;
  front.add(
    mesh(
      [
        ...pair((s) => tube([0.045 * s, 0.7, fz(0.44)], [0.045 * s, r, fz(0.55)], 0.013, frameC)),
        tube([0, 0.86, fz(0.4)], [0, 0.97, fz(0.42)], 0.016, '#9a9ea3'),
        tube([-0.29, 0.97, fz(0.44)], [0.29, 0.97, fz(0.44)], 0.014, '#9a9ea3'),
        ...pair((s) => tube([0.21 * s, 0.97, fz(0.44)], [0.31 * s, 0.97, fz(0.44)], 0.02, dark)),
      ],
      solid,
    ),
    frontWheel,
  );
  const rearWheel = new THREE.Mesh(wheelGeometry(r, 0.028, 8, false), solid);
  rearWheel.position.set(...rear);
  rearWheel.castShadow = true;
  // pedivela: braços opostos + pedais + coroa
  const crank = mesh(
    [
      paint(box(0.02, 0.17, 0.022, 0.07, -0.085, 0), '#9a9ea3'),
      paint(box(0.02, 0.17, 0.022, -0.07, 0.085, 0), '#9a9ea3'),
      paint(box(0.09, 0.022, 0.06, 0.12, -0.17, 0), dark),
      paint(box(0.09, 0.022, 0.06, -0.12, 0.17, 0), dark),
      paint(new THREE.CylinderGeometry(0.1, 0.1, 0.01, 16).rotateZ(Math.PI / 2).translate(0.05, 0, 0), '#6b6f75'),
    ],
    solid,
  );
  crank.position.set(...bb);
  const root = new THREE.Group();
  root.add(frame, front, rearWheel, crank);
  return { root, front, wheels: [frontWheel, rearWheel], wheelRadius: r, crank, glow: [] };
}

function motorcycle(): RideModel {
  const { solid, glow } = materials();
  const body = '#c62828';
  const dark = '#1f2023';
  const metal = '#3a3d42';
  const chrome = '#c9ccd0';
  const r = 0.31;
  const rear: V3 = [0, r, -0.66];
  const tilt = (g: THREE.BufferGeometry, a: number, x: number, y: number, z: number) => g.rotateX(a).translate(x, y, z);
  const frame = mesh(
    [
      paint(tilt(new THREE.BoxGeometry(0.3, 0.2, 0.46), -0.12, 0, 0.88, 0.2), body), // tanque
      ...pair((s) => paint(box(0.004, 0.05, 0.3, 0.152 * s, 0.9, 0.2), '#f2f2f0')), // faixa do tanque
      paint(box(0.27, 0.09, 0.64, 0, 0.86, -0.27), dark), // banco
      paint(box(0.28, 0.16, 0.28, 0, 0.72, -0.2), body), // tampa lateral
      paint(tilt(new THREE.BoxGeometry(0.2, 0.09, 0.34), -0.15, 0, 0.86, -0.68), body), // rabeta
      paint(box(0.12, 0.06, 0.04, 0, 0.88, -0.86), '#a3201c'), // lanterna
      paint(box(0.12, 0.025, 0.34, 0, 0.64, -0.82), dark), // para-lama
      paint(box(0.19, 0.13, 0.01, 0, 0.6, -0.95), '#e8e8e8'), // placa
      paint(box(0.25, 0.28, 0.36, 0, 0.47, 0.06), metal), // motor
      paint(tilt(new THREE.BoxGeometry(0.2, 0.22, 0.16), 0.4, 0, 0.64, 0.22), '#6b6f75'), // cilindro
      ...[0.58, 0.64, 0.7].map((y) => paint(tilt(new THREE.BoxGeometry(0.24, 0.015, 0.2), 0.4, 0, y, 0.22 + (y - 0.64) * 0.4), '#6b6f75')),
      ...pair((s) => paint(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 12).rotateZ(Math.PI / 2).translate(0.13 * s, 0.43, 0.03), '#9a9ea3')),
      tube([0, 0.95, 0.47], [0, 0.33, 0.22], 0.03, dark), // quadro
      tube([0, 0.97, 0.45], [0, 0.78, -0.1], 0.03, dark),
      ...pair((s) => tube([0.1 * s, 0.8, -0.1], [0.1 * s, 0.84, -0.7], 0.018, dark)),
      ...pair((s) => tube([0.1 * s, 0.36, -0.02], [0.1 * s, r, rear[2]], 0.025, dark)), // balança
      ...pair((s) => tube([0.13 * s, 0.33, -0.6], [0.13 * s, 0.82, -0.42], 0.024, '#8a8d91')), // amortecedores
      tube([0.08, 0.35, 0.22], [0.15, 0.32, -0.15], 0.025, chrome), // escapamento
      tube([0.15, 0.34, -0.15], [0.17, 0.47, -0.78], 0.05, chrome, 8),
      ...pair((s) => paint(box(0.08, 0.025, 0.04, 0.2 * s, 0.38, -0.08), dark)), // pedaleiras
      paint(box(0.02, 0.06, 0.6, 0.12, 0.38, -0.33), dark), // protetor de corrente
    ],
    solid,
  );
  const pivotZ = 0.5;
  const fz = (z: number) => z - pivotZ;
  const front = new THREE.Group();
  front.position.z = pivotZ;
  const frontWheel = new THREE.Mesh(wheelGeometry(r, 0.065, 5, true), solid);
  frontWheel.position.set(0, r, fz(0.68));
  frontWheel.castShadow = true;
  front.add(
    mesh(
      [
        ...pair((s) => tube([0.085 * s, r, fz(0.68)], [0.085 * s, 0.95, fz(0.5)], 0.022, chrome)),
        ...pair((s) => tube([0.085 * s, r, fz(0.68)], [0.085 * s, 0.6, fz(0.6)], 0.032, metal)),
        paint(tilt(new THREE.BoxGeometry(0.13, 0.03, 0.42), 0.15, 0, 0.66, fz(0.66)), body), // para-lama
        paint(new THREE.CylinderGeometry(0.09, 0.08, 0.12, 12).rotateX(Math.PI / 2).translate(0, 0.92, fz(0.6)), '#d8dadc'), // farol
        paint(new THREE.CylinderGeometry(0.075, 0.075, 0.01, 12).rotateX(Math.PI / 2).translate(0, 0.92, fz(0.665)), '#fffbe8'),
        paint(box(0.16, 0.06, 0.08, 0, 1.02, fz(0.48)), dark), // painel
        tube([-0.36, 1.05, fz(0.46)], [0.36, 1.05, fz(0.46)], 0.016, chrome), // guidão
        ...pair((s) => tube([0.26 * s, 1.05, fz(0.46)], [0.38 * s, 1.05, fz(0.46)], 0.022, dark)),
        ...pair((s) => tube([0.25 * s, 1.06, fz(0.47)], [0.3 * s, 1.27, fz(0.44)], 0.008, dark)), // retrovisores
        ...pair((s) => paint(box(0.1, 0.06, 0.012, 0.31 * s, 1.29, fz(0.44)), dark)),
      ],
      solid,
    ),
    frontWheel,
  );
  const rearWheel = new THREE.Mesh(wheelGeometry(r, 0.065, 5, true), solid);
  rearWheel.position.set(...rear);
  rearWheel.castShadow = true;
  // farol + facho no chão (gira com o guidão) e lanterna
  const headGlow = new THREE.Mesh(
    mergeGeometries([paint(box(0.17, 0.17, 0.03, 0, 0.92, fz(0.68)), '#fff2c8'), paint(box(1.3, 0.02, 5, 0, 0.08 - 0, fz(3.3)), '#4a3e22')])!,
    glow,
  );
  const tailGlow = new THREE.Mesh(paint(box(0.14, 0.08, 0.03, 0, 0.88, -0.885), '#ff2a1a'), glow);
  front.add(headGlow);
  const root = new THREE.Group();
  root.add(frame, front, rearWheel, tailGlow);
  return { root, front, wheels: [frontWheel, rearWheel], wheelRadius: r, crank: null, glow: [headGlow, tailGlow] };
}

/**
 * Bag de entrega nas costas (coordenadas do boneco: pés em y 0, frente +z):
 * caixa térmica, alças e faixa refletiva (emissiva — amarela no monocromático).
 */
export function buildBag(): THREE.Group {
  const g = new THREE.Group();
  const red = '#ea1d2c';
  const bag = new THREE.Mesh(
    mergeGeometries([
      paint(box(0.46, 0.44, 0.38, 0, 1.27, -0.33), red),
      paint(box(0.47, 0.025, 0.39, 0, 1.4, -0.33), '#b3141f'), // tampa
      paint(box(0.24, 0.12, 0.006, 0, 1.28, -0.523), '#f7f3ea'), // logo atrás
      paint(box(0.18, 0.006, 0.12, 0, 1.493, -0.33), '#f7f3ea'), // logo em cima
      ...pair((s) => paint(box(0.05, 0.42, 0.02, 0.11 * s, 1.33, 0.135), '#26272b')), // alças
      ...pair((s) => paint(box(0.05, 0.025, 0.3, 0.11 * s, 1.56, -0.02), '#26272b')),
    ])!,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 }),
  );
  bag.castShadow = true;
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.465, 0.035, 0.385).translate(0, 1.17, -0.33),
    new THREE.MeshStandardMaterial({ color: '#e8e8e8', roughness: 0.4, emissive: '#fff3c4', emissiveIntensity: 0.55 }),
  );
  g.add(bag, stripe);
  return g;
}
