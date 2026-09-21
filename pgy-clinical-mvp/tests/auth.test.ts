import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

/**
 * 会话与账号是 Permission 边界：签名、过期、停用、建档幂等都必须可验证，
 * 否则「谁能调用 Runtime」这件事就退化成约定而不是约束。
 */
const workdir = mkdtempSync(path.join(tmpdir(), 'pgy-auth-'));
process.env.APP_SECRET = 'test-secret-0123456789abcdef';
process.env.SESSION_COOKIE_NAME = 'pgy_session';
process.env.SESSION_HOURS = '1';
process.env.COOKIE_SECURE = 'true';
process.env.AUTH_USERS_FILE = path.join(workdir, 'users.json');
process.env.AUTH_SESSIONS_FILE = path.join(workdir, 'sessions.json');
process.env.BOOTSTRAP_ADMIN_LOGIN = 'admin';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'Admin-Pass-2026!';
process.env.BOOTSTRAP_DOCTOR_LOGIN = 'doctor';
process.env.BOOTSTRAP_DOCTOR_PASSWORD = 'Doctor-Pass-2026!';

const auth = await import('../src/server/auth.js');

/** 用同一密钥手工签发，用于构造「签名合法但已过期」的样本。 */
function signAsServer(payload: string): string {
  return createHmac('sha256', process.env.APP_SECRET ?? '').update(payload).digest('base64url');
}

before(() => {
  auth.ensureBootstrapUsers();
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

test('密码只以 scrypt 摘要存储，且校验可区分正确/错误口令', () => {
  const stored = auth.hashPassword('s3cret-passphrase');
  assert.match(stored, /^scrypt\$16384\$/);
  assert.ok(!stored.includes('s3cret-passphrase'));
  assert.equal(auth.verifyPassword('s3cret-passphrase', stored), true);
  assert.equal(auth.verifyPassword('s3cret-passphras', stored), false);
  assert.equal(auth.verifyPassword('s3cret-passphrase', 'plaintext'), false);
});

test('建档幂等：admin 与 doctor 各一个，重复调用不新增也不覆盖密码', () => {
  const first = auth.listUsers().map((u) => u.loginName).sort();
  assert.deepEqual(first, ['admin', 'doctor']);
  assert.deepEqual(auth.ensureBootstrapUsers().created, []);

  const admin = auth.findUser('admin');
  assert.ok(admin);
  assert.equal(admin.role, 'admin');
  assert.equal(auth.findUser('doctor')?.role, 'doctor');
  assert.equal(auth.verifyCredentials('admin', 'Admin-Pass-2026!')?.id, admin.id);
});

test('凭据校验：错密码与不存在的账号一律返回 null', () => {
  assert.equal(auth.verifyCredentials('admin', 'wrong-password'), null);
  assert.equal(auth.verifyCredentials('nobody', 'Admin-Pass-2026!'), null);
});

test('会话 Cookie：签名有效期内可用，被篡改或过期即失效', () => {
  const admin = auth.findUser('admin');
  assert.ok(admin);

  const cookie = auth.sessionCookieValue(admin);
  assert.match(cookie, /^pgy_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);

  const token = decodeURIComponent(cookie.split(';')[0].slice('pgy_session='.length));
  assert.equal(auth.readSessionToken(token)?.role, 'admin');

  const [, signature] = token.split('.');

  // 延长有效期：签名不匹配即拒绝（若只校验内容不校验签名，这里会通过）
  const tampered = Buffer.from(JSON.stringify({ u: admin.id, e: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url');
  assert.equal(auth.readSessionToken(`${tampered}.${signature}`), null);
  assert.equal(auth.readSessionToken(`${token.split('.')[0]}.${'A'.repeat(signature.length)}`), null);

  // 由同一密钥签发但已过期
  const expired = Buffer.from(JSON.stringify({ u: admin.id, e: 1 })).toString('base64url');
  assert.equal(auth.readSessionToken(`${expired}.${signAsServer(expired)}`), null);

  assert.equal(auth.readSessionToken(undefined), null);
  assert.equal(auth.readSessionToken('not-a-token'), null);
});

test('登出即撤销：同一 token 撤销后不再被接受', () => {
  const admin = auth.findUser('admin');
  assert.ok(admin);

  const cookie = auth.sessionCookieValue(admin);
  const token = decodeURIComponent(cookie.split(';')[0].slice('pgy_session='.length));
  assert.ok(auth.readSessionToken(token));

  auth.revokeSession(token);
  assert.equal(auth.readSessionToken(token), null);
});

test('从请求头解析会话：缺 Cookie、Cookie 名不符均为未登录', () => {
  const doctor = auth.findUser('doctor');
  assert.ok(doctor);

  const cookie = auth.sessionCookieValue(doctor);
  const pair = cookie.split(';')[0];
  const withCookie = { headers: { cookie: pair } } as unknown as Parameters<typeof auth.sessionFromRequest>[0];
  assert.equal(auth.sessionFromRequest(withCookie)?.loginName, 'doctor');

  const empty = { headers: {} } as unknown as Parameters<typeof auth.sessionFromRequest>[0];
  assert.equal(auth.sessionFromRequest(empty), null);

  const otherCookie = { headers: { cookie: pair.replace('pgy_session=', 'other=') } } as unknown as Parameters<typeof auth.sessionFromRequest>[0];
  assert.equal(auth.sessionFromRequest(otherCookie), null);
});
