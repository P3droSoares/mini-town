# Itabirito em Miniatura

Cidade 3D explorável no navegador baseada em **Itabirito – MG**, gerada a partir do
OpenStreetMap e de dados de relevo abertos. É o **módulo 1** de um futuro jogo
multiplayer de economia/simulação — nesta etapa só existe a cidade (sem economia,
login ou multiplayer), mas a arquitetura já separa estado do mundo e renderização.

## Como rodar

Requisitos: Node 20+ (testado com Node 24).

```bash
npm install
npm run dev
```

Abra http://localhost:5173. O JSON da cidade já vem versionado em
`public/data/itabirito.json`, então não é preciso baixar nada para começar.

Outros scripts:

| comando | o que faz |
| --- | --- |
| `npm run fetch-osm` | baixa OSM (Overpass) + relevo e regenera `public/data/itabirito.json` |
| `npm run build` | typecheck + build de produção em `dist/` |
| `npm run preview` | serve o build de produção |
| `npm run typecheck` | só o TypeScript |

## Controles

| | desktop | celular |
| --- | --- | --- |
| **Câmera de cidade** (padrão) | arrastar = mover · botão direito = girar · roda = zoom · setas = mover | 1 dedo move · 2 dedos giram/pinça |
| **Andar a pé** | `W A S D` · `Shift` corre · arrastar = olhar · roda = distância | joystick virtual · botão correr · arrastar olha · pinça |
| Alternar modo | `C` ou botão no canto | botão no canto |
| Buscar rua | `/` foca a busca | campo no topo |
| Prédio | passar o mouse destaca · clique abre o painel | toque abre o painel |
| Minimapa | clique para ir até o ponto | toque |
| `Esc` | fecha painel/menu | — |

O menu (☰ ou relógio) permite fixar/acelerar a hora, ligar o **efeito maquete
(tilt-shift)**, desligar sombras, mostrar FPS e ajustar o movimento nas ruas.

## Stack

- **Vite + TypeScript + Three.js** puro (sem framework de UI no loop de render — a UI é DOM
  leve e o 3D não paga custo de reconciliação).
- **three-mesh-bvh** para raycast rápido (hover/clique e colisão da câmera).
- Pré-processamento em Node com **tsx** + **pngjs** (decodificação dos tiles de relevo).

## Arquitetura

```
scripts/
  fetch-osm.ts        Overpass + tiles Terrarium -> CityData (JSON estático)
  infill.ts           preenchimento procedural de quadras (lotes com id estável)
src/
  data/               contrato de dados (types.ts) e WorldSource (JSON hoje, servidor amanhã)
  world/              WorldState (estado puro), HeightField, RoadGraph, geo
    CityView.ts       renderização por chunks (merge + LOD + culling)
    render/           geometria de prédios/ruas/áreas/terreno, materiais, céu, postes, árvores
  entities/           Player, geometrias de NPC
  systems/            TimeSystem, DayNightSystem, TrafficSystem, SelectionSystem
  core/               Game (loop), câmeras (cidade / a pé), Input, PostFX (tilt-shift)
  ui/                 HUD, painel do lote, minimapa, busca, menu, joystick, loading
```

Princípios:

- **Estado ≠ renderização.** `WorldState` não importa Three.js; `CityView` só lê o
  estado. NPCs e jogador têm estado puro (posição/aresta/velocidade) que um servidor
  poderá sincronizar.
- **IDs estáveis.** Cada prédio tem `id` (`way/<osmId>`, `relation/<osmId>`) e
  `lotId` (`ITB-W<osmId>`, `ITB-R<osmId>`). Prédios procedurais usam o id OSM da
  rua + lado + índice (`ITB-G<wayId>-D3`). O `Lot` já tem `ownerId`, `price` e
  `zoning` reservados para a compra de imóveis.
- **`WorldSource`** abstrai a origem dos dados: troque `StaticJsonWorldSource` por
  uma implementação que busca `CityData` de uma API.

### Desempenho

- Prédios fundidos por chunk de 250 m (`BufferGeometryUtils.mergeGeometries`),
  com **LOD** (telhados simplificados a partir de 650 m) e frustum culling por chunk.
- Árvores, postes, carros e pedestres em **InstancedMesh**.
- Janelas e luzes noturnas são feitas no shader (atributo de fachada) — nenhuma luz real.
- Sombras: uma luz direcional cuja câmera de sombra segue o foco (mais nítida no modo a pé).
- Celular: mapa de sombra menor, sem MSAA, pixel ratio ≤ 1,5, menos árvores e NPCs.
- Carregamento progressivo com barra; a construção cede a thread entre fatias de ~40 ms.

Na máquina de desenvolvimento: ~60 draw calls e ~270 mil triângulos na vista padrão.

## Como expandir a área do mapa

O script aceita parâmetros:

```bash
# centro e tamanho (lado do quadrado com dados OSM, em metros)
npm run fetch-osm -- --lat -20.253 --lon -43.803 --size 2500

# borda extra de relevo (escondida pela névoa) e resolução do relevo
npm run fetch-osm -- --size 2500 --margin 600 --cell 10

# outra cidade / outro arquivo
npm run fetch-osm -- --name "Ouro Preto" --lat -20.3856 --lon -43.5035 --out public/data/ouro-preto.json

# ignorar o cache local (.cache/) e baixar de novo
npm run fetch-osm -- --refresh

# sem relevo (plano) ou sem prédios procedurais
npm run fetch-osm -- --no-terrain --no-infill
```

Dicas:

- Áreas maiores que ~3 km aumentam o JSON e o tempo de carga; nesse caso vale dividir
  em vários arquivos por região e carregar chunks sob demanda (o `CityView` já é
  organizado por chunk).
- Se usar outro arquivo, troque a URL em `src/main.ts` (`StaticJsonWorldSource`).
- A Overpass pública tem limites de uso; o script tenta 3 servidores e guarda cache em `.cache/`.
- Prédios mapeados no OSM sempre têm prioridade; o preenchimento procedural só ocupa
  espaço livre ao longo das ruas. Se o OSM ganhar prédios novos numa quadra, os lotes
  procedurais dali deixam de existir na próxima geração.

## Créditos e licença

- Dados do mapa: **© OpenStreetMap contributors**, disponíveis sob a
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright).
  O arquivo `public/data/itabirito.json` é um banco de dados derivado do OSM e,
  portanto, também está sob a ODbL.
- Relevo: tiles **Terrarium** (Mapzen / Tilezen, via AWS Open Data), derivados de
  SRTM (NASA) e outras fontes — ver
  [atribuições do joerd](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- Prédios sem mapeamento no OSM são gerados proceduralmente e marcados como
  `generated: true` / "procedural" no painel.
- Código: definir a licença do projeto (ex.: MIT) antes de publicar.

## Próximos passos (fora do escopo deste módulo)

- Camada econômica: compra/venda de lotes usando `lotId`, preços por zoneamento.
- Servidor: `ServerWorldSource`, autenticação e sincronização de jogador/NPCs.
- Construção da geometria em Web Worker para áreas maiores.
