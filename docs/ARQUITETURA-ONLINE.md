# Itabirito Online — contrato de arquitetura (v1)

Documento-contrato entre frontend, backend e infraestrutura. Toda decisão aqui
é obrigatória; desvios precisam ser registrados na seção "Decisões" no final.

## 1. Visão geral

```
navegador ──HTTPS/WSS──> caddy (TLS, :8443) ──┬─ /api/*  ──> server (Fastify, :3000)
                                              └─ /*      ──> web (Vite dev + HMR, :5173)
server ──TLS (sslmode=verify-full)──> db (PostgreSQL 17)
```

- Tudo roda em Docker (`docker compose up`). Hot reload: Vite HMR no front,
  `tsx watch` (polling, por causa de bind mount no Windows) no back.
- Único ponto exposto ao host: `https://localhost:8443` (Caddy, `tls internal`).
  Postgres e server **não** publicam portas no host.
- Front (`src/`) continua Vite + TS + Three.js. Back em `server/` (pacote
  separado, próprio `package.json`, `tsconfig.json`).

## 2. Princípios de segurança (inegociáveis)

1. **Servidor é a única autoridade.** O cliente só envia *intenções* (`lotId`,
   `listingId`, valor pedido numa venda, chave de idempotência). Preço, saldo,
   dono, renda, impostos, horário: sempre calculados no servidor. Nunca aceitar
   `price`, `ownerId`, `balance`, `userId` do cliente.
2. **Validação estrita** de toda entrada com `zod` (`.strict()`): tipos,
   tamanhos, regex de `lotId` (`^ITB-[A-Z0-9-]{1,40}$`), inteiros em centavos
   (`z.number().int().positive().max(...)`) — nunca float para dinheiro.
   Body limit 16 KB. Rejeitar campos extras.
3. **Dinheiro**: `BIGINT` em centavos. Razão contábil de **partidas dobradas**
   (`ledger_entries`): toda movimentação é uma transação com lançamentos que
   somam zero. Saldos em `accounts.balance` (cache) atualizados na mesma
   transação SQL; `CHECK (balance >= 0)` para contas de jogador. Trigger
   impede `UPDATE`/`DELETE` em `ledger_entries` (append-only).
4. **Concorrência**: toda operação econômica numa transação com
   `SELECT ... FOR UPDATE` em ordem determinística (ids crescentes) sobre as
   linhas envolvidas (contas, imóvel, anúncio). Unicidade por
   `UNIQUE(user_id, idempotency_key)`. Repetir a mesma chave devolve o mesmo
   resultado, sem cobrar de novo. Testes de corrida obrigatórios (50 compras
   simultâneas do mesmo imóvel = 1 sucesso; 50 gastos simultâneos = saldo
   nunca negativo; replay = sem duplicação).
5. **Autenticação**:
   - senha: argon2id (`@node-rs/argon2`, m=19456 KiB, t=2, p=1 no mínimo),
     mínimo 10 caracteres, máx 128, checagem contra lista local de senhas
     comuns; pepper opcional via HMAC com chave do ambiente.
   - sessão: token aleatório de 32 bytes (`crypto.randomBytes`), guardado no
     banco **só como SHA-256**; cookie `__Host-sid` `HttpOnly; Secure;
     SameSite=Strict; Path=/`. Expira por inatividade (30 min) e absoluto (7 d).
     Rotação no login; logout invalida no servidor; "sair de todos".
   - CSRF: todo método não-GET exige header `X-CSRF-Token` igual ao token
     CSRF da sessão (HMAC do id da sessão, entregue em `GET /api/auth/me`
     e no login) **e** `Origin` igual à origem configurada.
   - brute force: limite por IP e por conta (backoff exponencial, bloqueio
     temporário), resposta com tempo constante; mensagens genéricas
     ("usuário ou senha inválidos") — sem enumeração de contas/e-mails.
6. **Criptografia em repouso**: e-mail cifrado com AES-256-GCM (IV aleatório
   de 12 bytes, tag, versão de chave) + `email_hash` = HMAC-SHA256 normalizado
   para unicidade/busca. Chaves vêm de variáveis de ambiente (`.env`, nunca
   versionado; `scripts/gen-secrets` cria para dev). IP em logs/auditoria
   guardado como HMAC, não em claro.
   **Em trânsito**: HTTPS no Caddy, HSTS, TLS entre server e Postgres.
7. **Isolamento entre jogadores**: nenhum endpoint recebe `userId`; o usuário
   vem da sessão. Dados de outros jogadores expostos: apenas `displayName`
   público (e patrimônio no ranking). Nunca e-mail, saldo exato de terceiros
   (ranking mostra patrimônio arredondado), histórico, sessões, IPs.
   Testes de IDOR obrigatórios.
8. **Postgres com mínimo privilégio**: papel `app` (DML só nas tabelas
   necessárias, sem DDL, sem `DELETE` em ledger/auditoria) separado do papel
   dono das migrações. `scram-sha-256`. Consultas 100% parametrizadas.
9. **Cabeçalhos**: CSP restritiva (dev permite o necessário ao HMR do Vite),
   `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
   `Cross-Origin-Opener-Policy`, `frame-ancestors 'none'`. Sem stack trace
   em resposta; erros com `{ error: { code, message } }`.
10. **Auditoria e invariantes**: tabela `audit_log` (append-only) para login,
    falhas, compras, vendas, mudanças de senha. Job periódico verifica:
    soma do ledger por transação = 0; `accounts.balance` = soma dos
    lançamentos; massa monetária total = emissão registrada. Divergência =
    log de alarme e trava de operações econômicas (modo manutenção).
11. **Rate limit** por usuário e por IP em todas as rotas (mais rígido em
    auth e em economia). Limite de criação de contas por IP.

## 3. Economia (servidor)

Moeda: **Real de Itabirito (I$)**, centavos inteiros.

### Catálogo de imóveis
- No boot, o server lê `public/data/itabirito.json` (montado só-leitura) e
  sincroniza a tabela `properties` (idempotente): `lot_id`, `building_id`,
  categoria (`residential|commercial|industrial|institutional|religious|vacant`),
  área, andares, endereço, distância ao centro.
- **Preço base** (avaliação) determinístico, no servidor:
  `area_construida = area * max(1, levels)`;
  `base = area_construida * valor_m2[categoria] * fator_localizacao * fator_tamanho`.
  `fator_localizacao` cai com a distância ao centro (praça/igreja matriz —
  usar o centróide dos imóveis comerciais). Terreno vago: `area * valor_m2_terreno`.
  Institucional e religioso **não são vendáveis**.
- **Índice de mercado** por categoria (começa 1.0), ajustado pela demanda
  (compras/vendas recentes), limitado a [0.6, 1.8] e com variação máxima
  por hora. Preço de compra ao governo = `base * indice`.

### Fluxos
- **Conta nova**: recebe I$ 30.000 (emissão do Tesouro, lançada no ledger).
- **Casa inicial** (uma vez por conta, `UNIQUE`): lista de casas
  residenciais com preço ≤ teto; subsídio de 80% pago pelo Tesouro; o
  jogador paga o resto. Escolha no servidor validada (elegível, sem dono).
- **Comprar do governo** (mercado primário): imóvel sem dono, vendável.
- **Vender ao governo**: recebe 70% da avaliação atual (sumidouro).
- **Mercado entre jogadores**: anunciar imóvel próprio com preço entre 50% e
  300% da avaliação (impede lavagem entre contas); comprador paga, vendedor
  recebe menos taxa de 5% (sumidouro). Cancelar anúncio. Imóvel anunciado
  não pode ser vendido ao governo.
- **Renda**: residencial alugado gera aluguel; comercial gera receita de
  negócio; industrial gera produção. Renda por hora real =
  `avaliação * taxa_categoria`. Acumulada **preguiçosamente** pelo
  servidor (`last_collected_at`), coletada pelo jogador, acúmulo máximo de
  24 h (incentiva voltar ao jogo, limita abuso). A casa onde o jogador mora
  (a inicial, ou outra marcada como residência) não gera aluguel.
- **IPTU**: 0,5%/dia da avaliação, cobrado na coleta (sumidouro).
- **Negócios**: imóvel comercial pode ser "aberto" como negócio de um tipo
  (mercado, padaria, loja, escritório, restaurante) com custo de abertura;
  tipo multiplica a receita conforme a concorrência no raio de 300 m
  (muitos do mesmo tipo = menos receita). Upgrade de nível (1–5) com custo
  crescente.
- **Patrimônio** = saldo + soma das avaliações dos imóveis.
- **Ranking** público por patrimônio (top 50, valores arredondados a I$ 1.000).

Todas as constantes num único arquivo `server/src/economy/config.ts`.

## 4. API (JSON, prefixo `/api`, cookies de sessão)

Erros: HTTP adequado + `{ "error": { "code": "STRING", "message": "pt-BR" } }`.
Todas as rotas não-GET exigem `X-CSRF-Token` e `Origin` válido.
Operações econômicas exigem header `Idempotency-Key` (UUID v4).
Valores monetários sempre `string` de inteiro em centavos (ex.: `"3000000"`)
para não perder precisão no JS.

| método | rota | corpo | resposta |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ ok: true }` |
| POST | `/api/auth/register` | `{ displayName, email, password }` | `{ user, csrfToken }` + cookie |
| POST | `/api/auth/login` | `{ email, password }` | `{ user, csrfToken }` + cookie |
| POST | `/api/auth/logout` | — | `204` |
| POST | `/api/auth/logout-all` | — | `204` |
| GET | `/api/auth/me` | — | `{ user, csrfToken }` ou 401 |
| POST | `/api/auth/password` | `{ currentPassword, newPassword }` | `204` (revoga outras sessões) |
| GET | `/api/me/wallet` | — | `{ balance, netWorth, pendingIncome, starterAvailable }` |
| GET | `/api/me/properties` | — | `{ properties: PropertyView[] }` |
| GET | `/api/me/transactions?cursor=` | — | `{ items: TxView[], nextCursor }` |
| GET | `/api/properties/:lotId` | — | `PropertyView` |
| GET | `/api/properties/ownership` | — | `{ owned: lotId[], mine: lotId[], listed: lotId[] }` |
| GET | `/api/starter-homes` | — | `{ homes: PropertyView[] }` (amostra próxima do centro, ≤ 30) |
| POST | `/api/starter-homes/claim` | `{ lotId }` | `{ property, wallet }` |
| POST | `/api/properties/:lotId/buy` | — | `{ property, wallet }` (do governo) |
| POST | `/api/properties/:lotId/sell-to-city` | — | `{ wallet }` |
| POST | `/api/properties/:lotId/residence` | — | `{ property }` |
| POST | `/api/properties/:lotId/business` | `{ type }` | `{ property, wallet }` |
| POST | `/api/properties/:lotId/business/upgrade` | — | `{ property, wallet }` |
| POST | `/api/income/collect` | — | `{ collected, tax, wallet }` |
| GET | `/api/market/listings?category=&cursor=` | — | `{ items: ListingView[], nextCursor }` |
| POST | `/api/market/listings` | `{ lotId, askPrice }` | `ListingView` |
| DELETE | `/api/market/listings/:id` | — | `204` |
| POST | `/api/market/listings/:id/buy` | — | `{ property, wallet }` |
| GET | `/api/market/overview` | — | `{ indices, recentSales, stats }` |
| GET | `/api/leaderboard` | — | `{ items: [{ rank, displayName, netWorth }] }` |

`user` = `{ id, displayName, createdAt }` (id opaco UUID; nunca e-mail fora de `/me`).
`PropertyView` = `{ lotId, category, area, levels, address, appraisal,
cityPrice|null, buyable, owner: { displayName }|null, mine, isResidence,
business: { type, level }|null, listing: { id, askPrice }|null, incomePerHour }`.

## 5. Banco (PostgreSQL)

Migrações SQL numeradas em `server/migrations/NNN_nome.sql`, aplicadas por
migrador próprio no boot do server (papel dono), com tabela
`schema_migrations` e checksum. Tabelas mínimas: `users`, `sessions`,
`login_attempts`, `accounts` (jogador e sistema: TESOURO, IMPOSTOS, TAXAS,
GOVERNO), `ledger_transactions`, `ledger_entries`, `properties`,
`businesses`, `listings`, `idempotency_keys`, `market_indices`,
`audit_log`. Chaves estrangeiras, `CHECK`s, índices nas consultas quentes.

## 6. Frontend

- `src/net/api.ts`: cliente tipado (`fetch` com `credentials: 'same-origin'`,
  CSRF e `Idempotency-Key` automáticos, tratamento de 401 → tela de login).
- Tela de conta (entrar/criar conta) antes do jogo carregar o mapa — ou em
  sobreposição enquanto o mapa carrega. Sem guardar senha/token em
  `localStorage`; o cookie HttpOnly é a sessão.
- HUD: saldo, patrimônio, botão coletar renda (com valor pendente), botão
  "Mercado". Painel do imóvel: avaliação, preço, dono, renda/h, ações
  (comprar, vender, anunciar, abrir negócio, morar aqui).
- Painel do mercado (abas): Casa inicial · À venda · Meus imóveis ·
  Extrato · Ranking · Índices.
- Imóveis próprios destacados no mapa (amarelo `MONO_LIGHT`) e no minimapa,
  sem custo extra de draw call relevante (atributo/instância, não material por prédio).
- **Estilo da UI = monocromático do jogo**: base `#2f3246` e seus tons
  (claros e escuros), acento único amarelo `#ffc04a`. Sem outras cores
  (exceto estados de erro, que usam o amarelo + ícone/texto, não vermelho).
  Tipografia e componentes coerentes; contraste AA.
- Todo texto vindo do servidor inserido com `textContent` (nunca `innerHTML`).

## 7. Docker

`docker-compose.yml` (dev) com serviços `caddy`, `web`, `server`, `db`.
Bind mount do código; `node_modules` em volume nomeado; polling para
watchers no Windows; HMR do Vite via Caddy (`wss://localhost:8443`).
`npm run dev` local continua funcionando sem Docker só para o front (sem
backend). `.env.example` versionado; `.env` ignorado.

## Decisões

(registrar aqui desvios e escolhas tomadas durante a implementação)

### Backend (`server/`)

- **Variáveis exigidas pelo server** (validadas com zod no boot; ausente,
  vazia ou mal formada = não sobe; ver `server/.env.example`):
  `DATABASE_URL` (papel `minitown_app`), `APP_ORIGIN` (ex.:
  `https://localhost:8443`), `SESSION_KEY`, `CSRF_KEY`, `EMAIL_ENC_KEY`,
  `EMAIL_HASH_KEY` (cada uma base64/base64url de **32 bytes**, distintas:
  `openssl rand -base64 32`). `SESSION_KEY` também é a chave do HMAC de IP,
  de rede e do cookie de dispositivo. Opcionais: `MIGRATION_DATABASE_URL`
  (papel `minitown_owner`; ver "Boot"), `PASSWORD_PEPPER` (32 B; **obrigatório
  com `NODE_ENV=production`**) + `PASSWORD_PEPPER_VERSION` (1) e peppers
  antigos `PASSWORD_PEPPER_<n>`, `EMAIL_KEY_VERSION` (1) e chaves antigas
  `EMAIL_ENC_KEY_<n>` (rotação), `CITY_DATA_PATH` (padrão
  `../public/data/itabirito.json`, relativo ao cwd `server/`), `PGSSLROOTCERT`
  (CA do Postgres; presente ⇒ TLS com verificação de certificado e hostname;
  obrigatório com `NODE_ENV=production`), `PORT` (3000), `HOST` (padrão
  `127.0.0.1`; o compose usa `0.0.0.0` dentro da rede `proxy`),
  `TRUST_PROXY_HOPS` (padrão 0 = `X-Forwarded-For` ignorado) +
  `TRUSTED_PROXIES` (IPs/CIDRs separados por vírgula; obrigatório quando
  `TRUST_PROXY_HOPS > 0`), `LOG_LEVEL` (info). As URLs **não** devem trazer
  `sslmode`. Ver "Proxy confiável" abaixo.
- **Init do Postgres**: `server/db-init/` montado em
  `/docker-entrypoint-initdb.d` (só-leitura). `10-roles.sh` + `roles.psql`
  criam `minitown_owner` e `minitown_app` (LOGIN, scram-sha-256, sem
  superuser), passam o banco `$POSTGRES_DB` e o schema `public` ao dono e
  revogam `PUBLIC`. Exige no serviço `db`: `MINITOWN_OWNER_PASSWORD`,
  `MINITOWN_APP_PASSWORD` (além de `POSTGRES_PASSWORD`/`POSTGRES_DB`). Os
  `GRANT`s mínimos ao app ficam nas migrações (`001_init.sql`,
  `002_hardening.sql`).
- **Boot / credencial do dono** (revisão): `npm run migrate` aplica as
  migrações **e** sincroniza o catálogo com o papel dono — é o comando do
  serviço one-shot `migrate` recomendado no compose (com `depends_on: …
  service_completed_successfully` no `server`), para o container da API
  receber **só** `DATABASE_URL`. Sem `MIGRATION_DATABASE_URL` o server só
  confere `schema_version()` (função `SECURITY DEFINER`) contra a última
  migração do disco e recusa subir se o banco estiver atrasado. Se a variável
  vier (compatibilidade, **só fora de produção**: com `NODE_ENV=production` o
  `loadConfig` recusa subir), o server migra no boot e a apaga de
  `process.env`/`cfg` — o que **não** a tira de `/proc/<pid>/environ`, do
  `docker inspect` nem do ambiente dos filhos do `tsx watch`; por isso o
  compose não a entrega ao server (revisão r2). O dono continua podendo
  desligar triggers (é dono das tabelas): as garantias de só-inserção valem
  contra o **papel app**, não contra quem tem a credencial do dono — por isso
  ela não deve ficar no processo da API. Scripts: `npm run dev`
  (`scripts/dev.mjs`: `tsx watch` com `CHOKIDAR_USEPOLLING=1`, vigia `src/` e `migrations/`), `start`, `migrate`,
  `test`, `typecheck`. `tsx` é dependência de produção.
- **Migrador**: sessão com `statement_timeout = 0`, `lock_timeout = 5s`;
  arquivo com a linha `-- no-transaction` roda fora de transação (para
  `CREATE INDEX CONCURRENTLY`); banco com versão que o código não conhece
  (rollback de deploy) = erro.
- **Privilégios** (além do contrato): o app **não** tem `UPDATE` em
  `accounts.balance` — o saldo de jogador só muda por trigger `SECURITY
  DEFINER` ao inserir em `ledger_entries` (o app tem só `UPDATE(updated_at)`
  para usar `FOR UPDATE`). `INSERT` só nas colunas necessárias (`accounts
  (kind, user_id)` + trigger que zera `balance`; `businesses` sem `level`;
  `ledger_*`, `users`, `listings`, `starter_claims` com lista de colunas).
  Catálogo (`properties`) é só-leitura para o app, exceto
  `owner_id/acquired_at/last_collected_at/locked_until/acquired_price`.
  `audit_log`: só `INSERT`. Ledger e auditoria têm trigger contra
  `UPDATE/DELETE/TRUNCATE` (barreira contra o app e contra erro humano; o
  dono, dono das tabelas, pode desligá-la). Manutenção: o app **não** tem
  `UPDATE` em `system_flags`; só chama `economy_lock(reason)` (`SECURITY
  DEFINER`, grava apenas `locked = true`). Partidas dobradas garantidas
  também no banco: constraint trigger *deferred* exige soma 0, ≥ 2
  lançamentos **e regras por tipo** no `COMMIT`: só `signup_grant`,
  `starter_home`, `income` e `adjustment` debitam o TESOURO, só `city_sale`
  debita o GOVERNO; `signup_grant` = exatamente TESOURO −I$ 30.000 → conta do
  próprio usuário (`economy_signup_grant()`), um por usuário (índice único
  parcial); `adjustment` (emissão manual) só pelo papel dono.
- **Contas de sistema sem saldo em cache**: o trigger do razão só atualiza
  contas de jogador; TESOURO/IMPOSTOS/TAXAS/GOVERNO têm `balance = 0`
  (CHECK) e o saldo delas é a soma dos lançamentos. `lockAccounts` trava só
  contas de jogador — não há mais linha quente serializando a economia.
  Esperas por trava de outro jogador têm `lock_timeout` de 5 s; timeout de
  trava/comando vira `503 BUSY` com `Retry-After`, não 500.
- **Tabelas extras**: `starter_claims` (PK `user_id` = casa inicial uma vez
  por conta; `price`, `subsidy`, `subsidy_repaid`, `encumbered_until`,
  `released_at`; único **ativo** por lote), `system_flags` (`economy_lock`),
  `schema_migrations`, `user_ips` (HMAC de IP e de rede por conta, 90 dias),
  `catalog_versions` (checksum do catálogo aplicado), `ledger_checkpoint` e
  `ledger_checkpoint_balances` (invariantes incrementais). `listings.seq`
  (identity) serve de cursor.
- **Ordem global de travas**: advisory (usuário+chave de idempotência) →
  advisory (usuário: todas as operações econômicas do mesmo jogador em fila)
  → imóveis (`lot_id` ↑) → anúncio → contas de jogador (`id` ↑) → usuários →
  índice de mercado (último, depois de montar a resposta). O relógio da
  operação é lido **depois** das travas do usuário, e `last_collected_at`
  só avança (`GREATEST`): coletas concorrentes não pagam o mesmo período duas
  vezes.
- **Idempotência**: exigida (UUID v4) em **todas** as rotas POST/DELETE de
  economia, inclusive residência e cancelar anúncio. Só respostas de sucesso
  são gravadas (24 h); erro de regra = rollback total, e repetir a chave
  reexecuta. Mesma chave com outro método/rota/corpo = `422
  IDEMPOTENCY_KEY_REUSED`. Replay devolve o mesmo corpo/status + header
  `Idempotent-Replayed: true`. Em manutenção, replays continuam servidos.
- **Login/registro sem CSRF de sessão** (ainda não há sessão): protegidos
  por `Origin` obrigatório, `SameSite=Strict` e parser só `application/json`
  (sem `text/plain`/form ⇒ exige preflight entre sites). Logout exige CSRF
  quando há sessão. `GET /api/auth/me` devolve também `email` (decifrado com
  qualquer versão de chave conhecida; o job recifra para a atual).
  Registro revoga a sessão anterior do navegador (como o login).
- **Enumeração**: login e bloqueio por força bruta usam a chave HMAC do
  e-mail exista ou não a conta (mesmas respostas/tempos, argon2 fictício,
  duração mínima de 350 ms). No **registro**, e-mail repetido devolve `409
  REGISTRATION_FAILED` genérico — sem verificação de e-mail não há como
  esconder totalmente; mitigado pelos limites de cadastro.
- **Força bruta** (revisão): a tentativa é contada **antes** da verificação,
  numa transação com `FOR UPDATE` na linha do contador (rajadas paralelas não
  passam de 5+1 verificações); sucesso zera o contador da conta e devolve a
  tentativa ao IP. Conta — 5 falhas livres, depois 15 s·2ⁿ até 15 min; IP —
  20 falhas livres, até 1 h; contadores zeram após 1 h sem falha. **Origem
  conhecida** (cookie `__Host-dev` = id aleatório + HMAC(id, conta), emitido
  no login/registro com sucesso, 180 dias; ou IP com login de sucesso da conta
  nos últimos 30 dias) usa o escopo `device`, com contador próprio: quem só
  sabe o e-mail trava apenas o contador de origens desconhecidas e não impede
  o login da vítima. Troca de senha errada usa contador próprio da sessão
  (não bloqueia o login). Bloqueios ficam na auditoria (`login_locked`).
- **Senha/pepper versionados**: hash gravado como `p<versão>$<argon2>`
  (`p0$` = sem pepper); hash antigo sem prefixo = pepper atual e é regravado
  no próximo login, assim como hashes de pepper antigo (rotação com
  `PASSWORD_PEPPER_<n>`). O boot recusa subir se existir hash com versão de
  pepper não configurada (antes, perder o pepper invalidava todas as senhas
  em silêncio).
- **Nome de exibição**: NFKC antes de validar e gravar; só alfabeto latino
  (com acentos), dígitos ASCII e ` ._-`. Unicidade pelo "esqueleto"
  (`users.display_name_key`: NFKD sem acentos, minúsculas, sem separadores,
  `rn→m`, `vv→w`, `0→o`, `1/i→l`, `5→s`; mesmo algoritmo em
  `src/security/displayName.ts` e no backfill da 002). Parecido demais =
  `409 DISPLAY_NAME_TAKEN`.
- **Cadastro** (revisão): limite persistente no Postgres por **rede** (IPv4
  exato, IPv6 agrupado no /64; `users.signup_net_hmac`): 5 contas/24 h
  (atômico por advisory lock da rede) + 300 contas/h no servidor inteiro
  (`503 REGISTRATION_PAUSED`). O token bucket em memória (5/h) também passou
  a ser por rede. **Não há verificação de e-mail** (não existe serviço de
  e-mail no projeto); o abuso de contas descartáveis é contido pelas regras
  de mercado abaixo.
- **Rate limit** em memória (token bucket; uma instância): geral 300/min por
  IP e 240/min por usuário; auth 20/min por IP; registro 5/h por rede;
  economia 40/min por usuário e 120/min por IP; rotas públicas pesadas
  (`leaderboard`, `market/overview`) 30/min por IP, com cache de 30 s
  (single-flight). Com várias instâncias, migrar para Postgres/Redis.
- **Rotas públicas** (sem sessão): `health`, `leaderboard`,
  `market/overview`. Todas as demais exigem sessão — e o padrão é
  **fail-closed**: toda rota de `/api` precisa declarar `config.auth`
  (`'none'` | `'required'`), senão o app não sobe (hook `onRoute`). Body JSON
  vazio em POST é aceito como "sem corpo".
- **Privacidade pública** (revisão, §2.7): `overview.recentSales` não traz
  `lotId`; preço arredondado a I$ 1.000, hora cheia, só vendas com mais de
  15 min. `stats.moneySupply` saiu (com poucos jogadores revelava saldos).
  Ranking com **2 algarismos significativos** (passo mínimo I$ 1.000) e
  patrimônio já descontado da dívida de IPTU — somar as avaliações de alguém
  e subtrair do ranking não dá mais o saldo. O dono (`displayName`) continua
  visível no imóvel (contrato §4).
- **Extensões de resposta**: `PropertyView` ganha `lockedUntil` (só dono,
  carência da casa inicial), `upgradeCost` e `openBusinessCost` (só dono) e
  `listing.suspended` (preço saiu da faixa após mudança do índice; não pode
  ser comprado). `cityPrice` é o preço **para quem consulta** (progressivo
  pela carteira). `Wallet` ganha `taxDebt` e `marketUnlockAt` (ISO ou null).
  `ListingView` = `{ id, lotId, category, address, area, levels, askPrice,
  appraisal, seller: { displayName }, mine, createdAt }` (a lista só traz
  anúncios ativos, com menos de 7 dias e dentro da faixa). `TxView` = `{ id,
  kind, lotId, amount (com sinal, da ótica do jogador), createdAt }`.
  `overview` = `{ indices: { categoria: número }, recentSales: [{ kind,
  category, price, at }], stats: { players, ownedProperties, activeListings }
  }`. `incomePerHour` é bruto (antes do IPTU); de imóvel alheio mostra o
  potencial (não revela residência de terceiros). `askPrice` aceita inteiro
  JSON ou string de dígitos (centavos). Nova rota `DELETE
  /api/properties/:lotId/business` (fecha o negócio, sem reembolso;
  idempotente como as demais). Novos códigos `409`: `ACCOUNT_TOO_NEW`,
  `MARKET_LINKED_ACCOUNTS`, `MARKET_PAIR_COOLDOWN`, `TAX_DEBT`,
  `CITY_PURCHASE_QUOTA`, `STARTER_RESERVED`; `503 BUSY`.
- **Economia — escolhas de balanceamento** (`server/src/economy/config.ts`,
  revisão): valor do m² construído residencial 400, comercial 650,
  industrial 300, institucional 700, religioso 900; terreno 25/m². **Área
  construída = projeção do prédio × andares** (antes era o lote inteiro ×
  andares, o que multiplicava o quintal) **+ terreno do lote × 25**;
  avaliação mínima I$ 1.000. `fator_localizacao = 0,6 + 1,0·e^(−d/500 m)`;
  `fator_tamanho = clamp((100/área_construída)^0,1; 0,7; 1,2)`. Renda/h:
  residencial 0,05%, comercial 0,06%, industrial 0,055% (≈ 1,2–1,4%/dia;
  antes 3,6–4,8%/dia, crescimento exponencial). IPTU 0,4%/dia, progressivo
  pela carteira (+5% por imóvel acima de 5, até 3×). Negócio: abertura = 15%
  da avaliação (mín. I$ 5.000), upgrade = abertura × [1; 1,75; 3; 5],
  +10% por nível, multiplicador 1,3–1,5 × concorrência `max(0,4; 1/(1 +
  0,25·Σnível_rivais/nível_próprio))` no raio de **150 m**, só rivais de
  **outros donos**; o multiplicador final nunca fica abaixo de 1,0. Compra à
  prefeitura: até 30 por jogador em 24 h; preço +5% por imóvel acima de 10
  (até +100%).
- **Índice** (revisão): efeito **ponderado pelo valor** (preço ÷ mediana da
  base da categoria, `market_indices.ref_price`, entre 0,05 e 1): +0,40% compra
  ao governo, +0,25% venda entre jogadores (só se preço ≥ 90% da avaliação e
  sem venda do mesmo imóvel nas últimas 24 h), −0,40% venda ao governo; ±5%
  por hora; reversão de **5%/h** à média. EMA de 24 h (`ema_bp`): a renda usa
  o **menor** entre índice e EMA, o IPTU o **maior** (pico de minutos não
  infla a coleta das 24 h anteriores).
- **Venda ao governo** (revisão): `0,7 × min(avaliação atual, preço pago)`
  (`properties.acquired_price`). Bombear o índice não gera lucro; o teste
  `índice bombeado ao teto` confirma prejuízo no ciclo comprar→vender.
- **Casa inicial** (revisão): elegível pela avaliação **base** ≤ I$ 60.000
  (o índice não esvazia a lista); amostra de 30 em ordem pseudoaleatória por
  jogador (não só as mais centrais). Jogador paga 20%; `acquired_price` =
  o que ele pagou (venda ao governo: no máximo 70% disso). Carência de 30 dias
  para vender/anunciar; **gravame de 180 dias** sem aluguel (mesmo que deixe
  de ser residência); vendida a outro jogador, o subsídio volta ao Tesouro
  com o valor da venda. Ao sair do dono, o lote pode voltar a ser casa
  inicial de outro. Casas elegíveis ficam **reservadas**: quem já tem 3 ou
  mais imóveis não as compra da prefeitura.
- **Residência**: não rende aluguel e é **isenta de IPTU** até I$ 60.000 de
  avaliação (benefício real de morar). Garantia no banco: FK composta
  *deferred* `users(residence_lot_id, id) → properties(lot_id, owner_id)`.
- **Arredondamento da coleta** (revisão r2, CWE-682): `accrual` devolve
  `consumedMs` e o `settle` avança `last_collected_at` (por lote, ainda com
  `GREATEST`) **só pelo tempo cujo IPTU foi cobrado em centavos inteiros**; o
  resto fracionário fica para a próxima coleta. Sem IPTU (residência isenta)
  quem manda é a renda; sem nenhum dos dois o relógio avança tudo; acima do
  teto de 30 dias o excedente é perdoado como antes. Antes o imposto tinha
  piso por lote e por coleta e o relógio avançava sempre: coletar a cada
  1,5 s (40/min permitidas) zerava o IPTU de imóveis de até ~I$ 144 mil
  (terreno vago, casa sob gravame). Prova: 100 coletas de 1,5 s = 1 coleta de
  150 s (±1 centavo), em `test/attack/pure-r2.test.ts` e
  `test/attack/redteam-r2.test.ts`.
- **Renda/IPTU** (revisão): renda acumula até 24 h; IPTU acumula por tempo
  real até **30 dias** e o que não couber em saldo + renda vira
  `users.tax_debt`, cobrada antes de qualquer renda futura e descontada do
  valor de vendas; com dívida não se anuncia, compra, abre nem melhora
  negócio (`409 TAX_DEBT`). Antes de qualquer mudança que altere a renda de
  um imóvel a renda pendente é liquidada para o dono atual. A casa inicial
  só vira residência se o jogador ainda não tiver uma. Venda ao governo
  fecha o negócio; venda entre jogadores mantém o negócio e o comprador
  herda; o vendedor perde a residência se era aquela.
- **Mercado entre jogadores** (revisão — a faixa 50–300% sozinha não
  impedia lavagem): faixa **80–130%** da avaliação; taxa 5% + 20% sobre o que
  passar de 110%; conta com menos de **7 dias** não compra nem anuncia
  (`ACCOUNT_TOO_NEW`); contas que usaram a mesma rede (IPv4 exato / IPv6 /64)
  nos últimos 30 dias não negociam entre si (`MARKET_LINKED_ACCOUNTS`); um
  negócio por par comprador/vendedor (qualquer sentido) a cada 7 dias
  (`MARKET_PAIR_COOLDOWN`); anúncio expira em 7 dias (job marca `expired`).
  Na compra a faixa é rechecada com 5% de tolerância (fora =
  `409 LISTING_PRICE_OUT_OF_RANGE`); fora da faixa ao anunciar = `422
  ASK_OUT_OF_RANGE`. Mínimo de 80% > 70% da prefeitura: não há arbitragem
  "compra anúncio barato, vende ao governo".
- **Catálogo** (revisão): sincronização numa transação única, registrada em
  `catalog_versions` (checksum; mesmo checksum = nada a fazer). Imóvel com
  dono **não** é reprecificado nem muda de categoria pelo catálogo (só
  atributos físicos/endereço); ao voltar à prefeitura recebe os valores novos
  na sincronização seguinte. Lote que some do JSON fica `retired_at`
  (sem dono: não vendável; com dono: continua dele, a prefeitura não o
  revende). Trigger garante negócio só em comercial com dono; upgrade checa a
  categoria.
- **Invariantes** (revisão; job a cada 5 min, foto `REPEATABLE READ`, um por
  vez via advisory lock): incremental a partir de `ledger_checkpoint` (só
  lançamentos novos; o ponto avança até 5 min atrás e só se tudo bateu) e
  **completo 1×/dia** sem timeout de comando. Checa: transações com soma ≠ 0
  ou < 2 lançamentos; saldo de jogador ≠ soma dos lançamentos; saldo
  negativo; débito de conta de sistema por tipo não autorizado; usuário sem
  exatamente um bônus; massa monetária ≠ −TESOURO; **emissão registrada ≠
  emissão esperada por fontes independentes** (nº de contas × bônus +
  subsídios − devolvidos + Σ renda declarada + ajustes do dono); anúncio
  ativo de quem não é dono; residência alheia; e (na completa) dono ≠ última
  transação de posse do lote. Alarmes que não travam: emissão > I$ 5 mi/h e
  GOVERNO < −I$ 10 mi (log + `economy_alert`). Falha ⇒ log `ALARME`,
  `audit_log invariant_violation` e trava (`503 MAINTENANCE`; leituras
  continuam). **3 falhas seguidas** do próprio job (timeout, banco fora) também
  travam (fail-closed). A limpeza periódica roda mesmo se a verificação
  falhar. Liberação manual pelo dono: `UPDATE system_flags SET value =
  '{"locked":false}' WHERE key = 'economy_lock'`.
- **Retenção e LGPD** (revisão): `audit_log` particionada por mês
  (`audit_log_YYYYMM` + partição padrão; o job cria as próximas); retenção
  definida em **12 meses**, aplicada pelo dono com `SELECT
  audit_log_drop_before(date_trunc('month', now() - interval '12
  months')::date)`. Sessões mortas por inatividade são apagadas 1 dia depois;
  `user_ips` em 90 dias. Pedido de exclusão: `SELECT anonymize_user(id)`
  (dono) apaga nome, e-mail (bytes aleatórios — crypto-shredding), senha e
  sessões, mantendo o razão íntegro. Cópia externa só-escrita da auditoria
  fica como recomendação de infraestrutura (não implementada).
- **Encerramento**: `startJobs` devolve `stop()` que espera a execução em
  andamento; shutdown com teto de 10 s; `unhandledRejection` /
  `uncaughtException` registram e encerram. `withTx` descarta a conexão se
  nem o `ROLLBACK` funcionar; erros do pool vão para o log.
- **Testes**: `npm test` em `server/` espera um Postgres de teste em
  `127.0.0.1:55432` (usuário `postgres`, senha `test`; sobrescreva com
  `TEST_ADMIN_URL`), recria o banco `minitown_test` e os papéis com o mesmo
  `roles.psql`. `UNIT_ONLY=1 npm test` roda só os testes puros (`unit` e
  `attack/pure*`).

### Frontend (`src/`)

- **Módulos**: `src/net/api.ts` (cliente tipado, CSRF/Idempotency-Key
  automáticos, 401 → `onUnauthorized`, 503 `MAINTENANCE` → `onMaintenance`),
  `src/net/money.ts` (centavos em `bigint`, "I$ 1.234,56"), `src/net/rules.ts`
  (regras da economia, ver abaixo), `src/net/cityCatalog.ts` (catálogo
  estimado para a aba "Prefeitura"), `src/net/store.ts` (sessão/carteira/donos
  no cliente). UI: `AuthDialog`, `PasswordDialog`, `EconomyHud`,
  `PropertySection` (dentro do `InfoPanel`), `MarketPanel`, `modal.ts`
  (diálogo acessível + confirmação de gasto). `AuthDialog`, `PasswordDialog`
  e `MarketPanel` (+ catálogo) são carregados por `import()` dinâmico (só
  quem usa baixa).
- **Regras compartilhadas (sem cópia no cliente)**: `src/net/rules.ts`
  importa `server/src/economy/config.ts` e `pricing.ts` direto (módulos
  puros). Percentuais, faixas, custos e fórmulas exibidos vêm dali; mudou o
  balanceamento, o cliente acompanha — e se um nome mudar, o front deixa de
  compilar (deriva visível). **Esses dois arquivos do servidor precisam
  continuar puros** (sem `node:*`, `pg`, `zod`), pois entram no bundle do
  navegador. Tipos de negócio e categorias também vêm de `config.ts`.
  Os tipos de resposta em `api.ts` espelham exatamente o servidor (sem
  formatos alternativos). Não foi criado um `shared/` com zod: exigiria mexer
  no build do servidor (fora do escopo do front); validação em tempo de
  execução das respostas fica como pendência.
- **Cotações**: o cliente usa o valor do servidor quando vem na resposta
  (`cityPrice` — já progressivo —, `upgradeCost`, `openBusinessCost`,
  `listing.suspended`, `lockedUntil`, `taxDebt`, `marketUnlockAt`) e só estima
  com `rules.ts` o que o servidor não manda, sempre rotulado "estimado"/"até".
  Extensões **opcionais** de `PropertyView` que o cliente já entende, se o
  servidor passar a enviar: `starterEligible` (mesma regra de
  `claimStarterHome`; sem ela o cliente estima a avaliação base com os
  índices públicos), `sellToCityQuote` (venda à prefeitura usa o menor entre
  avaliação e preço pago; sem ela a UI mostra "até ~70% da avaliação"),
  `askRange: {min,max}` e `businessOptions: [{ type, openCost, competitors,
  projectedIncomePerHour }]` (sem ela a renda com negócio aparece como teto
  "sem concorrentes"). Em `Wallet`: `pendingGross`/`pendingTax` opcionais
  (renda e IPTU separados no botão Coletar). Erro `ASK_OUT_OF_RANGE` com
  `error.details: { min, max }` é formatado em I$ pelo cliente.
- **Expiração por inatividade (§2.5)**: polling (carteira 30 s, donos 60 s)
  só com a aba visível **e** jogador presente (ponteiro/teclado/rolagem nos
  últimos 25 min). Consultas automáticas enviam `X-Background: 1`; as do
  jogador, `X-User-Activity: 1` — o servidor pode (e deve) renovar
  `last_seen_at` só nas segundas. Voltar a interagir atualiza na hora (se a
  sessão expirou, 401 → login).
- **Queda transitória × offline**: falha de rede/502/503/504 em consulta de
  fundo não derruba o jogo: o HUD mostra "Reconectando…" (painéis ficam
  abertos) e o store sonda `/api/health` com espera crescente (5–60 s). Só
  depois de 3 falhas seguidas confirmadas vira "Servidor offline"; aí, se
  havia sessão, reconecta sozinho (2, 5, 15, 30, 60 s…) e também ao voltar à
  aba. `503` com `code = MAINTENANCE` **não** é offline: HUD mostra "Economia
  em manutenção" (some após 2 min sem nova recusa) e a leitura continua.
- **Offline no boot**: `GET /api/health` que falhe, ou responda sem
  `application/json` (fallback do Vite puro), deixa o jogo em "servidor
  offline — só exploração", com "Tentar de novo" (sem reconexão automática:
  não havia sessão).
- **Logout**: o estado local só é limpo depois que o servidor confirma (204)
  ou responde 401; falha (rede, 5xx, 429) mantém o jogador logado na UI e
  abre um diálogo persistente "Não foi possível sair" com "Tentar de novo".
  "Sair de todos" mostra confirmação de sucesso.
- **Sessão trocada**: ao sair/expirar (usuário da sessão muda) todos os
  diálogos são fechados (`closeAllModals`); cada confirmação guarda o
  `user.id` de quem a abriu e aborta sem executar se ele mudar.
- **Idempotency-Key**: uma chave por diálogo de confirmação. Resultado
  incerto (rede, **qualquer** 5xx inclusive 500, 408, 429) → "Tentar de novo"
  com a **mesma** chave. Recusa de regra (demais 4xx) → mostra o motivo,
  troca o botão por "Fechar", gera chave nova e recarrega os dados exibidos
  (`onRejected`). Enviada em toda rota econômica não-GET.
- **CSRF**: 403 com código contendo `CSRF` → o cliente renova o token via
  `GET /api/auth/me` e repete a requisição uma vez (mesma chave). Após trocar
  a senha o cliente também chama `/auth/me`.
- **Mercado (abas)**: Casa inicial · **Prefeitura** · À venda · Meus imóveis
  · Extrato · Ranking · Índices. "Prefeitura" (desvio do §6, para o
  onboarding ter caminho de renda): lista imóveis sem dono (usa `owned` de
  `/properties/ownership` — **o servidor deve continuar enviando**), filtrados
  por categoria e pelo saldo, ordenados por renda líquida/h; preço estimado no
  cliente com o catálogo + índices públicos; "Comprar" busca o `PropertyView`
  real antes de confirmar. Não há endpoint paginado no servidor ainda.
  "Meus imóveis" mostra metas (casa inicial, imóvel que rende, negócio,
  marcos de patrimônio) — só orientação, sem recompensa. "Ranking" mostra a
  posição do jogador (ou quanto falta para o top 50).
- **Estilo dos destaques**: 3D marca com **luz** em `MONO_LIGHT` sem tocar o
  albedo: meu = borda acesa (fresnel) + brilho leve constante dia/noite;
  anunciado = faixas diagonais. `uOwnAny` = 0 pula a leitura da textura.
  Terrenos: meu = contorno tracejado grosso, anunciado = tracejado fino;
  seleção = linha cheia mais grossa; hover em `#e6e7f0`. Minimapa: jogador =
  seta clara com contorno amarelo, meu = quadrado amarelo, à venda = anel; há
  legenda e botão para desligar o destaque. Atributo `bidx` em `Uint16`
  (`Float32` só acima de 65 534 prédios); malhas sem prédio compartilham um
  buffer de zeros; letreiros não recebem `bidx`. O store só emite `ownership`
  quando `mine`/`listed` mudam.
- **UI**: acento amarelo com papéis fixos (ação/meu; erro sempre com ícone;
  campo inválido = borda tracejada ≠ foco sólido; valores positivos e preços
  sem amarelo). Ação com perda (vender à prefeitura) = botão `danger`
  (tracejado + ícone), foco inicial em "Cancelar". Erros de ações rápidas vão
  para um aviso persistente (`role=alert`, 7 s, ícone, fechar). Sem
  `backdrop-filter` nos diálogos; nos cards só no desktop. Zoom do navegador
  liberado (sem `user-scalable=no`); alvos de 44 px em `pointer: coarse`.
- **Testes**: `npm test` na raiz (vitest + happy-dom) cobre `money.ts`, `Api`
  (401, CSRF + retry com a mesma chave, 204, não-JSON, 502 × MAINTENANCE,
  429 + Retry-After, cabeçalhos de atividade, logout), `OnlineStore`
  (reconexão, offline, inatividade, resposta velha) e `confirmAction`/`setBusy`.
  E2E com Playwright contra o Docker: pendente.
- **Tela de conta**: abre sobre o carregamento quando há servidor e não há
  sessão; Esc/"Explorar sem conta" fecha (modo exploração, botão "Entrar"
  no HUD). Sessão expirada (401) reabre o login com aviso. Erro do servidor
  vai para o campo certo (`DISPLAY_NAME_TAKEN` → nome; `WEAK_PASSWORD` →
  senha); senhas só são apagadas em erro de senha/credencial;
  `REGISTRATION_FAILED` oferece "Entrar com este e-mail"; o cadastro avisa
  que não há recuperação de senha.

### Infraestrutura (Docker)

- **Certificado do Postgres**: gerado por um serviço one-shot `certs`
  (imagem de `docker/db/Dockerfile`, `docker/db/gen-certs.sh`) e não por script em
  `docker-entrypoint-initdb.d` — o `ssl=on` precisa do certificado já no
  primeiro boot (o servidor temporário do init também sobe com TLS). CA
  ECDSA P-256 (chave descartada), certificado `CN=db` com SAN `db`, 825 dias;
  recriado só se faltar, não validar ou faltar < 30 dias. Volumes separados:
  `pg-certs` (chave, só no `db`) e `pg-ca` (`ca.crt`, montado no server em
  `/run/pg-ca`, `PGSSLROOTCERT` ⇒ verify-full). `ssl_min_protocol_version =
  TLSv1.3`.
- **Imagem do Postgres**: `docker/db/Dockerfile` (base `postgres:17` fixada
  por digest; garante o binário `openssl`; embute `gen-certs.sh` e
  `pg-backup.sh`), usada por `certs`, `db` e `backup`. Todas as imagens
  (`node:22-bookworm-slim`, `caddy:2-alpine`, `postgres:17`) são fixadas por
  `@sha256:` — atualizar é trocar o digest de propósito.
- **pg_hba** próprio (`docker/db/pg_hba.conf`), primeira regra vence: `local`
  (socket) com `scram-sha-256` para todos — único caminho do superusuário;
  `host all postgres all reject`; `hostssl minitown minitown_app 127.0.0.1/32`
  (healthcheck `pg_isready`); `hostssl minitown
  minitown_app,minitown_owner,minitown_backup samenet scram-sha-256`; todo o
  resto (inclusive sem TLS) `reject`.
- **Redes** (revisão r2): `edge` (caddy, web), `proxy` (`internal: true`,
  sub-rede fixa `10.203.47.0/28`, faixa dinâmica `.8/29`: caddy com IP fixo
  `10.203.47.2` e server), `data` (`internal: true`, sem saída: server,
  migrate, backup, db) e `egress` (só o one-shot `server-deps`). O web (Vite e
  dependências npm do front) não resolve nem alcança `db` **nem o server**; o
  server não tem saída para a internet. `samenet` no pg_hba = sub-rede `data`.
  Se a sub-rede do `proxy` colidir com uma rede local, trocar juntos a
  sub-rede, o `ipv4_address` do caddy e o `TRUSTED_PROXIES` do server.
- **Proxy confiável** (revisão r2, CWE-348): `trustProxy` do Fastify =
  `proxyTrust(TRUST_PROXY_HOPS, TRUSTED_PROXIES)` (`src/security/proxy.ts`,
  `node:net` `BlockList`): um salto só é confiável se estiver dentro de
  `HOPS` **e** o endereço for de um proxy da lista. Antes, `hop < HOPS`
  ignorava o endereço: quem conectasse direto em `server:3000` (o container
  `web`, ou a LAN com o server fora do Docker em `0.0.0.0`) escolhia o
  próprio `req.ip` pelo `X-Forwarded-For` e anulava os limites por IP, o
  limite de cadastro por rede, o contador de força bruta por IP e
  `MARKET_LINKED_ACCOUNTS`. Compose: `TRUST_PROXY_HOPS=1`,
  `TRUSTED_PROXIES=10.203.47.2` (o Caddy, que já descarta o `X-Forwarded-For`
  vindo do cliente). Testes: `test/attack/pure-r2.test.ts` e
  `test/attack/redteam-r2.test.ts`.
- **Mounts do web**: só `src/`, `public/`, `index.html`, `vite.config.ts`,
  `tsconfig.json`, `package*.json`, todos só-leitura — nunca a raiz (`.env`,
  `server/`, `docker/`, `docs/` ficam fora do container e, portanto, fora do
  alcance do Vite). Reforço no Vite (`DOCKER=1`): `server.fs.deny` com os
  padrões do Vite + `**/server/**`, `**/docker/**`, `**/backups/**`, `*.key`.
- **Papéis por serviço**: `migrate` (one-shot, `docker/migrate/bootstrap.mts`
  reaproveitando `server/src/db/migrate.ts` e `economy/catalog.ts`) é o único
  que recebe `MIGRATION_DATABASE_URL` (dono) e roda migrações + sincronização
  do catálogo; o server depende dele (`service_completed_successfully`).
  **Revisão r2**: a linha transitória que ainda entregava
  `MIGRATION_DATABASE_URL` ao `server` foi **removida** (o server já a aceita
  ausente e só confere `schema_version()`); com ela, RCE/SSRF de leitura de
  arquivo no server lia a credencial do dono em `/proc/1/environ` e podia
  `DISABLE TRIGGER`, lançar `adjustment` e liberar `economy_lock`. O smoke
  test confere o ambiente do exec **e** o `environ` de todos os processos do
  container. Produção: depois de migrar, `ALTER ROLE minitown_owner NOLOGIN`
  (e `LOGIN` só durante a próxima migração) ou senha fora do host da API.
- **Segredos**: `.env` da raiz gerado por `scripts/gen-secrets.mjs` (com `.env`
  existente só acrescenta as variáveis ausentes; `--force` recria). Lido só
  pelo compose no host: nenhum container monta o `.env`; cada serviço recebe
  só as variáveis de que precisa (web: nenhum segredo). Senhas do Postgres em
  hex (32 bytes, seguras em URL), inclusive `MINITOWN_BACKUP_PASSWORD`; chaves
  base64 de 32 bytes, inclusive `PASSWORD_PEPPER`. O compose monta
  `DATABASE_URL`/`MIGRATION_DATABASE_URL` a partir delas (`${VAR:?}`: faltou,
  não sobe). O `server/.env.example` vale só para rodar o server fora do
  Docker.
- **Backup**: serviço `backup` (mesma imagem do db, uid 999, `cap_drop: ALL`)
  roda `pg-backup.sh`: `pg_dump -Fc` a cada 24 h pelo papel `minitown_backup`
  (`pg_read_all_data`, `default_transaction_read_only`, criado por
  `docker/db/initdb/20-backup-role.sh`, idempotente) com TLS verify-full;
  valida com `pg_restore --list`; `.sha256`; retenção 7 diários + 4 semanais
  em `./backups/` (bind do host, fora dos volumes nomeados: sobrevive a `down
  -v`; ignorado por git e build). Restauração: `docker/backup/restore.sh`
  (dump de segurança do banco atual, `DROP DATABASE … WITH (FORCE)`,
  `pg_restore --create` como superusuário pelo socket local; dados entram
  antes dos triggers, então o razão não é reaplicado). Produção: WAL archiving
  (pgBackRest/wal-g) para PITR e backup cifrado fora do host.
- **Endurecimento**: todos os serviços com `no-new-privileges` e `cap_drop:
  ALL`; `db` volta só `CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER`
  (entrypoint oficial), `certs` só `CHOWN, DAC_OVERRIDE, FOWNER`, `caddy` só
  `NET_BIND_SERVICE` (o binário tem essa file capability: sem ela no conjunto
  limite o `execve` falha com EPERM, mesmo na porta 8443).
- **Smoke test**: `npm run docker:smoke` (`docker/smoke.mjs`) — TLS do Caddy
  verificado pela CA local, health, cabeçalhos (HSTS, CSP), compressão,
  arquivos sensíveis não servidos, registro/login com `__Host-sid` + CSRF +
  Origin, casa inicial com replay idempotente, coleta, logout; no Docker:
  TLSv1.3 em `pg_stat_ssl`, sem TLS e superusuário pela rede recusados,
  papéis sem superuser, web sem `.env`/rota para o db e para o server, server
  sem credencial do dono (exec e `/proc/*/environ`) e fora da rede do web,
  backup sob demanda.
- **Portas**: só o Caddy publica, em `127.0.0.1:8443` (não em todas as
  interfaces). Caddy sem redirecionamento HTTP (`auto_https
  disable_redirects`), admin só em `127.0.0.1:2019` (healthcheck),
  `encode zstd gzip` (JSON da cidade, JS de dev e `/api`).
- **HSTS** (desvio do §2.6 em dev): HSTS vale por host, não por porta; um
  `max-age` longo em `localhost` forçaria https em todo `http://localhost:*`
  (inclusive o `npm run dev` em :5173 que o §7 exige). O Caddy envia
  `Strict-Transport-Security: {$CADDY_HSTS}`, padrão `max-age=0` (que também
  apaga um HSTS antigo já gravado), com `>` (aplicado na resposta final,
  sobrescrevendo o do server em `/api`). Produção, com domínio próprio:
  `CADDY_HSTS="max-age=31536000; includeSubDomains"` no `.env`.
- **CSP do front** (fora de `/api`, definida no Caddy): `script-src 'self'`;
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` (HMR de CSS
  e Google Fonts usados em `styles.css`); `font-src https://fonts.gstatic.com`;
  `connect-src 'self' wss://localhost:8443`; `img-src`/`worker-src` com
  `blob:`; `frame-ancestors 'none'`. `/api` mantém a CSP do próprio server.
- **Vite**: ajustes de Docker só com `DOCKER=1` (HMR `wss` em
  `APP_ORIGIN`, `allowedHosts`, polling, `strictPort`, ignora `server/`);
  `npm run dev` local inalterado.
- **node_modules** (revisão r2, CWE-829): volumes nomeados; o entrypoint
  (`docker/node-entrypoint.sh`) compara o SHA-256 do `package-lock.json` e só
  reinstala com `NODE_DEPS_INSTALL=1` — `web` (sem segredos) e o one-shot
  **`server-deps`** (rede só `egress`, nenhum segredo, sem rede `data`; monta
  só `package*.json` e o volume). `migrate` e `server` (que têm credenciais)
  **só conferem**: desatualizado = não sobem (rodar `docker compose up -d`,
  que executa o `server-deps` antes). Todo install usa `npm ci
  --ignore-scripts` (entrypoint e `server.Dockerfile`; `@node-rs/argon2` e
  `esbuild` vêm em pacotes binários pré-compilados): um postinstall malicioso
  não roda, e o container que instala não tem nada a exfiltrar. O `migrate`
  perdeu a rede `egress` (era a única saída para a internet de um container
  com a senha do dono). Containers Node rodam como `node`, `cap_drop: ALL`,
  `no-new-privileges`.

### Red team (auditoria ofensiva)

- **Pass de red team (white-box) sobre `server/`**: tentados os objetivos do
  escopo — ler dados de outro jogador, entrar em conta alheia, gerar dinheiro
  do nada (corrida/replay), adquirir imóvel burlando regras (casa inicial 2×,
  institucional, imóvel alheio/anunciado, anúncio fora da faixa), derrubar com
  payload, CSRF/Origin, prototype pollution e XSS por `displayName`. As travas
  existentes (sessão só-SHA-256; CSRF HMAC + Origin obrigatório; `strictObject`
  + `secure-json-parse` com `protoAction/constructorAction: error`; `centsSchema`
  recusando `1e308`/`NaN`/`-0`/`"1e3"`/arrays; razão de partidas dobradas com
  regras por tipo e `CHECK (balance >= 0)`; idempotência com hash do pedido;
  travas de linha ordenadas; `displayName` só-latino com esqueleto anti-homóglifo;
  `bodyLimit` de 16 KB) **resistiram** aos vetores testados.
- **Achado corrigido (Baixo, CWE-180/CWE-521)**: `passwordProblem`
  (`src/security/password.ts`) media a força na string **crua**, enquanto
  `prepare()`/`verifyPassword` gravam/conferem a forma **NFKC**. Uma senha comum
  disfarçada em largura cheia (`ｐａｓｓｗｏｒｄ１２３` → `password123`) furava a lista
  de senhas comuns (§2.5), mas o hash gravado era o da senha fraca. Correção:
  normalizar NFKC no topo de `passwordProblem`, medindo força, comprimento e
  variedade na **mesma** string guardada. Prova vermelho→verde em
  `test/attack/pure.test.ts`.
- **Testes de ataque** em `server/test/attack/`: `pure.test.ts` (offline, entra
  no `UNIT_ONLY` via `vitest.config.ts`: validação de entrada, XSS/zero-width/bidi
  e homóglifo no nome, idempotência, segredos em tempo constante, aritmética de
  dinheiro sem crédito do nada, a prova da senha NFKC) e `redteam.test.ts`
  (integração: CSRF/Origin, sessão forjada, IDOR, corrida de compra/gasto,
  replay de idempotência, regras de posse, prototype pollution por HTTP, payload
  413, XSS/homóglifo no cadastro). O offline passa (46/46 com os unitários); o de
  integração compila e fica pronto para `cd server && npm test` (não rodou nesta
  sessão: Docker Desktop fora do ar, sem Postgres em 55432 — estado da máquina,
  não alterado para não afetar outros agentes).
