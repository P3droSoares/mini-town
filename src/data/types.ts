/**
 * Contrato de dados da cidade.
 *
 * Gerado por `scripts/fetch-osm.ts` (JSON estático) e consumido pelo jogo.
 * No futuro o mesmo formato pode vir de um servidor — por isso nada aqui
 * depende de Three.js.
 *
 * Sistema de coordenadas local (metros), idêntico ao do Three.js:
 *   x = leste, z = sul (norte = -z), y = altitude relativa a `origin.elevation`.
 */

/** [x, z] em metros. */
export type Vec2 = [number, number];
/** Anel de polígono (sem repetir o primeiro ponto no final). */
export type Ring = Vec2[];

export type RoadKind =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'living_street'
  | 'pedestrian'
  | 'footway'
  | 'path'
  | 'steps'
  | 'track'
  | 'cycleway'
  | 'unclassified';

export interface Street {
  /** id estável: "way/<osmId>" */
  id: string;
  osmId: number;
  name?: string;
  kind: RoadKind;
  /** largura da pista em metros */
  width: number;
  oneway: boolean;
  /** pontos da polilinha */
  points: Vec2[];
  /** ids de nó OSM correspondentes a cada ponto (para montar o grafo viário) */
  nodes: number[];
  bridge?: boolean;
  tunnel?: boolean;
  surface?: string;
}

/** Uso do imóvel — define o estilo visual e, no futuro, a economia do lote. */
export type BuildingCategory = 'residential' | 'commercial' | 'industrial' | 'institutional' | 'religious';

export type LandUseKind = 'residential' | 'commercial' | 'retail' | 'industrial';

export interface LandUse {
  id: string;
  kind: LandUseKind;
  name?: string;
  outer: Ring;
  holes?: Ring[];
}

export interface Building {
  /** id estável: "way/<osmId>" ou "relation/<osmId>" */
  id: string;
  osmId: number;
  osmType: 'way' | 'relation';
  /** id do lote (base para compra de imóveis no futuro) */
  lotId: string;
  name?: string;
  /** valor da tag building=* (house, residential, church, ...) */
  type: string;
  /** uso classificado (tags + POIs + zona de uso do solo) */
  category: BuildingCategory;
  levels: number;
  /** altura total em metros (paredes, sem telhado) */
  height: number;
  /** true quando altura veio de tag; false = gerada deterministicamente */
  heightFromTag: boolean;
  /**
   * true = prédio procedural (preenchimento de quadras sem prédios mapeados
   * no OSM). Id derivado do id OSM da rua + lado + índice — estável enquanto
   * a geometria da rua não mudar.
   */
  generated?: boolean;
  outer: Ring;
  holes?: Ring[];
  address?: Address;
  /** pontos de interesse (lojas, igrejas...) que caem dentro do prédio */
  pois?: Poi[];
  /** cor do telhado (hex), se informada no OSM */
  roofColour?: string;
  roofShape?: string;
  /** área do footprint em m² */
  area: number;
  centroid: Vec2;
}

export interface Address {
  street?: string;
  housenumber?: string;
  suburb?: string;
  postcode?: string;
  /** true = endereço inferido pela rua mais próxima */
  inferred?: boolean;
}

export interface Poi {
  osmId: number;
  name: string;
  category: string;
  value: string;
}

/**
 * Lote: unidade negociável do jogo futuro. Nesta etapa cada prédio OSM gera
 * um lote 1:1. O formato já prevê dono/preço para a camada econômica.
 */
export interface Lot {
  lotId: string;
  /** null = terreno vago (reservado, à venda no futuro) */
  buildingId: string | null;
  /** polígono do lote — presente em terrenos vagos */
  outer?: Ring;
  vacant?: boolean;
  area: number;
  centroid: Vec2;
  address?: Address;
  /** reservado para o futuro: dono, preço, zoneamento... */
  ownerId?: string | null;
  price?: number | null;
  zoning?: string;
}

export type WaterKind = 'river' | 'stream' | 'canal' | 'drain' | 'ditch' | 'water';

export interface WaterLine {
  id: string;
  name?: string;
  kind: WaterKind;
  width: number;
  points: Vec2[];
}

export interface WaterArea {
  id: string;
  name?: string;
  outer: Ring;
  holes?: Ring[];
}

export type GreenKind = 'park' | 'grass' | 'wood' | 'scrub' | 'garden' | 'pitch' | 'meadow' | 'cemetery';

export interface GreenArea {
  id: string;
  name?: string;
  kind: GreenKind;
  outer: Ring;
  holes?: Ring[];
}

export interface Railway {
  id: string;
  name?: string;
  points: Vec2[];
}

export interface Heightmap {
  /** número de amostras por lado (grade size x size) */
  size: number;
  /** distância entre amostras (m) */
  cellSize: number;
  /** canto mínimo (x, z) da grade */
  minX: number;
  minZ: number;
  /** alturas em decímetros relativas a origin.elevation, linha a linha (z), i = x */
  data: number[];
}

export interface CityData {
  version: number;
  name: string;
  generatedAt: string;
  attribution: string;
  origin: { lat: number; lon: number; elevation: number };
  /** área "jogável" com dados OSM completos */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** bbox geográfica consultada */
  bbox: { south: number; west: number; north: number; east: number };
  heightmap: Heightmap | null;
  streets: Street[];
  buildings: Building[];
  lots: Lot[];
  waterLines: WaterLine[];
  waterAreas: WaterArea[];
  greens: GreenArea[];
  railways: Railway[];
  /** zonas de uso do solo do OSM (landuse=*) */
  landuse: LandUse[];
}
