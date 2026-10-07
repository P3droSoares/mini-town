import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Game, System } from '../core/Game';
import type { Building } from '../data/types';

interface Highlight {
  building: Building | null;
  lines: LineSegments2;
  fill: THREE.Mesh;
}

/**
 * Hover (contorno) e clique (seleção) em prédios. Raycast acelerado por BVH
 * contra as malhas mescladas; o prédio é resolvido pelo intervalo de vértices.
 */
export class SelectionSystem implements System {
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private pointerDirty = false;
  private pointerInside = false;
  private down: { x: number; y: number; t: number } | null = null;
  private hover: Highlight;
  private selected: Highlight;
  onSelect: ((b: Building | null) => void) | null = null;

  constructor(private readonly game: Game) {
    this.ray.firstHitOnly = true;
    this.hover = this.makeHighlight('#ffffff', 0.12, 3);
    this.selected = this.makeHighlight('#f0b429', 0.22, 4);
    const el = game.renderer.domElement;
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.setHighlight(this.hover, null);
    });
    el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    el.addEventListener('pointerup', this.onUp);
    game.onResizeHooks.push((w, h) => {
      for (const hl of [this.hover, this.selected]) (hl.lines.material as LineMaterial).resolution.set(w, h);
    });
  }

  private makeHighlight(color: string, fillOpacity: number, width: number): Highlight {
    const mat = new LineMaterial({ color, linewidth: width, depthTest: true, transparent: true, opacity: 0.95 });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    const lines = new LineSegments2(new LineSegmentsGeometry(), mat);
    lines.renderOrder = 5;
    lines.visible = false;
    const fill = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: fillOpacity,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    fill.renderOrder = 4;
    fill.visible = false;
    this.game.scene.add(lines, fill);
    return { building: null, lines, fill };
  }

  private setHighlight(hl: Highlight, b: Building | null) {
    if (hl.building === b) return;
    hl.building = b;
    hl.lines.visible = hl.fill.visible = !!b;
    if (!b) return;
    const geo = this.game.view.buildingGeometry(b);
    const edges = new THREE.EdgesGeometry(geo, 25);
    hl.lines.geometry.dispose();
    const lg = new LineSegmentsGeometry();
    lg.setPositions(edges.attributes.position.array as Float32Array);
    hl.lines.geometry = lg;
    hl.lines.computeLineDistances();
    edges.dispose();
    hl.fill.geometry.dispose();
    hl.fill.geometry = geo;
  }

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // sem hover no toque
    this.pointerInside = true;
    this.setNdc(e);
    this.pointerDirty = true;
  };

  private setNdc(e: PointerEvent) {
    const r = this.game.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private onUp = (e: PointerEvent) => {
    if (!this.down) return;
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    const quick = performance.now() - this.down.t < 500;
    this.down = null;
    if (moved > 6 || !quick || e.button > 0) return; // foi arraste/rotação
    this.setNdc(e);
    const b = this.pick();
    this.select(b);
  };

  /** remove destaque sem disparar callback (ex.: painel fechado pela UI) */
  clearSelection() {
    this.setHighlight(this.selected, null);
  }

  select(b: Building | null) {
    this.setHighlight(this.selected, b);
    if (b) this.setHighlight(this.hover, null);
    this.onSelect?.(b);
  }

  private pick(): Building | null {
    const { camera, view } = this.game;
    this.ray.setFromCamera(this.ndc, camera);
    this.ray.far = 2500;
    const hits = this.ray.intersectObjects(view.pickMeshes, false);
    hits.sort((a, b) => a.distance - b.distance);
    const hit = hits[0];
    if (!hit) return null;
    // o terreno pode tapar o prédio (morro na frente)
    const tHit = this.ray.intersectObject(view.terrain, false)[0];
    if (tHit && tHit.distance < hit.distance - 1) return null;
    return view.buildingFromHit(hit) ?? null;
  }

  update() {
    if (!this.pointerDirty || !this.pointerInside) return;
    this.pointerDirty = false;
    const b = this.pick();
    this.setHighlight(this.hover, b && b !== this.selected.building ? b : null);
    this.game.renderer.domElement.style.cursor = b ? 'pointer' : '';
  }
}
