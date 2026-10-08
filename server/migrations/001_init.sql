-- Itabirito Online — esquema inicial.
-- Aplicada pelo papel dono (minitown_owner). O papel minitown_app recebe só
-- o DML necessário (ver GRANTs no fim). Dinheiro sempre BIGINT em centavos.

-- ---------------------------------------------------------------- usuários
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name        text NOT NULL CHECK (char_length(display_name) BETWEEN 3 AND 24),
  -- HMAC-SHA256 do e-mail normalizado (unicidade/busca sem guardar em claro)
  email_hash          bytea NOT NULL UNIQUE CHECK (octet_length(email_hash) = 32),
  -- AES-256-GCM: versão(1) || iv(12) || tag(16) || cifrado
  email_enc           bytea NOT NULL CHECK (octet_length(email_enc) > 29),
  email_key_version   smallint NOT NULL CHECK (email_key_version > 0),
  password_hash       text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  residence_lot_id    text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_display_name_lower ON users (lower(display_name));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  -- só o SHA-256 do token; o token em claro vive apenas no cookie
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  ip_hmac      bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires ON sessions (expires_at);

-- contadores de falha de login (por IP e por conta), chave sempre HMAC
CREATE TABLE login_attempts (
  scope           text NOT NULL CHECK (scope IN ('ip', 'account')),
  key_hash        bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  failures        integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  PRIMARY KEY (scope, key_hash)
);

-- ---------------------------------------------------------------- imóveis
CREATE TABLE properties (
  lot_id            text PRIMARY KEY CHECK (lot_id ~ '^ITB-[A-Z0-9-]{1,40}$'),
  building_id       text,
  category          text NOT NULL CHECK (category IN
                      ('residential', 'commercial', 'industrial', 'institutional', 'religious', 'vacant')),
  area_m2           numeric(10, 1) NOT NULL CHECK (area_m2 > 0),
  levels            smallint NOT NULL CHECK (levels BETWEEN 0 AND 200),
  address           text CHECK (char_length(address) <= 200),
  x                 double precision NOT NULL,
  z                 double precision NOT NULL,
  dist_center_m     integer NOT NULL CHECK (dist_center_m >= 0),
  -- avaliação base (sem índice de mercado), em centavos
  base_price        bigint NOT NULL CHECK (base_price >= 0),
  sellable          boolean NOT NULL,
  owner_id          uuid REFERENCES users (id),
  acquired_at       timestamptz,
  last_collected_at timestamptz,
  -- casa inicial: não pode ser vendida/anunciada antes desta data
  locked_until      timestamptz,
  catalog_synced_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_id IS NULL OR sellable),
  CHECK ((owner_id IS NULL) = (acquired_at IS NULL)),
  CHECK ((owner_id IS NULL) = (last_collected_at IS NULL))
);
CREATE INDEX properties_owner ON properties (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX properties_starter ON properties (dist_center_m)
  WHERE owner_id IS NULL AND sellable AND category = 'residential';

ALTER TABLE users
  ADD CONSTRAINT users_residence_fk FOREIGN KEY (residence_lot_id) REFERENCES properties (lot_id);

-- casa inicial: no máximo uma por conta, e cada imóvel uma única vez
CREATE TABLE starter_claims (
  user_id    uuid PRIMARY KEY REFERENCES users (id),
  lot_id     text NOT NULL UNIQUE REFERENCES properties (lot_id),
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  lot_id     text PRIMARY KEY REFERENCES properties (lot_id),
  type       text NOT NULL CHECK (type IN ('mercado', 'padaria', 'loja', 'escritorio', 'restaurante')),
  level      smallint NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
  opened_at  timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX businesses_type ON businesses (type);

CREATE TABLE listings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ordem estável para paginação por cursor
  seq        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  lot_id     text NOT NULL REFERENCES properties (lot_id),
  seller_id  uuid NOT NULL REFERENCES users (id),
  ask_price  bigint NOT NULL CHECK (ask_price > 0),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
  buyer_id   uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz,
  CHECK ((status = 'active') = (closed_at IS NULL)),
  CHECK ((status = 'sold') = (buyer_id IS NOT NULL)),
  CHECK (buyer_id IS NULL OR buyer_id <> seller_id)
);
-- um anúncio ativo por imóvel
CREATE UNIQUE INDEX listings_one_active ON listings (lot_id) WHERE status = 'active';
CREATE INDEX listings_active_seq ON listings (seq DESC) WHERE status = 'active';
CREATE INDEX listings_seller ON listings (seller_id);

-- índice de mercado por categoria em pontos-base (10000 = 1,0)
CREATE TABLE market_indices (
  category   text PRIMARY KEY CHECK (category IN
               ('residential', 'commercial', 'industrial', 'institutional', 'religious', 'vacant')),
  index_bp   integer NOT NULL DEFAULT 10000 CHECK (index_bp BETWEEN 6000 AND 18000),
  -- valor no início da janela horária (limita a variação por hora)
  anchor_bp  integer NOT NULL DEFAULT 10000 CHECK (anchor_bp BETWEEN 6000 AND 18000),
  anchor_at  timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO market_indices (category)
VALUES ('residential'), ('commercial'), ('industrial'), ('institutional'), ('religious'), ('vacant');

-- ---------------------------------------------------------------- contabilidade
CREATE TABLE accounts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('player', 'system')),
  user_id    uuid UNIQUE REFERENCES users (id),
  code       text UNIQUE CHECK (code IN ('TESOURO', 'IMPOSTOS', 'TAXAS', 'GOVERNO')),
  -- cache do saldo: só o trigger do razão altera
  balance    bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'player') = (user_id IS NOT NULL)),
  CHECK ((kind = 'system') = (code IS NOT NULL)),
  CONSTRAINT accounts_player_nonnegative CHECK (kind <> 'player' OR balance >= 0)
);
INSERT INTO accounts (kind, code) VALUES ('system', 'TESOURO'), ('system', 'IMPOSTOS'),
                                         ('system', 'TAXAS'), ('system', 'GOVERNO');

CREATE TABLE ledger_transactions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN (
               'signup_grant', 'starter_home', 'city_purchase', 'city_sale', 'market_sale',
               'income', 'business_open', 'business_upgrade')),
  user_id    uuid REFERENCES users (id),
  lot_id     text REFERENCES properties (lot_id),
  -- valor principal da operação (informativo, ex.: preço do imóvel)
  amount     bigint NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_tx_recent_sales ON ledger_transactions (id DESC)
  WHERE kind IN ('city_purchase', 'city_sale', 'market_sale');
CREATE INDEX ledger_tx_kind_time ON ledger_transactions (kind, created_at);

CREATE TABLE ledger_entries (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tx_id      bigint NOT NULL REFERENCES ledger_transactions (id),
  account_id bigint NOT NULL REFERENCES accounts (id),
  amount     bigint NOT NULL CHECK (amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx ON ledger_entries (tx_id);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id, id DESC);

-- saldo em cache = soma dos lançamentos (atualizado na mesma transação SQL).
-- SECURITY DEFINER: o papel app não tem UPDATE em accounts.balance.
CREATE FUNCTION ledger_apply_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE accounts SET balance = balance + NEW.amount, updated_at = now() WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conta % inexistente', NEW.account_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry();

-- partidas dobradas: no COMMIT, cada transação tem >= 2 lançamentos somando zero
CREATE FUNCTION ledger_assert_balanced(p_tx bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_sum numeric;
  v_count integer;
BEGIN
  SELECT coalesce(sum(amount), 0), count(*) INTO v_sum, v_count FROM ledger_entries WHERE tx_id = p_tx;
  IF v_sum <> 0 OR v_count < 2 THEN
    RAISE EXCEPTION 'transação contábil % desbalanceada (soma %, lançamentos %)', p_tx, v_sum, v_count
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
CREATE FUNCTION ledger_entries_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW.tx_id);
  RETURN NULL;
END $$;
CREATE FUNCTION ledger_tx_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entries_check();
CREATE CONSTRAINT TRIGGER ledger_tx_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_tx_check();

-- ---------------------------------------------------------------- idempotência
CREATE TABLE idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users (id),
  key          uuid NOT NULL,
  -- SHA-256 de método + rota + corpo: mesma chave com outro pedido = erro
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status_code  integer NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

-- ---------------------------------------------------------------- auditoria
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid REFERENCES users (id),
  action     text NOT NULL CHECK (char_length(action) <= 64),
  ip_hmac    bytea,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_user ON audit_log (user_id, id DESC);

-- travas operacionais (modo manutenção da economia)
CREATE TABLE system_flags (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_flags (key, value) VALUES ('economy_lock', '{"locked": false}');

-- ---------------------------------------------------------------- append-only
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'tabela % é somente-inserção', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_tx_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_tx_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- privilégios
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ledger_apply_entry(), ledger_assert_balanced(bigint), ledger_entries_check(),
  ledger_tx_check(), forbid_mutation() FROM PUBLIC;

GRANT SELECT, INSERT ON users TO minitown_app;
GRANT UPDATE (password_hash, password_changed_at, residence_lot_id) ON users TO minitown_app;
GRANT SELECT, INSERT, DELETE ON sessions TO minitown_app;
GRANT UPDATE (last_seen_at, revoked_at) ON sessions TO minitown_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO minitown_app;
-- catálogo é sincronizado pelo dono; o app só troca dono/coleta
GRANT SELECT ON properties TO minitown_app;
GRANT UPDATE (owner_id, acquired_at, last_collected_at, locked_until) ON properties TO minitown_app;
GRANT SELECT, INSERT ON starter_claims TO minitown_app;
GRANT SELECT, INSERT, DELETE ON businesses TO minitown_app;
GRANT UPDATE (level, updated_at) ON businesses TO minitown_app;
GRANT SELECT, INSERT ON listings TO minitown_app;
GRANT UPDATE (status, buyer_id, closed_at) ON listings TO minitown_app;
GRANT SELECT ON market_indices TO minitown_app;
GRANT UPDATE (index_bp, anchor_bp, anchor_at, updated_at) ON market_indices TO minitown_app;
-- saldo nunca é atualizado pelo app; UPDATE(updated_at) só viabiliza SELECT ... FOR UPDATE
GRANT SELECT, INSERT ON accounts TO minitown_app;
GRANT UPDATE (updated_at) ON accounts TO minitown_app;
GRANT SELECT, INSERT ON ledger_transactions TO minitown_app;
GRANT SELECT, INSERT ON ledger_entries TO minitown_app;
GRANT SELECT, INSERT, DELETE ON idempotency_keys TO minitown_app;
GRANT INSERT ON audit_log TO minitown_app;
GRANT SELECT ON system_flags TO minitown_app;
GRANT UPDATE (value, updated_at) ON system_flags TO minitown_app;
