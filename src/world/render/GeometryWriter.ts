import * as THREE from 'three';

/**
 * Acumulador de triângulos não indexados com normal plana.
 * Atributos:
 *  - position, normal, color
 *  - uv      (METROS; texturas usam repeat = 1/tamanho físico). Padrão: (x, z) do mundo
 *  - facade  vec4 (u ao longo da parede, v altura acima do solo, altura total, seed)
 *            seed = 0 => sem janelas (telhados, chão...)
 *  - style   vec4 (cor de acabamento rgb, código de estilo) — constante por prédio
 *  - aux     vec4 (comprimento da parede, margem, nº de vãos, camada+1 do atlas; 0 = sem textura)
 */
export class GeometryWriter {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  fac: number[] = [];
  sty: number[] = [];
  aux: number[] = [];
  /** índices (quads compartilham 2 vértices: 4 em vez de 6) */
  idx: number[] = [];
  /** estilo corrente aplicado aos próximos vértices */
  style: [number, number, number, number] = [0, 0, 0, 0];
  /** layout de janelas da parede corrente */
  wall: [number, number, number, number] = [0, 0, 0, 0];
  /** camada do atlas de materiais (-1 = cor sólida) */
  layer = -1;

  private static a = new THREE.Vector3();
  private static b = new THREE.Vector3();
  private static n = new THREE.Vector3();

  get vertexCount() {
    return this.pos.length / 3;
  }

  /**
   * Adiciona triângulo. Se `facing` for informado, a ordem é ajustada para a
   * normal apontar para o mesmo lado.
   * @param uv 6 números (u0 v0 u1 v1 u2 v2) — padrão: x/z do mundo
   * @param fac 12 números (vec4 por vértice) — padrão: zeros
   */
  tri(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, color: THREE.Color, facing?: THREE.Vector3, uv?: number[], fac?: number[]) {
    const { a, b, n } = GeometryWriter;
    a.subVectors(p1, p0);
    b.subVectors(p2, p0);
    n.crossVectors(a, b);
    const len = n.length();
    if (len < 1e-8) return;
    n.divideScalar(len);
    let i1 = 1;
    let i2 = 2;
    if (facing && n.dot(facing) < 0) {
      n.negate();
      [p1, p2] = [p2, p1];
      i1 = 2;
      i2 = 1;
    }
    const base = this.vertexCount;
    this.idx.push(base, base + 1, base + 2);
    this.pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    const s = this.style;
    for (let i = 0; i < 3; i++) {
      this.nor.push(n.x, n.y, n.z);
      this.col.push(color.r, color.g, color.b);
      this.sty.push(s[0], s[1], s[2], s[3]);
      this.aux.push(this.wall[0], this.wall[1], this.wall[2], this.layer + 1);
    }
    if (uv) this.uv.push(uv[0], uv[1], uv[i1 * 2], uv[i1 * 2 + 1], uv[i2 * 2], uv[i2 * 2 + 1]);
    else this.uv.push(p0.x, p0.z, p1.x, p1.z, p2.x, p2.z);
    if (fac) {
      this.fac.push(fac[0], fac[1], fac[2], fac[3]);
      this.fac.push(fac[i1 * 4], fac[i1 * 4 + 1], fac[i1 * 4 + 2], fac[i1 * 4 + 3]);
      this.fac.push(fac[i2 * 4], fac[i2 * 4 + 1], fac[i2 * 4 + 2], fac[i2 * 4 + 3]);
    } else this.fac.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }

  /** quad p0-p1-p2-p3; uv: 8 números, fac: 16 números */
  quad(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    color: THREE.Color,
    facing?: THREE.Vector3,
    uv?: number[],
    fac?: number[],
  ) {
    const { a, b, n } = GeometryWriter;
    // normal do quad = média das duas metades (quads levemente não planares)
    a.subVectors(p2, p0);
    b.subVectors(p3, p1);
    n.crossVectors(a, b);
    const len = n.length();
    if (len < 1e-8) {
      const pick = (arr: number[] | undefined, ids: number[], k: number) => (arr ? ids.flatMap((i) => arr.slice(i * k, i * k + k)) : undefined);
      this.tri(p0, p1, p2, color, facing, pick(uv, [0, 1, 2], 2), pick(fac, [0, 1, 2], 4));
      this.tri(p0, p2, p3, color, facing, pick(uv, [0, 2, 3], 2), pick(fac, [0, 2, 3], 4));
      return;
    }
    n.divideScalar(len);
    const flip = !!facing && n.dot(facing) < 0;
    if (flip) n.negate();
    const base = this.vertexCount;
    const ps = [p0, p1, p2, p3];
    const s = this.style;
    for (let i = 0; i < 4; i++) {
      const p = ps[i];
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(color.r, color.g, color.b);
      this.sty.push(s[0], s[1], s[2], s[3]);
      this.aux.push(this.wall[0], this.wall[1], this.wall[2], this.layer + 1);
      if (uv) this.uv.push(uv[i * 2], uv[i * 2 + 1]);
      else this.uv.push(p.x, p.z);
      if (fac) this.fac.push(fac[i * 4], fac[i * 4 + 1], fac[i * 4 + 2], fac[i * 4 + 3]);
      else this.fac.push(0, 0, 0, 0);
    }
    if (flip) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** caixa orientada pelo eixo u (no plano xz), com UV de parede nas laterais */
  box(cx: number, cz: number, y0: number, y1: number, ux: number, uz: number, hu: number, hv: number, color: THREE.Color, top = true) {
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
    let u = 0;
    for (let i = 0; i < 4; i++) {
      const [su0, sv0] = corners[i];
      const [su1, sv1] = corners[(i + 1) % 4];
      const p0 = c(su0, sv0, y0);
      const p1 = c(su1, sv1, y0);
      const p2 = c(su1, sv1, y1);
      const p3 = c(su0, sv0, y1);
      const len = p0.distanceTo(p1);
      const facing = p0.clone().add(p1).multiplyScalar(0.5).sub(center).setY(0);
      this.quad(p0, p1, p2, p3, color, facing, [u, y0, u + len, y0, u + len, y1, u, y1]);
      u += len;
    }
    if (top) this.quad(c(-1, -1, y1), c(1, -1, y1), c(1, 1, y1), c(-1, 1, y1), color, UP);
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('facade', new THREE.Float32BufferAttribute(this.fac, 4));
    g.setAttribute('style', new THREE.Float32BufferAttribute(this.sty, 4));
    g.setAttribute('aux', new THREE.Float32BufferAttribute(this.aux, 4));
    g.setIndex(this.idx);
    return g;
  }
}

export const ZERO4 = [0, 0, 0, 0];
export const UP = new THREE.Vector3(0, 1, 0);
