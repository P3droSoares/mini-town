import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_COOKIE, SESSION_COOKIE } from '../src/security/policy.js';
import { call, login, makeApp, nextIp, ORIGIN, register, sessionCookie, uniqueName, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

describe('registro', () => {
  it('cria conta, devolve user + csrfToken e cookie __Host-sid seguro', async () => {
    const name = uniqueName('Reg');
    const res = await call(t.app, null, 'POST', '/api/auth/register', {
      body: { displayName: name, email: `${name}@Exemplo.test`, password: 'Ponte-Laranja-Neblina-7' },
      idem: false,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['csrfToken', 'user']);
    expect(Object.keys(body.user).sort()).toEqual(['createdAt', 'displayName', 'id']);
    expect(body.user.displayName).toBe(name);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Domain=/i);
  });

  it('guarda e-mail cifrado + hash, senha em argon2id e token de sessão só como hash', async () => {
    const p = await register(t.app);
    const { rows } = await t.owner.query(
      'SELECT email_enc, email_hash, password_hash, email_key_version FROM users WHERE id = $1',
      [p.id],
    );
    const u = rows[0];
    expect(Buffer.from(u.email_enc).toString('latin1')).not.toContain(p.email);
    expect(u.email_hash).toHaveLength(32);
    expect(u.email_key_version).toBe(1);
    // pepper versionado: `p<versão>$` + argon2id com os parâmetros mínimos do contrato
    expect(u.password_hash).toMatch(/^p1\$\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const s = await t.owner.query('SELECT token_hash FROM sessions WHERE user_id = $1', [p.id]);
    expect(s.rows[0].token_hash).toHaveLength(32);
    expect(Buffer.from(s.rows[0].token_hash).toString('base64url')).not.toBe(p.token);
  });

  it('dá I$ 30.000 de emissão do Tesouro na conta nova', async () => {
    const p = await register(t.app);
    const w = (await call(t.app, p, 'GET', '/api/me/wallet')).json();
    expect(w).toMatchObject({ balance: '3000000', netWorth: '3000000', pendingIncome: '0', starterAvailable: true, taxDebt: '0' });
    // conta nova: mercado entre jogadores só depois da carência
    expect(new Date(w.marketUnlockAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejeita senha fraca, comum, curta, longa ou com o nome', async () => {
    const name = uniqueName('Fraca');
    for (const password of ['curta', '1234567890', 'senha123456', 'a'.repeat(129), `${name}-segredo-1`, 'aaaaaaaaaaaa']) {
      const res = await call(t.app, null, 'POST', '/api/auth/register', {
        body: { displayName: name, email: `${name}@x.test`, password },
        idem: false,
        ip: nextIp(),
      });
      expect(res.statusCode, password).toBe(400);
    }
  });

  it('rejeita nome inválido e campos extras', async () => {
    const bad = [
      { displayName: 'ab', email: 'a@b.test', password: 'Montanha-Azul-Seca-9' },
      { displayName: '<script>', email: 'a@b.test', password: 'Montanha-Azul-Seca-9' },
      { displayName: uniqueName(), email: 'não-é-email', password: 'Montanha-Azul-Seca-9' },
      { displayName: uniqueName(), email: 'x@y.test', password: 'Montanha-Azul-Seca-9', isAdmin: true },
      { displayName: uniqueName(), email: 'x@y.test', password: 'Montanha-Azul-Seca-9', balance: '999999999' },
    ];
    for (const body of bad) {
      const res = await call(t.app, null, 'POST', '/api/auth/register', { body, idem: false, ip: nextIp() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
  });

  it('nome de exibição: recusa outros alfabetos e nomes parecidos demais (homóglifos)', async () => {
    const p = await register(t.app);
    const base = { email: `${uniqueName()}@x.test`, password: 'Montanha-Azul-Seca-9' };
    // "е" cirílico no lugar do "e" latino
    const cyr = await call(t.app, null, 'POST', '/api/auth/register', { body: { ...base, displayName: 'Pеdro' }, idem: false, ip: nextIp() });
    expect(cyr.statusCode).toBe(400);
    // mesmo esqueleto: acento, 0/o, separadores
    const twin = p.displayName.replace(/a/g, 'á').replace(/o/g, '0');
    const res = await call(t.app, null, 'POST', '/api/auth/register', { body: { ...base, displayName: `${twin}` }, idem: false, ip: nextIp() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DISPLAY_NAME_TAKEN');
    // largura cheia vira ASCII (NFKC) e é gravado normalizado
    const wide = uniqueName('Ｗｉｄｅ');
    const ok = await call(t.app, null, 'POST', '/api/auth/register', {
      body: { displayName: wide, email: `${uniqueName()}@x.test`, password: 'Montanha-Azul-Seca-9' },
      idem: false,
      ip: nextIp(),
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user.displayName).toBe(wide.normalize('NFKC'));
  });

  it('limite de contas por rede persiste no banco (reinício não zera) e agrupa o /64 do IPv6', async () => {
    const strict = await makeApp({ policy: { signupPerNetPerDay: 2 } });
    const again = await makeApp({ policy: { signupPerNetPerDay: 2 } });
    try {
      // prefixo /64 fixo para o teste inteiro (calcular Date.now() a cada chamada mudava a rede)
      const net64 = `2001:db8:77:${(Date.now() % 65_000).toString(16)}`;
      const v6 = (n: number) => `${net64}::${n.toString(16)}`;
      await register(strict.app, { ip: v6(1) });
      await register(strict.app, { ip: v6(2) });
      const body = () => ({ displayName: uniqueName(), email: `${uniqueName()}@x.test`, password: 'Montanha-Azul-Seca-9' });
      // X-Forwarded-For forjado por par não confiável não troca a rede contada
      const third = await call(strict.app, null, 'POST', '/api/auth/register', {
        body: body(),
        idem: false,
        ip: v6(3),
        headers: { 'x-forwarded-for': '198.51.100.201' },
      });
      expect(third.statusCode).toBe(429);
      // "reinício": outra instância, mesmo banco
      const fourth = await call(again.app, null, 'POST', '/api/auth/register', { body: body(), idem: false, ip: v6(4) });
      expect(fourth.statusCode).toBe(429);
    } finally {
      await strict.close();
      await again.close();
    }
  });

  it('registro revoga a sessão anterior do mesmo navegador', async () => {
    const p = await register(t.app);
    const res = await call(t.app, p, 'POST', '/api/auth/register', {
      body: { displayName: uniqueName(), email: `${uniqueName()}@x.test`, password: 'Montanha-Azul-Seca-9' },
      idem: false,
      csrf: null,
    });
    expect(res.statusCode).toBe(201);
    expect((await call(t.app, p, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('nome de exibição único sem diferenciar maiúsculas', async () => {
    const p = await register(t.app);
    const res = await call(t.app, null, 'POST', '/api/auth/register', {
      body: { displayName: p.displayName.toUpperCase(), email: `outro-${p.email}`, password: 'Montanha-Azul-Seca-9' },
      idem: false,
      ip: nextIp(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DISPLAY_NAME_TAKEN');
  });

  it('e-mail repetido devolve erro genérico (não cita o e-mail)', async () => {
    const p = await register(t.app);
    const res = await call(t.app, null, 'POST', '/api/auth/register', {
      body: { displayName: uniqueName(), email: p.email.toUpperCase(), password: 'Montanha-Azul-Seca-9' },
      idem: false,
      ip: nextIp(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('REGISTRATION_FAILED');
    expect(res.body.toLowerCase()).not.toContain('e-mail');
  });
});

describe('login / sessão / logout', () => {
  it('login devolve nova sessão (rotação) e revoga a anterior do mesmo navegador', async () => {
    const p = await register(t.app);
    const res = await call(t.app, p, 'POST', '/api/auth/login', {
      body: { email: p.email, password: p.password },
      idem: false,
      csrf: null,
    });
    expect(res.statusCode).toBe(200);
    const token = sessionCookie(res)!;
    expect(token).not.toBe(p.token);
    expect((await call(t.app, p, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const me = await call(t.app, { ...p, token }, 'GET', '/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(p.email.toLowerCase());
    expect(me.json().csrfToken).toBe(res.json().csrfToken);
  });

  it('e-mail é normalizado (maiúsculas/espaços) no login', async () => {
    const p = await register(t.app);
    const res = await login(t.app, { email: `  ${p.email.toUpperCase()} `, password: p.password });
    expect(res.statusCode).toBe(200);
  });

  it('/me sem sessão ou com cookie forjado = 401', async () => {
    expect((await call(t.app, null, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const fake = { id: '', displayName: '', email: '', password: '', token: 'A'.repeat(43), csrf: '', ip: nextIp() };
    expect((await call(t.app, fake, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const junk = { ...fake, token: "'; DROP TABLE users; --" };
    expect((await call(t.app, junk, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('logout invalida a sessão no servidor', async () => {
    const p = await register(t.app);
    const res = await call(t.app, p, 'POST', '/api/auth/logout', { idem: false });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    expect((await call(t.app, p, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('logout-all derruba todas as sessões', async () => {
    const p = await register(t.app);
    const second = sessionCookie(await login(t.app, p))!;
    expect((await call(t.app, { ...p, token: second }, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await call(t.app, p, 'POST', '/api/auth/logout-all', { idem: false })).statusCode).toBe(204);
    expect((await call(t.app, p, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await call(t.app, { ...p, token: second }, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('expira por inatividade (30 min) e por prazo absoluto (7 dias)', async () => {
    const a = await register(t.app);
    await t.owner.query(`UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id = $1`, [a.id]);
    expect((await call(t.app, a, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const b = await register(t.app);
    await t.owner.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [b.id]);
    expect((await call(t.app, b, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('troca de senha exige a atual, revoga TODAS as sessões e entrega uma sessão nova', async () => {
    const p = await register(t.app);
    const other = sessionCookie(await login(t.app, p))!;
    const wrong = await call(t.app, p, 'POST', '/api/auth/password', {
      body: { currentPassword: 'errada-errada-1', newPassword: 'Nova-Senha-Bem-Forte-1' },
      idem: false,
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await call(t.app, p, 'POST', '/api/auth/password', {
      body: { currentPassword: p.password, newPassword: 'Nova-Senha-Bem-Forte-1' },
      idem: false,
    });
    expect(ok.statusCode).toBe(204);
    // o cookie antigo (talvez vazado) morre; o novo funciona e tem outro CSRF
    expect((await call(t.app, p, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const fresh = sessionCookie(ok)!;
    expect(fresh).toBeTruthy();
    const me = await call(t.app, { ...p, token: fresh }, 'GET', '/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().csrfToken).not.toBe(p.csrf);
    expect((await call(t.app, { ...p, token: other }, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await login(t.app, p)).statusCode).toBe(401);
    expect((await login(t.app, { email: p.email, password: 'Nova-Senha-Bem-Forte-1' })).statusCode).toBe(200);
  });

  it('registra login, falha e troca de senha na auditoria (sem IP em claro)', async () => {
    const p = await register(t.app);
    await login(t.app, { email: p.email, password: 'senha-errada-qualquer' }, '203.0.113.9');
    await login(t.app, p);
    const { rows } = await t.owner.query(`SELECT action, ip_hmac, detail::text FROM audit_log WHERE user_id = $1 ORDER BY id`, [p.id]);
    expect(rows.map((r) => r.action)).toEqual(['register', 'login_failed', 'login']);
    for (const r of rows) {
      expect(r.ip_hmac).toHaveLength(32);
      expect(r.detail).not.toContain('203.0.113.9');
    }
  });
});

describe('enumeração de contas', () => {
  it('conta inexistente e senha errada: mesma resposta e tempo mínimo', async () => {
    const slow = await makeApp({ authMinResponseMs: 250 });
    try {
      const p = await register(slow.app);
      const t0 = Date.now();
      const a = await login(slow.app, { email: p.email, password: 'senha-errada-qualquer' });
      const t1 = Date.now();
      const b = await login(slow.app, { email: `ninguem-${Date.now()}@exemplo.test`, password: 'senha-errada-qualquer' });
      const t2 = Date.now();
      expect(a.statusCode).toBe(401);
      expect(b.statusCode).toBe(401);
      expect(a.body).toBe(b.body);
      expect(a.json()).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Usuário ou senha inválidos.' } });
      expect(t1 - t0).toBeGreaterThanOrEqual(240);
      expect(t2 - t1).toBeGreaterThanOrEqual(240);
    } finally {
      await slow.close();
    }
  });
});

describe('força bruta', () => {
  it('bloqueia a conta após falhas repetidas, mesmo com a senha certa, e bloqueia e-mail inexistente igual', async () => {
    const p = await register(t.app);
    const ghost = `fantasma-${Date.now()}@exemplo.test`;
    const statuses: number[] = [];
    const ghostStatuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      // IPs diferentes: o bloqueio é por conta
      statuses.push((await login(t.app, { email: p.email, password: `errada-${i}-xyz` })).statusCode);
      ghostStatuses.push((await login(t.app, { email: ghost, password: `errada-${i}-xyz` })).statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(6)).toEqual([429]);
    // mesmo padrão para e-mail que não existe: não revela cadastro
    expect(ghostStatuses).toEqual(statuses);
    const right = await login(t.app, p);
    expect(right.statusCode).toBe(429);
    expect(Number(right.headers['retry-after'])).toBeGreaterThan(0);
    // passado o bloqueio, a senha certa entra e zera o contador
    await t.owner.query(`UPDATE login_attempts SET locked_until = now() - interval '1 second'`);
    expect((await login(t.app, p)).statusCode).toBe(200);
  });

  it('tentativas em paralelo não passam do limite (contagem atômica)', async () => {
    const p = await register(t.app);
    const res = await Promise.all(
      Array.from({ length: 30 }, (_, i) => login(t.app, { email: p.email, password: `errada-paralela-${i}` })),
    );
    const tried = res.filter((r) => r.statusCode === 401).length;
    // no máximo as livres + a que dispara o bloqueio chegam a verificar a senha
    expect(tried).toBeLessThanOrEqual(6);
    expect(res.filter((r) => r.statusCode === 429).length).toBeGreaterThanOrEqual(24);
    await t.owner.query(`DELETE FROM login_attempts WHERE scope = 'account'`);
  });

  it('quem só sabe o e-mail não bloqueia a vítima: origem conhecida tem contador próprio', async () => {
    const p = await register(t.app);
    // atacante de vários IPs trava o contador da conta
    for (let i = 0; i < 8; i++) await login(t.app, { email: p.email, password: `chute-${i}-abc` });
    expect((await login(t.app, p)).statusCode).toBe(429);
    // vítima no IP de sempre (cadastro/login anterior): entra
    expect((await login(t.app, p, p.ip)).statusCode).toBe(200);
    // vítima com o cookie de dispositivo, de um IP novo: entra
    const first = await login(t.app, p, p.ip);
    const dev = first.cookies.find((c) => c.name === DEVICE_COOKIE)?.value;
    expect(dev).toBeTruthy();
    const reg = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: p.email, password: p.password }),
      remoteAddress: nextIp(),
      cookies: { [DEVICE_COOKIE]: dev! },
    });
    expect(reg.statusCode).toBe(200);
    await t.owner.query(`DELETE FROM login_attempts WHERE scope = 'account'`);
  });

  it('bloqueia o IP após muitas falhas em contas diferentes', async () => {
    const ip = nextIp();
    let last = 0;
    for (let i = 0; i < 22; i++) {
      last = (await login(t.app, { email: `alvo${i}-${Date.now()}@exemplo.test`, password: 'qualquer-coisa-1' }, ip)).statusCode;
    }
    expect(last).toBe(429);
    const p = await register(t.app);
    expect((await login(t.app, p, ip)).statusCode).toBe(429);
    expect((await login(t.app, p)).statusCode).toBe(200);
  });

  it('limite de taxa por IP nas rotas de auth e de criação de contas', async () => {
    const strict = await makeApp({ limits: { authIp: { capacity: 3, perSeconds: 60 }, registerIp: { capacity: 2, perSeconds: 3600 } } });
    try {
      const ip = nextIp();
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await login(strict.app, { email: 'a@b.test', password: 'x'.repeat(12) }, ip)).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
      const regIp = nextIp();
      await register(strict.app, { ip: regIp });
      await register(strict.app, { ip: regIp });
      const third = await call(strict.app, null, 'POST', '/api/auth/register', {
        body: { displayName: uniqueName(), email: `${uniqueName()}@x.test`, password: 'Montanha-Azul-Seca-9' },
        idem: false,
        ip: regIp,
      });
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await strict.close();
    }
  });
});
