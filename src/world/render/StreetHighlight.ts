import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Street } from '../../data/types';
import type { HeightField } from '../HeightField';
import { densify } from './roadGeometry';

/** Linha grossa pulsante sobre a(s) rua(s) encontrada(s) na busca. */
export class StreetHighlight {
  readonly line: LineSegments2;
  private t = 0;
  private dur = 0;

  constructor(private readonly hf: HeightField) {
    const mat = new LineMaterial({ color: '#ff5a36', linewidth: 9, transparent: true, depthTest: false });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    this.line = new LineSegments2(new LineSegmentsGeometry(), mat);
    this.line.frustumCulled = false;
    this.line.renderOrder = 6;
    this.line.visible = false;
  }

  resize(w: number, h: number) {
    (this.line.material as LineMaterial).resolution.set(w, h);
  }

  show(streets: Street[], seconds = 8) {
    const pos: number[] = [];
    for (const s of streets) {
      const pts = densify(s.points, 6);
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i];
        const [bx, bz] = pts[i + 1];
        pos.push(ax, this.hf.sample(ax, az) + 0.6, az, bx, this.hf.sample(bx, bz) + 0.6, bz);
      }
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    this.line.geometry.dispose();
    this.line.geometry = g;
    this.line.visible = true;
    this.t = 0;
    this.dur = seconds;
  }

  update(dt: number) {
    if (!this.line.visible) return;
    this.t += dt;
    const m = this.line.material as LineMaterial;
    m.opacity = (0.65 + 0.35 * Math.sin(this.t * 5)) * THREE.MathUtils.clamp((this.dur - this.t) / 1.5, 0, 1);
    if (this.t > this.dur) this.line.visible = false;
  }
}
