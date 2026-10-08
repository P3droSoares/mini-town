import type { CityData } from '../data/types';
import { type Category, estimateBasePrice, isSellableCategory } from './rules';

/**
 * Catálogo de imóveis estimado no cliente, a partir do mesmo JSON da cidade
 * que o servidor lê no boot (mesmas regras de `server/src/economy/catalog.ts`:
 * centro = centróide dos comerciais, área arredondada, avaliação base pela
 * função compartilhada). Serve só para PROCURAR imóveis da prefeitura; o
 * preço final vem sempre de `GET /api/properties/:lotId`.
 */
export interface CatalogEntry {
  lotId: string;
  category: Category;
  area: number;
  levels: number;
  address: string | null;
  /** avaliação base (índice 1,0), centavos */
  base: bigint;
}

const LOT_RE = /^ITB-[A-Z0-9-]{1,40}$/;

function formatAddress(a: { street?: string; housenumber?: string } | undefined): string | null {
  if (!a?.street) return null;
  return (a.housenumber ? `${a.street}, ${a.housenumber}` : a.street).slice(0, 200);
}

/** só imóveis vendáveis (institucional/religioso ficam de fora) */
export function buildCityCatalog(city: Pick<CityData, 'buildings' | 'lots'>): CatalogEntry[] {
  const byId = new Map(city.buildings.map((b) => [b.id, b]));
  const com = city.buildings.filter((b) => b.category === 'commercial');
  const cx = com.length ? com.reduce((s, b) => s + b.centroid[0], 0) / com.length : 0;
  const cz = com.length ? com.reduce((s, b) => s + b.centroid[1], 0) / com.length : 0;
  const out: CatalogEntry[] = [];
  for (const lot of city.lots) {
    if (!LOT_RE.test(lot.lotId) || !(lot.area > 0)) continue;
    const b = lot.buildingId ? byId.get(lot.buildingId) : undefined;
    const category: Category = b ? b.category : 'vacant';
    if (!isSellableCategory(category)) continue;
    const levels = b ? Math.max(1, Math.min(200, Math.round(b.levels))) : 0;
    const dist = Math.round(Math.hypot(lot.centroid[0] - cx, lot.centroid[1] - cz));
    const area = Math.round(lot.area * 10) / 10;
    // projeção construída limitada ao lote; o terreno entra à parte (igual ao servidor)
    const footprint = b && b.area > 0 ? Math.min(b.area, lot.area) : lot.area;
    out.push({ lotId: lot.lotId, category, area, levels, address: formatAddress(lot.address ?? b?.address), base: estimateBasePrice(category, footprint, levels, dist, lot.area) });
  }
  return out;
}
