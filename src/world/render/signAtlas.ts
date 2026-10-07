import * as THREE from 'three';

/**
 * Atlas de letreiros (canvas 2048x2048, grade 8x16 de 256x128).
 * Primeiro os nomes reais dos estabelecimentos (POIs do OSM), depois lojas
 * genéricas e propagandas de outdoor. Usado como map + emissiveMap (acende
 * à noite).
 */
const COLS = 8;
const ROWS = 16;
const CW = 256;
const CH = 128;

const GENERIC = [
  'Farmácia Popular',
  'Padaria Pão Quente',
  'Supermercado Bom Preço',
  'Drogaria Minas',
  'Lojas Itabirito',
  'Açougue Central',
  'Ótica Visão',
  'Casa do Construtor',
  'Bar do Zé',
  'Pizzaria Bella',
  'Pet Shop Amigo',
  'Salão Beleza Pura',
  'Academia Força',
  'Café Mineiro',
  'Celular & Cia',
  'Auto Peças Minas',
  'Oficina do Tião',
  'Lanchonete Sabor',
  'Papelaria Escolar',
  'Sorveteria Gelato',
  'Loja de Calçados',
  'Moda Feminina',
  'Hortifrúti Fresco',
  'Mercearia Paraopeba',
  'Doceria Ouro Preto',
  'Restaurante Mineiro',
  'Livraria Saber',
  'Clínica Saúde',
  'Imobiliária Lar',
  'Eletrônicos Tech',
  'Móveis Conforto',
  'Pastelaria Japa',
];

const ADS = [
  ['Pão de Queijo', 'O sabor de Minas'],
  ['Banco Futuro', 'Seu crédito na hora'],
  ['Refri Gelado', 'Abra a felicidade'],
  ['Internet 1 Giga', 'Fibra em toda cidade'],
  ['Imóveis Itabirito', 'Compre seu lote'],
  ['Festival de Inverno', 'Julho no centro'],
  ['Café da Serra', '100% mineiro'],
  ['Anuncie aqui', '(31) 0000-0000'],
];

const PALETTES: [string, string][] = [
  ['#c62828', '#ffffff'],
  ['#1565c0', '#ffffff'],
  ['#2e7d32', '#ffffff'],
  ['#f9a825', '#1b1b1b'],
  ['#6a1b9a', '#ffffff'],
  ['#ef6c00', '#ffffff'],
  ['#ffffff', '#c62828'],
  ['#ffffff', '#1565c0'],
  ['#263238', '#ffd54f'],
  ['#00838f', '#ffffff'],
  ['#ad1457', '#ffffff'],
  ['#fafafa', '#2e7d32'],
];

export class SignAtlas {
  readonly texture: THREE.CanvasTexture;
  private readonly index = new Map<string, number>();
  private count = 0;
  private adStart = 0;
  private adCount = 0;
  private genericStart = 0;

  constructor(realNames: string[]) {
    const c = document.createElement('canvas');
    c.width = COLS * CW;
    c.height = ROWS * CH;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    const unique = [...new Set(realNames.map((n) => n.trim()).filter(Boolean))];
    const maxNames = COLS * ROWS - ADS.length;
    for (const name of unique.slice(0, maxNames - GENERIC.length)) this.drawSign(g, name, this.count++);
    this.genericStart = this.count;
    for (const name of GENERIC) if (this.count < maxNames) this.drawSign(g, name, this.count++);
    this.adStart = this.count;
    ADS.forEach(([t, s], i) => this.drawAd(g, t, s, this.adStart + i, i));
    this.adCount = ADS.length;
    this.count += ADS.length;
    unique.forEach((n, i) => i < this.genericStart && this.index.set(n, i));
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  private cell(i: number) {
    return { x: (i % COLS) * CW, y: Math.floor(i / COLS) * CH };
  }

  private drawSign(g: CanvasRenderingContext2D, name: string, i: number) {
    const { x, y } = this.cell(i);
    let h = 0;
    for (let k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) >>> 0;
    const [bg, fg] = PALETTES[h % PALETTES.length];
    g.fillStyle = bg;
    g.fillRect(x, y, CW, CH);
    // faixa/ícone lateral
    g.fillStyle = fg;
    g.globalAlpha = 0.9;
    const shape = h % 3;
    if (shape === 0) {
      g.beginPath();
      g.arc(x + 46, y + CH / 2, 30, 0, Math.PI * 2);
      g.fill();
    } else if (shape === 1) g.fillRect(x + 18, y + 34, 56, 60);
    else {
      g.beginPath();
      g.moveTo(x + 46, y + 26);
      g.lineTo(x + 80, y + 98);
      g.lineTo(x + 12, y + 98);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = bg;
    g.font = 'bold 38px Nunito, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name.trim()[0]?.toUpperCase() ?? '•', x + 46, y + CH / 2 + 2);
    // texto (quebra em 2 linhas se precisar)
    g.fillStyle = fg;
    g.textAlign = 'left';
    const words = name.split(' ');
    const lines: string[] = [];
    let cur = '';
    g.font = 'bold 30px Nunito, Arial, sans-serif';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (g.measureText(t).width > CW - 104 && cur) {
        lines.push(cur);
        cur = w;
      } else cur = t;
    }
    lines.push(cur);
    const size = lines.length > 2 ? 22 : 30;
    g.font = `bold ${size}px Nunito, Arial, sans-serif`;
    lines.slice(0, 3).forEach((ln, k) => {
      const yy = y + CH / 2 + (k - (Math.min(3, lines.length) - 1) / 2) * (size + 4);
      g.fillText(ln, x + 94, yy, CW - 104);
    });
    // borda
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 4;
    g.strokeRect(x + 2, y + 2, CW - 4, CH - 4);
  }

  private drawAd(g: CanvasRenderingContext2D, title: string, sub: string, i: number, k: number) {
    const { x, y } = this.cell(i);
    const grad = g.createLinearGradient(x, y, x + CW, y + CH);
    const [a, b] = PALETTES[(k * 5 + 1) % PALETTES.length];
    grad.addColorStop(0, a === '#ffffff' || a === '#fafafa' ? '#e3f2fd' : a);
    grad.addColorStop(1, '#1b1b1b');
    g.fillStyle = grad;
    g.fillRect(x, y, CW, CH);
    g.fillStyle = b === '#1b1b1b' ? '#ffffff' : b;
    g.font = 'bold 34px Nunito, Arial, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(title, x + 14, y + 48, CW - 28);
    g.font = '22px Nunito, Arial, sans-serif';
    g.fillStyle = '#ffffffcc';
    g.fillText(sub, x + 14, y + 92, CW - 28);
  }

  /** índice do letreiro para um nome real; senão um genérico pelo seed */
  signFor(name: string | undefined, seed: number): number {
    if (name && this.index.has(name.trim())) return this.index.get(name.trim())!;
    return this.genericStart + (seed % (this.adStart - this.genericStart));
  }

  adFor(seed: number): number {
    return this.adStart + (seed % this.adCount);
  }

  /** UV (u0, v0, u1, v1) da célula, com uma pequena margem */
  uv(i: number): [number, number, number, number] {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const e = 0.002;
    return [col / COLS + e, 1 - (row + 1) / ROWS + e, (col + 1) / COLS - e, 1 - row / ROWS - e];
  }
}
