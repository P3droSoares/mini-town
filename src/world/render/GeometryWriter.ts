import * as THREE from 'three';

/**
 * Acumulador de triângulos não indexados com normal plana (estética low-poly).
 * Atributos: position, normal, color, facade(vec4).
 *  facade = (u ao longo da parede, v altura acima do solo, altura total, seed)
 *  seed = 0 => sem janelas (telhados, chão, etc.)
 */
export class GeometryWriter {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  fac: number[] = [];

  private static a = new THREE.Vector3();
  private static b = new THREE.Vector3();
  private static n = new THREE.Vector3();

  get vertexCount() {
    return this.pos.length / 3;
  }

  /**
   * Adiciona triângulo. Se `facing` for informado, a ordem é ajustada para a
   * normal apontar para o mesmo lado.
   */
  tri(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    color: THREE.Color,
    facing?: THREE.Vector3,
    f0: number[] = ZERO4,
    f1: number[] = ZERO4,
    f2: number[] = ZERO4,
  ) {
    const { a, b, n } = GeometryWriter;
    a.subVectors(p1, p0);
    b.subVectors(p2, p0);
    n.crossVectors(a, b);
    const len = n.length();
    if (len < 1e-8) return;
    n.divideScalar(len);
    if (facing && n.dot(facing) < 0) {
      n.negate();
      [p1, p2] = [p2, p1];
      [f1, f2] = [f2, f1];
    }
    this.pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    for (let i = 0; i < 3; i++) {
      this.nor.push(n.x, n.y, n.z);
      this.col.push(color.r, color.g, color.b);
    }
    this.fac.push(...f0, ...f1, ...f2);
  }

  quad(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    color: THREE.Color,
    facing?: THREE.Vector3,
    f?: [number[], number[], number[], number[]],
  ) {
    this.tri(p0, p1, p2, color, facing, f?.[0], f?.[1], f?.[2]);
    this.tri(p0, p2, p3, color, facing, f?.[0], f?.[2], f?.[3]);
  }

  /** caixa alinhada a um eixo u (no plano xz) */
  box(cx: number, cz: number, y0: number, y1: number, ux: number, uz: number, hu: number, hv: number, color: THREE.Color) {
    const vx = -uz;
    const vz = ux;
    const c = (su: number, sv: number, y: number) =>
      new THREE.Vector3(cx + ux * hu * su + vx * hv * sv, y, cz + uz * hu * su + vz * hv * sv);
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const center = new THREE.Vector3(cx, (y0 + y1) / 2, cz);
    for (let i = 0; i < 4; i++) {
      const [su0, sv0] = corners[i];
      const [su1, sv1] = corners[(i + 1) % 4];
      const p0 = c(su0, sv0, y0);
      const p1 = c(su1, sv1, y0);
      const p2 = c(su1, sv1, y1);
      const p3 = c(su0, sv0, y1);
      const facing = p0.clone().add(p1).multiplyScalar(0.5).sub(center).setY(0);
      this.quad(p0, p1, p2, p3, color, facing);
    }
    this.quad(c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1), color, UP);
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('facade', new THREE.Float32BufferAttribute(this.fac, 4));
    return g;
  }
}

export const ZERO4 = [0, 0, 0, 0];
export const UP = new THREE.Vector3(0, 1, 0);
