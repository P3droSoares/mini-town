-- Itabirito Online — endurecimento pós-revisão (economia, privilégios, auditoria).
-- Aplicada pelo papel dono. Ver "Decisões" em docs/ARQUITETURA-ONLINE.md.

-- ================================================================ usuários
ALTER TABLE users
  -- "esqueleto" do nome (NFKD, sem acento, minúsculo, confusáveis unificados): unicidade contra homóglifos
  ADD COLUMN display_name_key text,
  -- HMAC da rede de cadastro (IPv4 exato, IPv6 /64): limite persistente de contas
  ADD COLUMN signup_net_hmac bytea CHECK (signup_net_hmac IS NULL OR octet_length(signup_net_hmac) = 32),
  -- IPTU vencido que não coube no saldo (cobrado antes de qualquer renda)
  ADD COLUMN tax_debt bigint NOT NULL DEFAULT 0 CHECK (tax_debt >= 0);

-- mesmo algoritmo de src/security/displayName.ts (displayNameKey)
UPDATE users SET display_name_key = translate(
  replace(replace(regexp_replace(lower(regexp_replace(normalize(display_name, NFKD), '[\u0300-\u036f]', '', 'g')),
                                 '[ ._-]', '', 'g'), 'rn', 'm'), 'vv', 'w'),
  '01i5', 'olls');
-- nomes antigos que colidem no esqueleto ficam distintos (sufixo); os novos são recusados
UPDATE users u SET display_name_key = u.display_name_key || '#' || u.id::text
  FROM (SELECT id, row_number() OVER (PARTITION BY display_name_key ORDER BY created_at, id) AS n FROM users) d
 WHERE d.id = u.id AND d.n > 1;
ALTER TABLE users ALTER COLUMN display_name_key SET NOT NULL;
CREATE UNIQUE INDEX users_display_name_key ON users (display_name_key);
CREATE INDEX users_created ON users (created_at);
CREATE INDEX users_signup_net ON users (signup_net_hmac, created_at) WHERE signup_net_hmac IS NOT NULL;

-- redes usadas por cada conta (cadastro e logins com sucesso): contas ligadas e origem conhecida
CREATE TABLE user_ips (
  user_id       uuid NOT NULL REFERENCES users (id),
  ip_hmac       bytea NOT NULL CHECK (octet_length(ip_hmac) = 32),
  net_hmac      bytea NOT NULL CHECK (octet_length(net_hmac) = 32),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ip_hmac)
);
CREATE INDEX user_ips_net ON user_ips (net_hmac, last_seen_at);

ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_scope_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_scope_check CHECK (scope IN ('ip', 'account', 'device'));

CREATE INDEX sessions_last_seen ON sessions (last_seen_at);
CREATE INDEX sessions_revoked ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;

-- ================================================================ imóveis
ALTER TABLE properties
  -- preço efetivamente pago pelo dono atual (venda ao governo = 70% do menor entre isto e a avaliação)
  ADD COLUMN acquired_price bigint CHECK (acquired_price IS NULL OR acquired_price >= 0),
  -- lote que sumiu do catálogo: não volta a ser vendido pela prefeitura
  ADD COLUMN retired_at timestamptz;

UPDATE properties p SET acquired_price = coalesce((
    SELECT CASE WHEN t.kind = 'starter_home'
                THEN t.amount + coalesce((SELECT sum(e.amount) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                                           WHERE e.tx_id = t.id AND a.code = 'TESOURO'), 0)
                ELSE t.amount END
      FROM ledger_transactions t
     WHERE t.lot_id = p.lot_id AND t.user_id = p.owner_id AND t.kind IN ('starter_home', 'city_purchase', 'market_sale')
     ORDER BY t.id DESC LIMIT 1), p.base_price)
 WHERE p.owner_id IS NOT NULL;
ALTER TABLE properties ADD CONSTRAINT properties_acquired_price CHECK ((owner_id IS NULL) = (acquired_price IS NULL));
-- residência precisa ser do próprio usuário (garantia no banco, conferida no COMMIT)
ALTER TABLE properties ADD CONSTRAINT properties_lot_owner UNIQUE (lot_id, owner_id);
UPDATE users u SET residence_lot_id = NULL
 WHERE residence_lot_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.lot_id = u.residence_lot_id AND p.owner_id = u.id);
ALTER TABLE users ADD CONSTRAINT users_residence_owned FOREIGN KEY (residence_lot_id, id)
  REFERENCES properties (lot_id, owner_id) DEFERRABLE INITIALLY DEFERRED;
-- concorrência de negócios: busca por caixa em x antes da distância
CREATE INDEX properties_x ON properties (x);

-- casa inicial: subsídio registrado, gravame e liberação do lote para outro jogador
ALTER TABLE starter_claims
  ADD COLUMN price bigint NOT NULL DEFAULT 0 CHECK (price >= 0),
  ADD COLUMN subsidy bigint NOT NULL DEFAULT 0 CHECK (subsidy >= 0),
  ADD COLUMN subsidy_repaid bigint NOT NULL DEFAULT 0,
  ADD COLUMN encumbered_until timestamptz,
  ADD COLUMN released_at timestamptz;
UPDATE starter_claims s SET
  price = coalesce(t.amount, 0),
  subsidy = coalesce((SELECT -sum(e.amount) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                       WHERE e.tx_id = t.id AND a.code = 'TESOURO'), 0),
  encumbered_until = s.claimed_at + interval '180 days',
  released_at = CASE WHEN EXISTS (SELECT 1 FROM properties p WHERE p.lot_id = s.lot_id AND p.owner_id = s.user_id)
                     THEN NULL ELSE now() END
  FROM ledger_transactions t
 WHERE t.kind = 'starter_home' AND t.user_id = s.user_id AND t.lot_id = s.lot_id;
UPDATE starter_claims SET encumbered_until = claimed_at + interval '180 days' WHERE encumbered_until IS NULL;
ALTER TABLE starter_claims ALTER COLUMN encumbered_until SET NOT NULL;
ALTER TABLE starter_claims ADD CONSTRAINT starter_claims_repaid CHECK (subsidy_repaid BETWEEN 0 AND subsidy);
-- o mesmo imóvel pode voltar a ser casa inicial depois de devolvido (só uma reivindicação ativa)
ALTER TABLE starter_claims DROP CONSTRAINT starter_claims_lot_id_key;
CREATE UNIQUE INDEX starter_claims_active_lot ON starter_claims (lot_id) WHERE released_at IS NULL;

-- negócio só em imóvel comercial com dono (vale também para o catálogo e para bugs)
CREATE FUNCTION businesses_require_commercial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM properties WHERE lot_id = NEW.lot_id AND category = 'commercial' AND owner_id IS NOT NULL) THEN
    RAISE EXCEPTION 'negócio só em imóvel comercial com dono (%)', NEW.lot_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_commercial BEFORE INSERT OR UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_require_commercial();

ALTER TABLE listings DROP CONSTRAINT listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check CHECK (status IN ('active', 'sold', 'cancelled', 'expired'));
CREATE INDEX listings_buyer ON listings (buyer_id, closed_at) WHERE buyer_id IS NOT NULL;
CREATE INDEX listings_active_created ON listings (created_at) WHERE status = 'active';

ALTER TABLE market_indices
  -- média móvel exponencial (renda usa o menor entre índice e EMA; IPTU o maior)
  ADD COLUMN ema_bp integer NOT NULL DEFAULT 10000 CHECK (ema_bp BETWEEN 6000 AND 18000),
  -- preço de referência (mediana da base) para ponderar a demanda; gravado pela sincronização
  ADD COLUMN ref_price bigint CHECK (ref_price IS NULL OR ref_price > 0);
UPDATE market_indices SET ema_bp = index_bp;

-- versões do catálogo aplicadas (checksum do JSON + parâmetros de preço)
CREATE TABLE catalog_versions (
  checksum   text PRIMARY KEY,
  lot_count  integer NOT NULL,
  frozen     integer NOT NULL DEFAULT 0,
  retired    integer NOT NULL DEFAULT 0,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ================================================================ contabilidade
-- contas de sistema não guardam saldo em cache (sem linha quente): saldo = soma dos lançamentos
CREATE OR REPLACE FUNCTION ledger_apply_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE accounts SET balance = balance + NEW.amount, updated_at = now() WHERE id = NEW.account_id AND kind = 'player';
  RETURN NULL;
END $$;
UPDATE accounts SET balance = 0 WHERE kind = 'system';
ALTER TABLE accounts ADD CONSTRAINT accounts_system_no_cache CHECK (kind = 'player' OR balance = 0);

-- conta nova sempre nasce zerada (saldo só por lançamento no razão)
CREATE FUNCTION accounts_force_zero() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.balance := 0;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_insert_zero BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_force_zero();

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
  'signup_grant', 'starter_home', 'city_purchase', 'city_sale', 'market_sale',
  'income', 'business_open', 'business_upgrade', 'adjustment'));
-- um único bônus de cadastro por usuário
CREATE UNIQUE INDEX ledger_tx_one_signup ON ledger_transactions (user_id) WHERE kind = 'signup_grant';
CREATE INDEX ledger_tx_user_kind_time ON ledger_transactions (user_id, kind, created_at);
CREATE INDEX ledger_tx_lot ON ledger_transactions (lot_id, id) WHERE lot_id IS NOT NULL;
-- alarme de taxa de emissão (lançamentos do TESOURO por período)
CREATE INDEX ledger_entries_account_time ON ledger_entries (account_id, created_at);

-- bônus de cadastro (igual a ECONOMY.signupGrant em src/economy/config.ts; teste confere)
CREATE FUNCTION economy_signup_grant() RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 3000000::bigint $$;

-- partidas dobradas + regras por tipo: quem pode debitar conta de sistema, bônus exato, ajuste só do dono
CREATE OR REPLACE FUNCTION ledger_assert_balanced(p_tx bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_sum numeric;
  v_count integer;
  v_kind text;
  v_user uuid;
  v_amount bigint;
  v_bad integer;
BEGIN
  SELECT coalesce(sum(amount), 0), count(*) INTO v_sum, v_count FROM ledger_entries WHERE tx_id = p_tx;
  IF v_sum <> 0 OR v_count < 2 THEN
    RAISE EXCEPTION 'transação contábil % desbalanceada (soma %, lançamentos %)', p_tx, v_sum, v_count
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT kind, user_id, amount INTO v_kind, v_user, v_amount FROM ledger_transactions WHERE id = p_tx;
  SELECT count(*) INTO v_bad FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
   WHERE e.tx_id = p_tx AND a.kind = 'system' AND e.amount < 0
     AND NOT ((a.code = 'TESOURO' AND v_kind IN ('signup_grant', 'starter_home', 'income', 'adjustment'))
           OR (a.code = 'GOVERNO' AND v_kind = 'city_sale'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'transação % (%) debita conta de sistema sem autorização', p_tx, v_kind USING ERRCODE = 'check_violation';
  END IF;
  IF v_kind = 'adjustment' AND session_user = 'minitown_app' THEN
    RAISE EXCEPTION 'ajuste contábil só pelo papel dono' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_kind = 'signup_grant' THEN
    SELECT count(*) INTO v_bad FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
     WHERE e.tx_id = p_tx
       AND NOT ((a.code = 'TESOURO' AND e.amount = -economy_signup_grant())
             OR (a.kind = 'player' AND a.user_id = v_user AND e.amount = economy_signup_grant()));
    IF v_bad > 0 OR v_count <> 2 OR v_amount <> economy_signup_grant() THEN
      RAISE EXCEPTION 'bônus de cadastro inválido na transação %', p_tx USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END $$;

-- ponto de verificação dos invariantes (checagem incremental a cada 5 min, completa 1×/dia)
CREATE TABLE ledger_checkpoint (
  id              smallint PRIMARY KEY CHECK (id = 1),
  last_entry_id   bigint NOT NULL,
  last_tx_id      bigint NOT NULL,
  -- Σ ledger_transactions.amount de renda e de ajustes até last_tx_id
  income_total    numeric NOT NULL,
  adjust_total    numeric NOT NULL,
  full_checked_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_checkpoint_balances (
  account_id bigint PRIMARY KEY REFERENCES accounts (id),
  balance    numeric NOT NULL
);

-- ================================================================ manutenção e versão
-- o app só consegue TRAVAR a economia; liberar é manual, pelo dono
CREATE FUNCTION economy_lock(p_reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE system_flags
     SET value = jsonb_build_object('locked', true, 'reason', left(coalesce(p_reason, ''), 200), 'at', now()),
         updated_at = now()
   WHERE key = 'economy_lock';
$$;

-- versão do esquema para o server conferir sem acesso a schema_migrations
CREATE FUNCTION schema_version() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(max(version), 0) FROM schema_migrations
$$;

-- ================================================================ auditoria particionada (retenção)
CREATE SEQUENCE audit_log_seq AS bigint;
CREATE TABLE audit_log_p (
  id      bigint NOT NULL DEFAULT nextval('audit_log_seq'),
  at      timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users (id),
  action  text NOT NULL CHECK (char_length(action) <= 64),
  ip_hmac bytea,
  detail  jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE TABLE audit_log_default PARTITION OF audit_log_p DEFAULT;

-- cria a partição mensal de `p_month` se faltar (SECURITY DEFINER: o app só pode chamar isto)
CREATE FUNCTION audit_log_ensure_partition(p_month date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  m date := date_trunc('month', p_month)::date;
  part text := format('audit_log_%s', to_char(m, 'YYYYMM'));
BEGIN
  IF to_regclass('public.' || part) IS NULL THEN
    EXECUTE format('CREATE TABLE public.%I PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
                   part, m, (m + interval '1 month')::date);
  END IF;
EXCEPTION WHEN check_violation THEN
  -- já há linhas desse mês na partição padrão: fica nela (o dono pode mover depois)
  NULL;
END $$;
CREATE FUNCTION audit_log_ensure_partitions() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  FOR i IN 0..2 LOOP
    PERFORM audit_log_ensure_partition((current_date + make_interval(months => i))::date);
  END LOOP;
END $$;

-- copia o histórico e troca as tabelas
DO $$
DECLARE
  m date;
BEGIN
  FOR m IN SELECT DISTINCT date_trunc('month', at)::date FROM audit_log LOOP
    EXECUTE format('CREATE TABLE public.%I PARTITION OF public.audit_log_p FOR VALUES FROM (%L) TO (%L)',
                   format('audit_log_%s', to_char(m, 'YYYYMM')), m, (m + interval '1 month')::date);
  END LOOP;
END $$;
INSERT INTO audit_log_p (id, at, user_id, action, ip_hmac, detail)
  SELECT id, at, user_id, action, ip_hmac, detail FROM audit_log;
SELECT setval('audit_log_seq', coalesce((SELECT max(id) FROM audit_log_p), 0) + 1, false);
DROP TABLE audit_log;
ALTER TABLE audit_log_p RENAME TO audit_log;
ALTER SEQUENCE audit_log_seq OWNED BY audit_log.id;
CREATE INDEX audit_log_user ON audit_log (user_id, id DESC);
CREATE INDEX audit_log_at ON audit_log (at);
SELECT audit_log_ensure_partitions();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- retenção (só o dono): desanexa e apaga partições mensais anteriores a `p_before`
CREATE FUNCTION audit_log_drop_before(p_before date) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'public.audit_log'::regclass AND c.relname ~ '^audit_log_[0-9]{6}$'
       AND to_date(substring(c.relname from 11), 'YYYYMM') + interval '1 month' <= p_before
  LOOP
    EXECUTE format('ALTER TABLE public.audit_log DETACH PARTITION public.%I', r.relname);
    EXECUTE format('DROP TABLE public.%I', r.relname);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- pedido de exclusão (LGPD), só o dono: apaga os dados pessoais e mantém o razão íntegro
CREATE FUNCTION anonymize_user(p_user uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  tag text := left(md5(p_user::text || clock_timestamp()::text), 10);
BEGIN
  UPDATE users SET
    display_name = 'removido-' || tag,
    display_name_key = 'removido' || tag,
    -- bytes aleatórios: sem chave que os decifre (crypto-shredding)
    email_hash = decode(md5(random()::text) || md5(random()::text), 'hex'),
    email_enc = '\x01'::bytea || decode(md5(random()::text) || md5(random()::text), 'hex'),
    password_hash = '!',
    password_changed_at = now()
  WHERE id = p_user;
  UPDATE sessions SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL;
  DELETE FROM user_ips WHERE user_id = p_user;
END $$;

-- ================================================================ privilégios
REVOKE EXECUTE ON FUNCTION businesses_require_commercial(), accounts_force_zero(), economy_signup_grant(),
  economy_lock(text), schema_version(), audit_log_ensure_partition(date), audit_log_ensure_partitions(),
  audit_log_drop_before(date), anonymize_user(uuid) FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON SEQUENCE audit_log_seq FROM PUBLIC;

-- INSERT só nas colunas que o app precisa (nunca saldo, datas de sistema, nível...)
REVOKE INSERT ON users FROM minitown_app;
GRANT INSERT (display_name, display_name_key, email_hash, email_enc, email_key_version, password_hash, signup_net_hmac)
  ON users TO minitown_app;
GRANT UPDATE (email_enc, email_key_version, tax_debt) ON users TO minitown_app;
REVOKE INSERT ON accounts FROM minitown_app;
GRANT INSERT (kind, user_id) ON accounts TO minitown_app;
REVOKE INSERT ON ledger_transactions FROM minitown_app;
GRANT INSERT (kind, user_id, lot_id, amount) ON ledger_transactions TO minitown_app;
REVOKE INSERT ON ledger_entries FROM minitown_app;
GRANT INSERT (tx_id, account_id, amount) ON ledger_entries TO minitown_app;
REVOKE INSERT ON businesses FROM minitown_app;
GRANT INSERT (lot_id, type, opened_at, updated_at) ON businesses TO minitown_app;
REVOKE INSERT ON listings FROM minitown_app;
GRANT INSERT (lot_id, seller_id, ask_price, created_at) ON listings TO minitown_app;
REVOKE INSERT ON starter_claims FROM minitown_app;
GRANT INSERT (user_id, lot_id, claimed_at, price, subsidy, encumbered_until) ON starter_claims TO minitown_app;
GRANT UPDATE (released_at, subsidy_repaid) ON starter_claims TO minitown_app;
GRANT UPDATE (acquired_price) ON properties TO minitown_app;
GRANT UPDATE (ema_bp) ON market_indices TO minitown_app;
-- manutenção: o app não destrava mais a economia
REVOKE UPDATE ON system_flags FROM minitown_app;
GRANT EXECUTE ON FUNCTION economy_lock(text), schema_version(), audit_log_ensure_partitions() TO minitown_app;

GRANT INSERT (user_id, action, ip_hmac, detail) ON audit_log TO minitown_app;
GRANT USAGE ON SEQUENCE audit_log_seq TO minitown_app;
GRANT SELECT, INSERT, DELETE ON user_ips TO minitown_app;
GRANT UPDATE (last_seen_at) ON user_ips TO minitown_app;
GRANT SELECT, INSERT, UPDATE ON ledger_checkpoint, ledger_checkpoint_balances TO minitown_app;
