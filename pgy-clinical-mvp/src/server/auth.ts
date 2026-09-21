import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { parseCookies, serializeCookie } from './http-utils.js';

/**
 * 会话与账号：Permission 属于代码边界（见 pgy_code_rules.md「AI 理解，代码约束」）。
 * 账号持久化在 JSON 文件（随 data 卷存活），密码只存 scrypt 摘要，会话为签名 Cookie，进程重启不失效。
 */
export type Role = 'admin' | 'doctor';

export interface StoredUser {
  id: string;
  loginName: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  active: boolean;
  createdAt: string;
}

/** 对外可见的会话主体（不含任何凭据）。 */
export interface SessionUser {
  id: string;
  loginName: string;
  displayName: string;
  role: Role;
}

interface AccountSpec {
  login: string;
  password: string | undefined;
  displayName: string;
  role: Role;
}

const SCRYPT_N = 16384;
const KEY_LENGTH = 64;

let cachedSecret: string | undefined;

function signingKey(): string {
  if (cachedSecret) return cachedSecret;
  const key = process.env.APP_SECRET ?? process.env.SESSION_SECRET;
  if (!key || key.length < 16) {
    throw new Error('缺少 APP_SECRET（会话签名密钥，至少 16 位字符）');
  }
  cachedSecret = key;
  return key;
}

export const authSettings = {
  get cookieName(): string {
    return process.env.SESSION_COOKIE_NAME ?? 'pgy_session';
  },
  get sessionHours(): number {
    return Number(process.env.SESSION_HOURS ?? 12);
  },
  get cookieSecure(): boolean {
    return process.env.COOKIE_SECURE === 'true';
  },
  get usersFile(): string {
    return path.resolve(process.env.AUTH_USERS_FILE ?? 'data/users.json');
  },
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(parts[3], 'base64url');
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N: Number(parts[1]) });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let cache: StoredUser[] | null = null;

function readUsers(): StoredUser[] {
  if (cache) return cache;
  const file = authSettings.usersFile;
  cache = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StoredUser[]) : [];
  return cache;
}

function writeUsers(users: StoredUser[]): void {
  cache = users;
  const file = authSettings.usersFile;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
}

/**
 * 幂等建档：仅在账号不存在时按环境变量创建，已存在的账号（含已改过的密码）绝不被覆盖。
 * 生产账号来源：BOOTSTRAP_ADMIN_* / BOOTSTRAP_DOCTOR_*。
 */
export function ensureBootstrapUsers(): { created: string[] } {
  const specs: AccountSpec[] = [
    {
      login: process.env.BOOTSTRAP_ADMIN_LOGIN ?? 'admin',
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      displayName: process.env.BOOTSTRAP_ADMIN_NAME ?? '平台管理员',
      role: 'admin',
    },
    {
      login: process.env.BOOTSTRAP_DOCTOR_LOGIN ?? 'doctor',
      password: process.env.BOOTSTRAP_DOCTOR_PASSWORD,
      displayName: process.env.BOOTSTRAP_DOCTOR_NAME ?? '医生',
      role: 'doctor',
    },
  ];

  const users = readUsers();
  const created: string[] = [];
  for (const spec of specs) {
    if (!spec.password) continue;
    if (users.some((u) => u.loginName === spec.login)) continue;
    users.push({
      id: `u_${randomBytes(6).toString('hex')}`,
      loginName: spec.login,
      displayName: spec.displayName,
      role: spec.role,
      passwordHash: hashPassword(spec.password),
      active: true,
      createdAt: new Date().toISOString(),
    });
    created.push(spec.login);
  }
  if (created.length) writeUsers(users);
  return { created };
}

export function findUser(loginName: string): StoredUser | undefined {
  return readUsers().find((u) => u.loginName === loginName);
}

export function listUsers(): SessionUser[] {
  return readUsers().map(toSessionUser);
}

function toSessionUser(user: StoredUser): SessionUser {
  return { id: user.id, loginName: user.loginName, displayName: user.displayName, role: user.role };
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/**
 * 会话登记表：签名只保证「没被篡改」，登记表才保证「已登出/已失效」立即生效。
 * 无登记表的纯签名会话在登出后仍可用到过期，对临床账号不可接受。
 */
interface SessionRecord {
  uid: string;
  exp: number;
}

let sessionCache: Record<string, SessionRecord> | null = null;

function sessionsFile(): string {
  return path.resolve(process.env.AUTH_SESSIONS_FILE ?? 'data/sessions.json');
}

function readSessions(): Record<string, SessionRecord> {
  if (sessionCache) return sessionCache;
  const file = sessionsFile();
  try {
    sessionCache = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, SessionRecord>) : {};
  } catch {
    sessionCache = {};
  }
  return sessionCache;
}

function writeSessions(sessions: Record<string, SessionRecord>): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, record] of Object.entries(sessions)) {
    if (record.exp < now) delete sessions[id];
  }
  sessionCache = sessions;
  const file = sessionsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
}

export function issueSession(user: StoredUser): { token: string; maxAge: number } {
  const maxAge = Math.round(authSettings.sessionHours * 3600);
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const jti = randomBytes(12).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ u: user.id, e: exp, j: jti })).toString('base64url');

  const sessions = readSessions();
  sessions[jti] = { uid: user.id, exp };
  writeSessions(sessions);

  return { token: `${payload}.${sign(payload)}`, maxAge };
}

/** 校验签名 → 有效期 → 登记表 → 账号当下状态；任一环节不成立即视为未登录。 */
export function readSessionToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let parsed: { u?: string; e?: number; j?: string };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: string; e?: number; j?: string };
  } catch {
    return null;
  }
  if (!parsed.u || !parsed.e || !parsed.j || parsed.e * 1000 < Date.now()) return null;

  const record = readSessions()[parsed.j];
  if (!record || record.uid !== parsed.u || record.exp * 1000 < Date.now()) return null;

  const user = readUsers().find((u) => u.id === parsed.u);
  return user && user.active ? toSessionUser(user) : null;
}

export function revokeSession(token: string | undefined): void {
  if (!token) return;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return;
  try {
    const parsed = JSON.parse(Buffer.from(token.slice(0, idx), 'base64url').toString('utf8')) as { j?: string };
    if (!parsed.j) return;
    const sessions = readSessions();
    if (sessions[parsed.j]) {
      delete sessions[parsed.j];
      writeSessions(sessions);
    }
  } catch {
    /* 非法 token 无需撤销 */
  }
}

export function sessionTokenFromRequest(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  return header ? parseCookies(header)[authSettings.cookieName] : undefined;
}

export function sessionFromRequest(req: IncomingMessage): SessionUser | null {
  return readSessionToken(sessionTokenFromRequest(req));
}

/** 登录校验：账号不存在与密码错误对外不可区分；停用账号一律拒绝。 */
export function verifyCredentials(loginName: string, password: string): StoredUser | null {
  const user = findUser(loginName);
  if (!user || !user.active) return null;
  return verifyPassword(password, user.passwordHash) ? user : null;
}

export function sessionCookieValue(user: StoredUser): string {
  const { token, maxAge } = issueSession(user);
  return serializeCookie(authSettings.cookieName, token, {
    maxAge,
    secure: authSettings.cookieSecure,
  });
}

export function clearedCookieValue(): string {
  return serializeCookie(authSettings.cookieName, '', {
    maxAge: 0,
    secure: authSettings.cookieSecure,
  });
}

export { toSessionUser };
