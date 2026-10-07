import * as THREE from 'three';

/** Paleta "cidade mineira em miniatura": tons suaves, telhados cerâmicos. */
export const PALETTE = {
  walls: ['#f4efe4', '#efe6d2', '#f2e2b8', '#e9d8a6', '#dfe8ec', '#cfe0e8', '#f1d9cf', '#e8cfc0', '#f6f1ea', '#dfe6d3', '#efd9a6', '#e2c9a6'],
  wallsCommercial: ['#f1ece2', '#e4e1da', '#dcd6c8', '#f0e3c4', '#d8e2e6', '#e9d5c5'],
  roofsCeramic: ['#b5532f', '#c2633a', '#a4472a', '#c97a4a', '#9c3f26', '#b9603d', '#ad5a3b', '#c46b45'],
  roofsGray: ['#8f8f8a', '#9d9a92', '#7f817f'],
  roofsFlat: ['#bdb6aa', '#a9a49a', '#c7c1b5', '#b2aca0'],
  church: '#fbfaf5',
  churchTrim: '#3f6d8f',
  waterTank: '#4f86b0',
  asphalt: '#5d6166',
  asphaltLight: '#6c7075',
  sidewalk: '#c9c3b8',
  footway: '#d6c7aa',
  marking: '#f2efe6',
  markingYellow: '#e9c349',
  grass: '#6a854b',
  park: '#5f8642',
  wood: '#4e6e3a',
  pitch: '#5c8c40',
  cemetery: '#8a9a78',
  water: '#4a90b8',
  terrainLow: '#647f45',
  terrainHigh: '#4f6a38',
  terrainSoil: '#b07a52',
  terrainUrban: '#c9bf9f',
  treeLeaves: ['#5d9a48', '#6aa84f', '#4f8a3f', '#7bb257', '#5a8f3c'],
  trunk: '#7a5a3c',
};

const cache = new Map<string, THREE.Color>();
export function color(hex: string): THREE.Color {
  let c = cache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    cache.set(hex, c);
  }
  return c;
}

export function pick<T>(arr: T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
}

/** converte cor OSM (nome ou hex) com fallback */
export function osmColour(v: string | undefined, fallback: string): THREE.Color {
  if (!v) return color(fallback);
  try {
    const c = new THREE.Color();
    c.setStyle(v.replace(/_/g, ''));
    return c;
  } catch {
    return color(fallback);
  }
}
