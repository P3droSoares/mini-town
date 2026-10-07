import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function box(w: number, h: number, d: number, x: number, y: number, z: number, c: string) {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
  g.deleteAttribute('uv');
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/**
 * Carro low-poly (frente = +z). Carroceria branca: a cor vem do
 * instanceColor; vidros e pneus escuros quase não mudam com o tint.
 */
export function carGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    box(1.75, 0.62, 4.1, 0, 0.62, 0, '#ffffff'),
    box(1.55, 0.55, 2.0, 0, 1.2, -0.25, '#2a3440'),
    box(1.5, 0.08, 1.9, 0, 1.5, -0.25, '#ffffff'),
    box(0.3, 0.5, 0.6, 0.78, 0.3, 1.3, '#151515'),
    box(0.3, 0.5, 0.6, -0.78, 0.3, 1.3, '#151515'),
    box(0.3, 0.5, 0.6, 0.78, 0.3, -1.3, '#151515'),
    box(0.3, 0.5, 0.6, -0.78, 0.3, -1.3, '#151515'),
  ])!;
}

/** Ônibus municipal */
export function busGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    box(2.4, 2.4, 10.5, 0, 1.6, 0, '#ffffff'),
    box(2.45, 0.8, 9.6, 0, 2.15, -0.2, '#2a3440'),
    box(2.3, 1.0, 0.1, 0, 2.0, 5.25, '#2a3440'),
    box(0.35, 0.8, 0.9, 1.1, 0.4, 3.4, '#151515'),
    box(0.35, 0.8, 0.9, -1.1, 0.4, 3.4, '#151515'),
    box(0.35, 0.8, 0.9, 1.1, 0.4, -3.4, '#151515'),
    box(0.35, 0.8, 0.9, -1.1, 0.4, -3.4, '#151515'),
  ])!;
}

/** Faróis (frente) e lanternas (trás) — material básico, visível à noite. */
export function carLightsGeometry(length = 4.1, width = 1.75, y = 0.68): THREE.BufferGeometry {
  const fz = length / 2 + 0.02;
  const fx = width / 2 - 0.3;
  return mergeGeometries([
    box(0.38, 0.16, 0.06, fx, y, fz, '#fff1c4'),
    box(0.38, 0.16, 0.06, -fx, y, fz, '#fff1c4'),
    box(0.38, 0.14, 0.06, fx, y, -fz, '#ff3b2f'),
    box(0.38, 0.14, 0.06, -fx, y, -fz, '#ff3b2f'),
    // facho de luz no chão à frente (sutil)
    box(1.6, 0.02, 5, 0, 0.08, fz + 2.6, '#6b5a2a'),
  ])!;
}

/** Pedestre: roupa (tingida por instância). */
export function pedestrianClothesGeometry(): THREE.BufferGeometry {
  return mergeGeometries([box(0.46, 0.6, 0.28, 0, 1.08, 0, '#ffffff'), box(0.4, 0.78, 0.24, 0, 0.39, 0, '#6d7684')])!;
}

/** Pedestre: cabeça/braços (tom de pele por instância). */
export function pedestrianSkinGeometry(): THREE.BufferGeometry {
  const head = new THREE.IcosahedronGeometry(0.17, 0).translate(0, 1.56, 0);
  head.deleteAttribute('uv');
  const n = head.attributes.position.count;
  head.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return mergeGeometries([head, box(0.1, 0.5, 0.1, 0.29, 1.05, 0, '#ffffff'), box(0.1, 0.5, 0.1, -0.29, 1.05, 0, '#ffffff')])!;
}
