/**
 * Sincroniza o catálogo de imóveis a partir do JSON da cidade (idempotente).
 * Roda com o papel dono (o papel app não pode alterar o catálogo), numa
 * transação única, registrando o checksum aplicado em `catalog_versions`.
 *
 * Imóvel com dono nunca é reprecificado nem muda de categoria por causa do
 * catálogo (seria emissão sem rastro no razão): base, categoria e "vendável"
 * ficam congelados até ele voltar à prefeitura. Lote que some do JSON é
 * aposentado (`retired_at`): a prefeitura não o vende mais.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { z } from 'zod';
import { LOT_ID_RE } from '../http/validate.js';
import type { Category } from './config.js';
import { basePrice, isSellable } from './pricing.js';

const AddressSchema = z
  .object({ street: z.string().optional(), housenumber: z.string().optional(), suburb: z.string().optional() })
  .optional();
const Vec2 = z.tuple([z.number(), z.number()]);

const CitySchema = z.object({
  buildings: z.array(
    z.object({
      id: z.string(),
      lotId: z.string(),
      category: z.enum(['residential', 'commercial', 'industrial', 'institutional', 'religious']),
      levels: z.number(),
      area: z.number(),
      centroid: Vec2,
      address: AddressSchema,
    }),
  ),
  lots: z.array(
    z.object({
      lotId: z.string(),
      buildingId: z.string().nullable(),
      vacant: z.boolean().optional(),
      area: z.number(),
      centroid: Vec2,
      address: AddressSchema,
    }),
  ),
});

export interface CatalogRow {
  lotId: string;
  buildingId: string | null;
  category: Category;
  /** área do lote (exibida) */
  areaM2: number;
  levels: number;
  address: string | null;
  x: number;
  z: number;
  distM: number;
  basePrice: bigint;
  sellable: boolean;
}

function formatAddress(a: z.infer<typeof AddressSchema>): string | null {
  if (!a?.street) return null;
  const s = a.housenumber ? `${a.street}, ${a.housenumber}` : a.street;
  return s.slice(0, 200);
}

/** Lê o JSON da cidade e calcula as linhas do catálogo. */
export async function buildCatalog(path: string): Promise<{ rows: CatalogRow[]; center: [number, number] }> {
  const city = CitySchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const byId = new Map(city.buildings.map((b) => [b.id, b]));

  // centro = centróide dos imóveis comerciais (praça/igreja matriz ficam ali)
  const com = city.buildings.filter((b) => b.category === 'commercial');
  const center: [number, number] = com.length
    ? [com.reduce((s, b) => s + b.centroid[0], 0) / com.length, com.reduce((s, b) => s + b.centroid[1], 0) / com.length]
    : [0, 0];

  const rows: CatalogRow[] = [];
  for (const lot of city.lots) {
    if (!LOT_ID_RE.test(lot.lotId) || !(lot.area > 0)) continue;
    const b = lot.buildingId ? byId.get(lot.buildingId) : undefined;
    const category: Category = b ? b.category : 'vacant';
    const levels = b ? Math.max(1, Math.min(200, Math.round(b.levels))) : 0;
    const [x, z] = lot.centroid;
    const distM = Math.round(Math.hypot(x - center[0], z - center[1]));
    const areaM2 = Math.round(lot.area * 10) / 10;
    // construído = projeção do prédio (não o lote inteiro) × andares; terreno à parte
    const footprint = b && b.area > 0 ? Math.min(b.area, lot.area) : lot.area;
    rows.push({
      lotId: lot.lotId,
      buildingId: b?.id ?? null,
      category,
      areaM2,
      levels,
      address: formatAddress(lot.address ?? b?.address),
      x,
      z,
      distM,
      basePrice: basePrice(category, footprint, levels, distM, lot.area),
      sellable: isSellable(category),
    });
  }
  return { rows, center };
}

/** Checksum do catálogo calculado (inclui preços, logo também os parâmetros de config.ts). */
export function catalogChecksum(rows: CatalogRow[]): string {
  const h = createHash('sha256');
  for (const r of [...rows].sort((a, b) => (a.lotId < b.lotId ? -1 : 1))) {
    h.update(
      [r.lotId, r.buildingId, r.category, r.areaM2, r.levels, r.address, r.x, r.z, r.distM, r.basePrice, r.sellable].join('|'),
    );
    h.update('\n');
  }
  return h.digest('hex');
}

export interface SyncResult {
  checksum: string;
  /** checksum já aplicado: nada mudou */
  skipped: boolean;
  changed: number;
  /** imóveis com dono cujo preço/categoria ficaram congelados */
  frozen: number;
  retired: number;
}

/** Aplica o catálogo numa transação única (sem timeout de comando). */
export async function syncCatalog(ownerPool: pg.Pool, rows: CatalogRow[]): Promise<SyncResult> {
  const checksum = catalogChecksum(rows);
  const c = await ownerPool.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL statement_timeout = 0`);
    await c.query(`SELECT pg_advisory_xact_lock(7420312)`);
    const seen = await c.query('SELECT 1 FROM catalog_versions WHERE checksum = $1', [checksum]);
    if (seen.rowCount) {
      await c.query('COMMIT');
      return { checksum, skipped: true, changed: 0, frozen: 0, retired: 0 };
    }
    await c.query(`
      CREATE TEMP TABLE catalog_in (
        lot_id text PRIMARY KEY, building_id text, category text, area_m2 numeric(10, 1), levels smallint,
        address text, x float8, z float8, dist_center_m int, base_price bigint, sellable bool
      ) ON COMMIT DROP`);
    const chunk = 1000;
    for (let i = 0; i < rows.length; i += chunk) {
      const part = rows.slice(i, i + chunk);
      await c.query(
        `INSERT INTO catalog_in
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::smallint[], $6::text[],
                              $7::float8[], $8::float8[], $9::int[], $10::bigint[], $11::bool[])
         ON CONFLICT (lot_id) DO NOTHING`,
        [
          part.map((r) => r.lotId),
          part.map((r) => r.buildingId),
          part.map((r) => r.category),
          part.map((r) => r.areaM2),
          part.map((r) => r.levels),
          part.map((r) => r.address),
          part.map((r) => r.x),
          part.map((r) => r.z),
          part.map((r) => r.distM),
          part.map((r) => r.basePrice.toString()),
          part.map((r) => r.sellable),
        ],
      );
    }
    // com dono: base/categoria/vendável congelados (só atributos físicos e endereço mudam)
    const frozen = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM properties p JOIN catalog_in i USING (lot_id)
        WHERE p.owner_id IS NOT NULL
          AND (p.base_price, p.category, p.sellable) IS DISTINCT FROM (i.base_price, i.category, i.sellable)`,
    );
    const owned = await c.query(
      `UPDATE properties p SET building_id = i.building_id, area_m2 = i.area_m2, levels = i.levels, address = i.address,
              x = i.x, z = i.z, dist_center_m = i.dist_center_m, retired_at = NULL, catalog_synced_at = now()
         FROM catalog_in i
        WHERE p.lot_id = i.lot_id AND p.owner_id IS NOT NULL
          AND ((p.building_id, p.area_m2, p.levels, p.address, p.x, p.z, p.dist_center_m) IS DISTINCT FROM
               (i.building_id, i.area_m2, i.levels, i.address, i.x, i.z, i.dist_center_m) OR p.retired_at IS NOT NULL)`,
    );
    const free = await c.query(
      `UPDATE properties p SET building_id = i.building_id, category = i.category, area_m2 = i.area_m2, levels = i.levels,
              address = i.address, x = i.x, z = i.z, dist_center_m = i.dist_center_m, base_price = i.base_price,
              sellable = i.sellable, retired_at = NULL, catalog_synced_at = now()
         FROM catalog_in i
        WHERE p.lot_id = i.lot_id AND p.owner_id IS NULL
          AND ((p.building_id, p.category, p.area_m2, p.levels, p.address, p.x, p.z, p.dist_center_m, p.base_price, p.sellable)
               IS DISTINCT FROM
               (i.building_id, i.category, i.area_m2, i.levels, i.address, i.x, i.z, i.dist_center_m, i.base_price, i.sellable)
               OR p.retired_at IS NOT NULL)`,
    );
    const inserted = await c.query(
      `INSERT INTO properties (lot_id, building_id, category, area_m2, levels, address, x, z, dist_center_m, base_price, sellable)
       SELECT lot_id, building_id, category, area_m2, levels, address, x, z, dist_center_m, base_price, sellable FROM catalog_in
       ON CONFLICT (lot_id) DO NOTHING`,
    );
    // sumiu do JSON: aposentado (sem dono = não vendável; com dono = continua dele, mas a prefeitura não revende)
    const retired = await c.query(
      `UPDATE properties p SET retired_at = now(), sellable = (p.owner_id IS NOT NULL), catalog_synced_at = now()
        WHERE p.retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM catalog_in i WHERE i.lot_id = p.lot_id)`,
    );
    // preço de referência por categoria (mediana da base dos vendáveis): peso da demanda no índice
    await c.query(
      `UPDATE market_indices mi SET ref_price = x.med
         FROM (SELECT category, percentile_disc(0.5) WITHIN GROUP (ORDER BY base_price) AS med
                 FROM properties WHERE sellable AND retired_at IS NULL GROUP BY category) x
        WHERE mi.category = x.category AND x.med > 0`,
    );
    const result: SyncResult = {
      checksum,
      skipped: false,
      changed: (owned.rowCount ?? 0) + (free.rowCount ?? 0) + (inserted.rowCount ?? 0),
      frozen: frozen.rows[0]?.n ?? 0,
      retired: retired.rowCount ?? 0,
    };
    await c.query(`INSERT INTO catalog_versions (checksum, lot_count, frozen, retired) VALUES ($1, $2, $3, $4)`, [
      checksum,
      rows.length,
      result.frozen,
      result.retired,
    ]);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    c.release(broken);
  }
}
