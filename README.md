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

Abra http://localhost:5173. O JSON da cidade (`public/data/itabirito.json`) e as
texturas/HDRI CC0 (`public/assets/`, ~5 MB) já vêm versionados, então não é
preciso baixar nada para começar.

Outros scripts:

| comando | o que faz |
| --- | --- |
| `npm run fetch-osm` | baixa OSM (Overpass) + relevo e regenera `public/data/itabirito.json` |
| `npm run fetch-assets` | baixa texturas PBR + HDRI CC0 do Poly Haven, reduz para 512 px e gera `public/assets/manifest.json` |
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
| Minimapa | clique para ir até o ponto (na corrida: alterna zoom do GPS) | toque |
| **App de entregas** | `E` ou botão do saldo (topo) | botão do saldo |
| **Bicicleta / moto** | `F` sobe/desce · `W` acelera · `S` freia e dá ré · `A D` vira · `Espaço` freio · `Shift` embala | botão subir/descer · joystick: cima acelera, baixo freia, lados viram |
| Aceitar corrida | `Enter` ou botão no cartão | botão no cartão |
| `Esc` | fecha painel/menu | — |

O menu (☰ ou relógio) permite fixar/acelerar a hora, escolher a **qualidade gráfica**,
ligar o **efeito maquete (tilt-shift)**, desligar sombras, mostrar FPS e ajustar o
movimento nas ruas.

## Modo entregador (iFood)

Quem ainda não tem empresa pode trabalhar de entregador de app:

1. Abra o app (`E` ou o botão com o saldo, no topo). O jogador começa com **R$ 500**.
2. Compre a **bag térmica** (R$ 120) e um veículo: **bicicleta** (R$ 350, até 32 km/h)
   ou **moto** (R$ 1.500, até 60 km/h). O saldo inicial só dá para a bike: a moto vem
   com o dinheiro das entregas.
3. Ligue **Disponível**: o boneco vai para a rua montado, com a bag nas costas.
4. Chegam **ofertas de corrida** (restaurante → cliente, distância e valor) com 20 s
   para aceitar.
5. Aceitou: o **GPS** desenha o caminho com setas no chão, um feixe de luz marca o
   destino, um marcador na tela mostra a distância e o minimapa vira GPS (aproximado,
   girando com a câmera). Saiu da rota, ele recalcula.
6. **Pare na calçada** do restaurante para retirar e na do cliente para entregar.
   Pagamento: R$ 10 + R$ 30/km do trajeto, mais **gorjeta** se chegar rápido.

Detalhes:

- Restaurantes parceiros (24) são prédios comerciais escolhidos de forma determinística;
  o nome aparece no letreiro e no painel do prédio. Clientes são prédios residenciais.
- Rotas: A* no grafo viário (`src/world/routing.ts`), respeitando mão única.
- Física arcade: aceleração/freio, esterço sensível à velocidade, inclinação nas curvas,
  ladeira pesa mais na bike, colisão com prédios e carros (os carros freiam atrás do
  jogador). Moto acende farol à noite.
- Durante a corrida não há teletransporte (minimapa, busca, "andar até aqui"); a câmera
  de cidade continua liberada e, ao voltar, o jogador está onde parou.
- Saldo, itens e estatísticas ficam no navegador (`localStorage`). Para testar no
  console: `profile.add(2000_00)` (centavos) ou `profile.reset()`.
- Preços e pagamento em `src/economy/catalog.ts` (inclui `DELIVERY_APP`, o nome do app).

## Visual (realista, estilo city builder)

**Materiais**: atlas de 14 texturas PBR CC0 (reboco, tijolo vermelho e amarelo,
concreto, painéis pré-moldados, revestimento cerâmico, chapa metálica, madeira,
telhas cerâmica/cinza/ardósia, laje, telha metálica, piso) num único
`DataArrayTexture`: cada vértice escolhe a camada, então **um material/uma draw
call** cobre todos os prédios do chunk. Normal maps por derivadas (sem tangentes).

**Janelas com interior falso** (*interior mapping*): atrás do vidro há um cômodo
com paralaxe real — paredes, piso, teto, quadro/sofá e persianas variando por
janela; à noite parte dos cômodos acende. Nenhuma geometria extra.

**Arquétipos** (`Building.category` vem do pré-processamento: tags OSM, POIs e
`landuse`). Cada tipo varia material, cor, telhado, número de vãos e peças:

| uso | arquétipos |
| --- | --- |
| Residencial | casa colonial mineira (reboco pastel, telha cerâmica, venezianas, barrado) · casa moderna (laje, platibanda, janelões) · sobrado de tijolo (verga de pedra, ardósia, chaminé) · casa térrea simples · prédio baixo · bloco de apartamentos tipo BNH (painéis, sacadas em grade) · edifício de tijolo (cornija) · edifício moderno (revestimento, sacadas de vidro) |
| Comercial | sobrado comercial de tijolo e loja de rua (vitrines, toldos lisos/listrados, **letreiro com o nome real do estabelecimento**) · supermercado/loja grande (fachada cega, letreiro grande, telha metálica, dutos) · edifício de escritórios (cortina de vidro, embasamento) |
| Industrial | galpão metálico · fábrica de tijolo (dente-de-serra, chaminé, tanques, marquise de carga) |
| Institucional / religioso | prédio público com mastro · igreja barroca |

**Volumes e detalhes geométricos** (menos "caixas"): molduras de janela com
peitoril e cimalha em geometria instanciada (só nos quarteirões perto da câmera),
cunhais e cornija nas casas coloniais, casas térreas com **varanda recortada** no
volume e colunas, cumeeira e calhas nos telhados, pilastras nos prédios de tijolo,
marquise de embasamento e **cobertura recuada** nas torres, torres modernas com
**cantos arredondados**.

**Luz e céu**: céu físico (Preetham — espalhamento Rayleigh/Mie) com **nuvens
procedurais** que se movem com o vento, estrelas e lua; a **iluminação de
ambiente é gerada do próprio céu** (muda com a hora e as nuvens); sombras
**PCSS** (penumbra que cresce com a distância, como em ray tracing), oclusão de
ambiente (N8AO), **raios de sol** (god rays), bloom, tone mapping AgX e gradação.

**Outdoors** em coberturas de comércio e torres; letreiros e outdoors acendem à noite.

**Lotes com quintal** (~1.700): o preenchimento procedural gera lotes mais fundos
que a casa; o quintal ganha **muro** nas divisas, **mureta com portão** na frente,
grama ou piso e, em parte deles, **piscina** e árvore. Árvores de rua e de
terreno livre não invadem lotes (nem os ~290 **terrenos vagos reservados**).

| qualidade | para | o que muda |
| --- | --- | --- |
| Alta | GPU dedicada | sombras PCSS, SSAO, god rays, bloom, LOD a 700 m |
| Média | GPU integrada / celular bom | god rays + bloom, sombras PCF suaves, LOD a 380 m |
| Baixa | celular simples | sem pós-processamento, sombras 1024, menos árvores/NPCs |

"Automática" escolhe pela GPU (dedicada = alta; integrada Intel/AMD/celular = média ou baixa). Em tempo real, a **resolução dinâmica**
reduz o pixel ratio se o frame passar de ~21 ms; se ainda assim ficar lento, a
**qualidade adaptativa** desliga SSAO e depois bloom.

## Estilo low-poly (branch `estilo-lowpoly`)

`LOWPOLY` em `src/world/render/style.ts` troca o visual inteiro para estilizado:

- prédios com a **cor média** de cada material (tijolo, telha, concreto...) em vez da textura, sombreamento facetado, vidro chapado que acende à noite, sem sujeira nem interior mapping;
- ruas, calçadas, gramados e terreno só com cor de vértice, facetados;
- árvores geométricas (icosaedros deformados, cones nas palmeiras), cor por instância, copa opaca projetando a própria sombra;
- verdes mais vivos e pós-processamento sem dessaturação.

`LOWPOLY = false` volta ao visual realista.

## Stack

- **Vite + TypeScript + Three.js** puro (sem framework de UI no loop de render — a UI é DOM
  leve e o 3D não paga custo de reconciliação).
- **three-mesh-bvh** para raycast rápido (hover/clique e colisão da câmera).
- **n8ao** (+ `postprocessing`) para oclusão de ambiente em tela.
- Pré-processamento em Node com **tsx** + **pngjs** (decodificação dos tiles de relevo).

## Arquitetura

```
scripts/
  fetch-osm.ts        Overpass + tiles Terrarium -> CityData (JSON estático)
  fetch-assets.ts     texturas PBR + HDRI CC0 (Poly Haven) -> public/assets
  infill.ts           preenchimento procedural de quadras (lotes com id estável)
src/
  data/               contrato de dados (types.ts) e WorldSource (JSON hoje, servidor amanhã)
  world/              WorldState (estado puro), HeightField, RoadGraph, geo
    CityView.ts       renderização por chunks (merge + LOD + culling)
    render/           geometria de prédios/ruas/áreas/terreno, materiais, céu, postes, árvores
    routing.ts        rotas (A*) e progresso ao longo da rota (GPS)
  entities/           Player (a pé e montado), vehicles (bike/moto/bag + física), geometrias de NPC
  economy/            PlayerProfile (saldo/itens), catálogo/preços, restaurantes e clientes
  systems/            TimeSystem, DayNightSystem, TrafficSystem, SelectionSystem, DeliverySystem
  core/               Game (loop), câmeras, Input, PostFX (SSAO/bloom/tilt-shift), quality
  ui/                 HUD, painel do lote, minimapa/GPS, busca, menu, joystick, loading, app de entregas
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

- Prédios em **uma geometria por chunk de 250 m e por material** (escrita direta
  num buffer único — mesmo efeito de `mergeGeometries`, sem cópias), com **LOD**
  (telhados simplificados) e frustum culling por chunk.
- Árvores, postes, carros e pedestres em **InstancedMesh**; NPCs inativos não são
  desenhados (instâncias compactadas por frame).
- Árvores: LOD por célula (cartões perto, impostores de 6 triângulos longe) e
  sombra da copa por proxy simples numa layer só da câmera de sombra.
- Janelas e luzes noturnas são feitas no shader (atributo de fachada) — nenhuma luz real.
- Sombras: uma luz direcional cuja câmera de sombra segue o foco (mais nítida no modo a pé);
  com a câmera parada o mapa de sombra atualiza a 30 Hz.
- Celular: mapa de sombra menor, sem MSAA, pixel ratio ≤ 1,5, menos árvores e NPCs.
- Carregamento progressivo com barra; a construção cede a thread entre fatias de ~40 ms.

Medido na máquina de desenvolvimento (GPU do navegador embutido, 1600×900): qualidade
alta ~14 ms/frame com sombras estáticas e ~24 ms quando o mapa de sombra atualiza;
a resolução dinâmica compensa em GPUs mais fracas.

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
- Texturas PBR e HDRI: **[Poly Haven](https://polyhaven.com)** — CC0 (domínio público);
  lista e autores em `public/assets/manifest.json`.
- Relevo: tiles **Terrarium** (Mapzen / Tilezen, via AWS Open Data), derivados de
  SRTM (NASA) e outras fontes — ver
  [atribuições do joerd](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- Prédios sem mapeamento no OSM são gerados proceduralmente e marcados como
  `generated: true` / "procedural" no painel.
- Código: definir a licença do projeto (ex.: MIT) antes de publicar.

## Próximos passos (fora do escopo deste módulo)

- Camada econômica: compra/venda de lotes usando `lotId`, preços por zoneamento.
- Trabalhar na própria empresa: entregas do seu restaurante, coleta de lixo, entregas
  do supermercado (o `DeliverySystem` já separa oferta/rota/retirada/entrega).
- Servidor: `ServerWorldSource`, autenticação e sincronização de jogador/NPCs.
- Construção da geometria em Web Worker para áreas maiores.
