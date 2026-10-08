import type { Building, Vec2 } from '../data/types';
import { hashId, mulberry32 } from '../world/geo';
import type { Router } from '../world/routing';
import type { WorldState } from '../world/WorldState';

/** Endereço de coleta/entrega: o prédio, a calçada em frente e o ponto na rua. */
export interface Place {
  building: Building;
  /** calçada em frente ao prédio (marcador) */
  spot: Vec2;
  /** ponto na rua (fim da rota) */
  road: Vec2;
  address: string;
}

export type Cuisine =
  | 'pizza'
  | 'burger'
  | 'japonesa'
  | 'marmita'
  | 'lanche'
  | 'acai'
  | 'padaria'
  | 'arabe'
  | 'mexicana'
  | 'saudavel'
  | 'frango'
  | 'italiana'
  | 'churrasco';

export interface Restaurant extends Place {
  name: string;
  cuisine: Cuisine;
}

const RESTAURANTS: [string, Cuisine][] = [
  ['Pizzaria Bella Aurora', 'pizza'],
  ['Smash da Praça', 'burger'],
  ['Sushi Kaze', 'japonesa'],
  ['Marmitaria da Vó Lurdes', 'marmita'],
  ['Pastelaria do Largo', 'lanche'],
  ['Açaí da Orla', 'acai'],
  ['Padaria Pão da Aurora', 'padaria'],
  ['Esfiharia Damasco', 'arabe'],
  ['Tacos El Sol', 'mexicana'],
  ['Poke Ilha', 'saudavel'],
  ['Frango Assado do Tião', 'frango'],
  ['Cantina Gran Via', 'italiana'],
  ['Burger do Prado', 'burger'],
  ['Sabor de Minas', 'marmita'],
  ['Temakeria Sakura', 'japonesa'],
  ['Churrasquinho do Zé', 'churrasco'],
  ['Forno a Lenha Nonna', 'pizza'],
  ['Tapiocaria Nordeste', 'lanche'],
  ['Doceria Brigadeiro', 'padaria'],
  ['Vegano Raiz', 'saudavel'],
  ['Hamburgueria Brasa', 'burger'],
  ['Cozinha da Tia Cida', 'marmita'],
  ['Lanchonete Esquina', 'lanche'],
  ['Sorveteria Polar', 'acai'],
];

const MENU: Record<Cuisine, string[]> = {
  pizza: ['Pizza grande de calabresa', 'Pizza de muçarela', 'Pizza meia frango, meia catupiry', 'Pizza portuguesa', 'Refrigerante 2 L'],
  burger: ['X-Burger', 'X-Bacon', 'Smash duplo', 'Batata frita grande', 'Milk-shake'],
  japonesa: ['Combinado 20 peças', 'Temaki de salmão', 'Hot roll', 'Yakisoba'],
  marmita: ['Marmitex de frango', 'Feijoada', 'Marmitex de carne', 'Tropeiro'],
  lanche: ['Pastel de carne', 'Pastel de queijo', 'Coxinha', 'Caldo de cana', 'Tapioca de queijo'],
  acai: ['Açaí 500 ml', 'Açaí 700 ml com granola', 'Sorvete de pote'],
  padaria: ['Pão de queijo (10 un.)', 'Bolo de cenoura', 'Café com leite', 'Sanduíche natural', 'Brigadeiros (12 un.)'],
  arabe: ['Esfirra de carne', 'Esfirra de queijo', 'Kibe', 'Beirute'],
  mexicana: ['Tacos de carne', 'Burrito', 'Nachos'],
  saudavel: ['Poke de salmão', 'Bowl vegano', 'Suco verde', 'Salada caesar'],
  frango: ['Frango assado inteiro', 'Meio frango com farofa', 'Maionese'],
  italiana: ['Lasanha à bolonhesa', 'Nhoque', 'Espaguete ao sugo'],
  churrasco: ['Espetinho de carne', 'Espetinho de frango', 'Pão de alho'],
};

/** rótulo do POI (painel do prédio) por tipo de cozinha */
const POI_VALUE: Record<Cuisine, string> = {
  pizza: 'restaurant',
  burger: 'fast_food',
  japonesa: 'restaurant',
  marmita: 'restaurant',
  lanche: 'fast_food',
  acai: 'ice_cream',
  padaria: 'bakery',
  arabe: 'fast_food',
  mexicana: 'restaurant',
  saudavel: 'restaurant',
  frango: 'restaurant',
  italiana: 'restaurant',
  churrasco: 'restaurant',
};

const FIRST = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Karina', 'Lucas', 'Mariana', 'Nathan', 'Olívia', 'Paulo', 'Rafaela', 'Samuel', 'Tatiane', 'Vinícius', 'Letícia', 'Matheus', 'Júlia', 'Pedro', 'Camila', 'Thiago'];

export function customerName(rng: () => number): string {
  const first = FIRST[Math.floor(rng() * FIRST.length)];
  return `${first} ${'ABCDFGLMNPRST'[Math.floor(rng() * 13)]}.`;
}

/** 1 a 3 itens com quantidade: "2x X-Bacon, 1x Batata frita grande" */
export function orderItems(c: Cuisine, rng: () => number): string {
  const menu = [...MENU[c]];
  const n = 1 + Math.floor(rng() * Math.min(3, menu.length));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const [item] = menu.splice(Math.floor(rng() * menu.length), 1);
    out.push(`${rng() < 0.7 ? 1 : 2}x ${item}`);
  }
  return out.join(', ');
}

export function addressOf(b: Building): string {
  const a = b.address;
  if (!a?.street) return 'Endereço sem nome';
  return a.housenumber ? `${a.street}, ${a.housenumber}` : a.street;
}

/** frente do prédio na rua transitável mais próxima (null se longe de rua) */
export function frontOf(world: WorldState, router: Router, b: Building): Place | null {
  const [cx, cz] = b.centroid;
  const hit = router.nearest(cx, cz);
  if (!hit || hit.d2 > 50 * 50) return null;
  let dx = cx - hit.x;
  let dz = cz - hit.z;
  const l = Math.hypot(dx, dz);
  if (l < 1) return null;
  dx /= l;
  dz /= l;
  // meio da calçada do lado do prédio
  const off = hit.edge.street.width / 2 + 1.2;
  const spot: Vec2 = [hit.x + dx * off, hit.z + dz * off];
  if (world.buildingAt(spot[0], spot[1])) return null;
  return { building: b, spot, road: [hit.x, hit.z], address: addressOf(b) };
}

/**
 * Escolhe (de forma determinística) prédios comerciais espalhados para
 * virar restaurantes parceiros do app e dá nome a eles — o nome aparece no
 * letreiro e no painel do prédio. Chamar antes de montar a cena (`game.init`).
 * No jogo com servidor, restaurantes serão empresas de jogadores/NPCs.
 */
export function setupRestaurants(world: WorldState, router: Router, minSpacing = 90): Restaurant[] {
  const commercial = world.data.buildings
    .filter((b) => b.category === 'commercial' && b.address?.street && !b.name && !b.pois?.length)
    .map((b) => ({ b, k: hashId(b.osmId * 7919 + 13) }))
    .sort((a, b) => a.k - b.k);
  const out: Restaurant[] = [];
  for (const { b } of commercial) {
    if (out.length >= RESTAURANTS.length) break;
    if (out.some((r) => Math.hypot(r.building.centroid[0] - b.centroid[0], r.building.centroid[1] - b.centroid[1]) < minSpacing)) continue;
    const place = frontOf(world, router, b);
    if (!place) continue;
    const [name, cuisine] = RESTAURANTS[out.length];
    b.name = name;
    b.pois = [{ osmId: 0, name, category: 'amenity', value: POI_VALUE[cuisine] }];
    out.push({ ...place, name, cuisine });
  }
  return out;
}

/** prédios residenciais (clientes), em ordem embaralhada estável */
export function residentialBuildings(world: WorldState): Building[] {
  const rng = mulberry32(2024);
  const list = world.data.buildings.filter((b) => b.category === 'residential' && b.address?.street);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
