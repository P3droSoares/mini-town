import type { BuildingCategory, LandUseKind, Poi } from '../data/types';

/**
 * Classifica o uso de um prédio (pura, usada no pré-processamento).
 * Ordem: religioso > industrial > institucional > comercial (tags/POIs) >
 * zona de uso do solo > residencial.
 */
const RELIGIOUS = new Set(['church', 'cathedral', 'chapel', 'place_of_worship', 'temple', 'mosque']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'manufacture', 'factory', 'storage_tank', 'silo', 'hangar']);
const INSTITUTIONAL = new Set([
  'school',
  'university',
  'college',
  'kindergarten',
  'prep_school',
  'hospital',
  'clinic',
  'townhall',
  'public',
  'civic',
  'government',
  'police',
  'fire_station',
  'courthouse',
  'library',
  'post_office',
  'community_centre',
  'social_facility',
  'arts_centre',
  'bus_station',
  'train_station',
  'grandstand',
  'stadium',
]);
const COMMERCIAL = new Set([
  'commercial',
  'retail',
  'supermarket',
  'office',
  'kiosk',
  'hotel',
  'shop',
  'restaurant',
  'pub',
  'bar',
  'fast_food',
  'cafe',
  'bank',
  'pharmacy',
  'ice_cream',
  'cinema',
  'events_venue',
  'veterinary',
  'doctors',
  'dojo',
]);
const RESIDENTIAL = new Set(['house', 'residential', 'apartments', 'detached', 'terrace', 'semidetached_house', 'bungalow', 'dormitory']);

export function classifyBuilding(type: string, pois: Poi[] | undefined, landuse: LandUseKind | undefined): BuildingCategory {
  if (RELIGIOUS.has(type)) return 'religious';
  if (INDUSTRIAL.has(type)) return 'industrial';
  if (INSTITUTIONAL.has(type)) return 'institutional';
  if (COMMERCIAL.has(type)) return 'commercial';
  if (pois?.length) {
    const p = pois[0];
    if (RELIGIOUS.has(p.value)) return 'religious';
    if (INSTITUTIONAL.has(p.value)) return 'institutional';
    if (p.category === 'shop' || p.category === 'office' || COMMERCIAL.has(p.value)) return 'commercial';
  }
  if (RESIDENTIAL.has(type)) return 'residential';
  if (landuse === 'industrial') return 'industrial';
  if (landuse === 'commercial' || landuse === 'retail') return 'commercial';
  return 'residential';
}

export const ZONING_BY_CATEGORY: Record<BuildingCategory, string> = {
  residential: 'residencial',
  commercial: 'comercial',
  industrial: 'industrial',
  institutional: 'institucional',
  religious: 'institucional',
};
