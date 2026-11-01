// Money Manager API (Vercel Node.js function)
//
// Environment variables
//   DATABASE_URL (or POSTGRES_URL)  set automatically when Neon Postgres is added in Vercel
//   ALLOWED_EMAILS   optional. Comma-separated emails allowed to register. If unset, only the first account can register.
//   AUTH_RATE_LIMIT  optional. Sign-in/registration attempts allowed per IP per 10 minutes (default 40).
//
// Security controls (OWASP ASVS-oriented)
//   - Parameterised SQL only; every query is scoped to the signed-in user; composite foreign keys stop
//     entries from pointing at another user's accounts (IDOR).
//   - Server-side sessions: random 256-bit token in a __Host- cookie (HttpOnly, Secure, SameSite=Strict),
//     only its SHA-256 hash is stored; absolute and idle expiry; new session on every sign-in; logout and
//     password change revoke sessions.
//   - CSRF: per-session synchronizer token required on every state-changing request, plus Origin check
//     and JSON-only bodies.
//   - Passwords: scrypt with per-user salt, length/common-password policy, account lockout after repeated
//     failures, per-IP rate limiting, constant-time comparisons, generic sign-in errors.
//   - Strict allow-list validation of every field; size limits; control characters stripped.
//   - Security headers on every response; generic error messages (details only in server logs, no user data).
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");
const scrypt = promisify(crypto.scrypt);

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const ALLOWED = (process.env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const AUTH_LIMIT = Math.max(5, parseInt(process.env.AUTH_RATE_LIMIT || "40", 10) || 40);
const AUTH_WINDOW_MIN = 10;
const SESSION_DAYS = 14, IDLE_DAYS = 7;
const MAX_FAILS = 10, LOCK_MINUTES = 15;
const MAX_BODY = 64 * 1024;

const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
const ID_RE = /^[0-9]{1,18}$/;
const KINDS = ["expense", "income", "transfer"];
const TYPES = ["Need", "Want", "Investment"];
const SLOTS = [["bank", 1], ["bank", 2], ["card", 1], ["card", 2], ["cash", 1]];
const COMMON_PASSWORDS = new Set(["password", "password1", "password12", "password123", "1234567890", "12345678910", "qwertyuiop",
  "iloveyou123", "welcome123", "admin12345", "letmein123", "football123", "abcdef1234", "qwerty1234", "password@123",
  "india12345", "passw0rd123", "1q2w3e4r5t", "zaq12wsxcde", "monkey12345"]);

class ClientError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg) => new ClientError(400, msg);

// ---------- database ----------
let pool = null, ready = null;
function connectionString() {
  // Neon's URL says sslmode=require, which pg treats as verify-full; say so explicitly (same security, no warning).
  try {
    const u = new URL(DB_URL);
    if (["prefer", "require", "verify-ca"].includes(u.searchParams.get("sslmode"))) u.searchParams.set("sslmode", "verify-full");
    return u.toString();
  } catch { return DB_URL; }
}
function db() {
  if (!pool) pool = new Pool({ connectionString: connectionString(), max: 3, idleTimeoutMillis: 10000, statement_timeout: 10000 });
  return pool;
}
const q = (text, params) => db().query(text, params);
async function tx(fn) {
  const c = await db().connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}
const addConstraint = (table, name, def) =>
  `do $$ begin alter table ${table} add constraint ${name} ${def}; exception when duplicate_object or duplicate_table then null; end $$;`;

async function ensureSchema() {
  if (!ready) {
    ready = tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(727274)");
      await c.query(`create table if not exists mm_meta (key text primary key, value text not null)`);
      await c.query(`create table if not exists mm_users (
        email text primary key, pass_hash text not null, failed_logins int not null default 0,
        locked_until timestamptz, created_at timestamptz not null default now())`);
      await c.query(`create table if not exists mm_sessions (
        token_hash text primary key, user_email text not null references mm_users(email) on delete cascade,
        csrf text not null, created_at timestamptz not null default now(),
        last_seen timestamptz not null default now(), expires_at timestamptz not null)`);
      await c.query(`create index if not exists mm_sessions_user on mm_sessions (user_email)`);
      await c.query(`create table if not exists mm_rate (key text primary key, window_start timestamptz not null, hits int not null)`);
      await c.query(`create table if not exists mm_accounts (
        id bigserial primary key,
        user_email text not null references mm_users(email) on delete cascade,
        kind text not null check (kind in ('bank','card','cash')),
        slot smallint not null check (slot in (1,2) and (kind <> 'cash' or slot = 1)),
        name text not null check (length(name) between 1 and 60),
        opening_balance numeric(14,2) not null default 0 check (opening_balance >= 0),
        credit_limit numeric(14,2) check (credit_limit is null or credit_limit > 0),
        created_at timestamptz not null default now(),
        unique (user_email, kind, slot), unique (user_email, id))`);
      await c.query(`create table if not exists mm_expenses (
        id bigserial primary key, user_email text not null,
        month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        expense_date date, name text, amount numeric(12,2) not null check (amount >= 0),
        category text, type text check (type in ('Need','Want','Investment')),
        created_at timestamptz not null default now())`);
      await c.query(`alter table mm_expenses add column if not exists kind text not null default 'expense'`);
      await c.query(`alter table mm_expenses add column if not exists account_id bigint`);
      await c.query(`alter table mm_expenses add column if not exists to_account_id bigint`);
      await c.query(addConstraint("mm_expenses", "mm_exp_kind", "check (kind in ('expense','income','transfer'))"));
      await c.query(addConstraint("mm_expenses", "mm_exp_type_only_expense", "check (kind = 'expense' or type is null)"));
      await c.query(addConstraint("mm_expenses", "mm_exp_to_only_transfer", "check (kind = 'transfer' or to_account_id is null)"));
      await c.query(addConstraint("mm_expenses", "mm_exp_transfer_pair",
        "check (kind <> 'transfer' or (account_id is not null and to_account_id is not null and account_id <> to_account_id))"));
      await c.query(addConstraint("mm_expenses", "mm_exp_account_owner",
        "foreign key (user_email, account_id) references mm_accounts (user_email, id) on delete restrict"));
      await c.query(addConstraint("mm_expenses", "mm_exp_to_account_owner",
        "foreign key (user_email, to_account_id) references mm_accounts (user_email, id) on delete restrict"));
      await c.query(`create index if not exists mm_expenses_user_month on mm_expenses (user_email, month)`);
      await c.query(`create index if not exists mm_expenses_account on mm_expenses (user_email, account_id)`);
      await c.query(`create index if not exists mm_expenses_to_account on mm_expenses (user_email, to_account_id)`);
      // One-time upgrade: earlier versions stored salary per month; turn each into an Income entry.
      await c.query(`create table if not exists mm_salaries (user_email text not null, month text not null,
        amount numeric(12,2) not null default 0, primary key (user_email, month))`);
      const done = await c.query(`insert into mm_meta (key, value) values ('salaries_migrated', '1') on conflict (key) do nothing returning key`);
      if (done.rows.length) {
        await c.query(`insert into mm_expenses (user_email, month, expense_date, name, amount, category, kind, created_at)
          select user_email, month, (month || '-01')::date, 'Salary', amount, 'Salary', 'income', (month || '-01')::timestamptz
          from mm_salaries where amount > 0`);
      }
    }).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function housekeeping() {
  if (Math.random() > 0.02) return;
  await q(`delete from mm_sessions where expires_at < now() or last_seen < now() - make_interval(days => $1::int)`, [IDLE_DAYS]).catch(() => {});
  await q(`delete from mm_rate where window_start < now() - interval '1 day'`).catch(() => {});
}

// ---------- HTTP helpers ----------
const SECURITY_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
};
function send(res, status, obj, extra = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    const raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : null;
    if (raw === null) { if (JSON.stringify(req.body).length > MAX_BODY) throw new ClientError(413, "Request too large"); return req.body; }
    if (raw.length > MAX_BODY) throw new ClientError(413, "Request too large");
    return raw ? JSON.parse(raw) : {};
  }
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > MAX_BODY) throw new ClientError(413, "Request too large"); chunks.push(ch); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
const isHttps = (req) => (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
const cookieName = (req) => (isHttps(req) ? "__Host-mm_sid" : "mm_sid");
function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function sessionCookie(req, token, maxAgeSec) {
  return `${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? "; Secure" : ""}`;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                      // same-origin fetches from older browsers may omit it
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
}
function clientIp(req) {
  return String(req.headers["x-real-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "unknown").trim().slice(0, 64);
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rateLimit(key, limit, windowMin) {
  const r = await q(`insert into mm_rate (key, window_start, hits) values ($1, now(), 1)
    on conflict (key) do update set
      hits = case when mm_rate.window_start < now() - make_interval(mins => $2::int) then 1 else mm_rate.hits + 1 end,
      window_start = case when mm_rate.window_start < now() - make_interval(mins => $2::int) then now() else mm_rate.window_start end
    returning hits`, [key, windowMin]);
  if (r.rows[0].hits > limit) throw new ClientError(429, "Too many attempts from this network. Please wait a few minutes and try again.");
}

// ---------- validation ----------
function text(v, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" && typeof v !== "number") throw bad("Invalid text");
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) throw bad(`Text is too long (max ${max} characters)`);
  return s || null;
}
function money(v, { allowZero = false } = {}) {
  if (typeof v !== "string" && typeof v !== "number") throw bad("Invalid amount");
  const s = String(v).trim();
  if (!MONEY_RE.test(s)) throw bad("Invalid amount");
  if (!allowZero && Number(s) === 0) throw bad("Amount must be more than zero");
  return s;  // passed to Postgres as exact text
}
function id(v, { optional = false } = {}) {
  if ((v === null || v === undefined || v === "") && optional) return null;
  if (!ID_RE.test(String(v))) throw bad("Invalid account");
  return String(v);
}
function emailOf(v) {
  const e = String(v || "").trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw bad("Enter a valid email address");
  return e;
}
function passwordProblem(pw, email) {
  if (typeof pw !== "string" || pw.length < 10 || pw.length > 128) return "Password must be 10 to 128 characters";
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return "This password is too common";
  const local = String(email || "").split("@")[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return "Password must not contain your email name";
  if (/^(.)\1+$/.test(pw)) return "Password must not be one repeated character";
  return null;
}
function cleanAccounts(list) {
  if (!Array.isArray(list) || list.length > 5) throw bad("Invalid accounts");
  const out = new Map();
  for (const a of list) {
    if (!a || typeof a !== "object") throw bad("Invalid accounts");
    const key = SLOTS.find(([k, s]) => k === a.kind && s === Number(a.slot));
    if (!key) throw bad("Invalid account type");
    const k = key.join(":");
    if (out.has(k)) throw bad("Duplicate account");
    const name = a.kind === "cash" ? "Cash" : text(a.name, 60);
    if (!name) throw bad("Account name is required");
    const opening = money(a.opening_balance ?? "0", { allowZero: true });
    let limit = null;
    if (a.kind === "card") limit = money(a.credit_limit, { allowZero: false });
    out.set(k, { kind: a.kind, slot: Number(a.slot), name, opening, limit });
  }
  if (!out.has("bank:1")) throw bad("Bank account 1 is required");
  if (!out.has("cash:1")) out.set("cash:1", { kind: "cash", slot: 1, name: "Cash", opening: "0", limit: null });
  return [...out.values()];
}
function cleanTxn(row) {
  if (!row || typeof row !== "object") throw bad("Missing entry");
  const kind = row.kind;
  if (!KINDS.includes(kind)) throw bad("Invalid entry type");
  const month = String(row.month || "");
  if (!MONTH_RE.test(month)) throw bad("Invalid month");
  let date = row.expense_date ?? null;
  if (date !== null && date !== "") {
    date = String(date);
    const d = new Date(date + "T00:00:00Z");
    if (!DATE_RE.test(date) || date.slice(0, 7) !== month || isNaN(d) || d.toISOString().slice(0, 10) !== date) throw bad("Date must be a valid day in the selected month");
  } else date = null;
  const t = { kind, month, date, amount: money(row.amount), name: text(row.name, 120), category: null, type: null, account: null, to: null };
  if (kind === "expense") {
    t.type = row.type ? String(row.type) : null;
    if (t.type !== null && !TYPES.includes(t.type)) throw bad("Invalid Need/Want/Investment value");
    t.category = text(row.category, 60);
    t.account = id(row.account_id, { optional: true });
  } else if (kind === "income") {
    t.category = text(row.category, 60);
    t.account = id(row.account_id, { optional: true });
  } else {
    t.account = id(row.account_id);
    t.to = id(row.to_account_id);
    if (t.account === t.to) throw bad("Choose two different accounts");
  }
  return t;
}

// ---------- passwords & sessions ----------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(String(pw).slice(0, 128), Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

async function createSession(client, req, email) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  await client.query(`delete from mm_sessions where user_email = $1 and (expires_at < now() or last_seen < now() - make_interval(days => $2::int))`, [email, IDLE_DAYS]);
  await client.query(`insert into mm_sessions (token_hash, user_email, csrf, expires_at) values ($1, $2, $3, now() + make_interval(days => $4::int))`,
    [sha256(token), email, csrf, SESSION_DAYS]);
  return { cookie: sessionCookie(req, token, SESSION_DAYS * 86400), csrf };
}
async function getSession(req) {
  const token = readCookie(req, cookieName(req));
  if (!token || token.length > 100) return null;
  const h = sha256(token);
  const r = await q(`select user_email, csrf, last_seen < now() - interval '10 minutes' as stale from mm_sessions
    where token_hash = $1 and expires_at > now() and last_seen > now() - make_interval(days => $2::int)`, [h, IDLE_DAYS]);
  if (!r.rows.length) return null;
  if (r.rows[0].stale) await q(`update mm_sessions set last_seen = now() where token_hash = $1`, [h]);
  return { email: r.rows[0].user_email, csrf: r.rows[0].csrf, tokenHash: h };
}

// ---------- operations ----------
async function insertAccounts(c, email, accounts) {
  for (const a of accounts) {
    await c.query(`insert into mm_accounts (user_email, kind, slot, name, opening_balance, credit_limit) values ($1,$2,$3,$4,$5,$6)`,
      [email, a.kind, a.slot, a.name, a.opening, a.limit]);
  }
}
async function register(req, res, body) {
  await rateLimit("auth:" + clientIp(req), AUTH_LIMIT, AUTH_WINDOW_MIN);
  const email = emailOf(body.email);
  const problem = passwordProblem(body.password, email);
  if (problem) throw bad(problem);
  const accounts = cleanAccounts(body.accounts);
  const hash = await hashPassword(body.password);
  const s = await tx(async (c) => {
    await c.query("select pg_advisory_xact_lock(727275)");
    // Password reset: someone with database access sets pass_hash = 'RESET'; the owner then registers again
    // with the same email to choose a new password. Existing accounts and entries are kept.
    const existing = await c.query("select pass_hash from mm_users where email = $1 for update", [email]);
    if (existing.rows.length && existing.rows[0].pass_hash === "RESET") {
      await c.query("update mm_users set pass_hash = $2, failed_logins = 0, locked_until = null where email = $1", [email, hash]);
      await c.query("delete from mm_sessions where user_email = $1", [email]);
      const has = await c.query("select count(*)::int as n from mm_accounts where user_email = $1", [email]);
      if (!has.rows[0].n) await insertAccounts(c, email, accounts);
      return createSession(c, req, email);
    }
    if (existing.rows.length) throw new ClientError(409, "An account with this email already exists. Please sign in.");
    if (ALLOWED.length) {
      if (!ALLOWED.includes(email)) throw new ClientError(403, "This email is not allowed to register.");
    } else {
      const n = await c.query("select count(*)::int as n from mm_users");
      if (n.rows[0].n > 0) throw new ClientError(403, "Registration is closed. An account already exists for this app.");
    }
    const ins = await c.query("insert into mm_users (email, pass_hash) values ($1, $2) on conflict (email) do nothing returning email", [email, hash]);
    if (!ins.rows.length) throw new ClientError(409, "An account with this email already exists. Please sign in.");
    await insertAccounts(c, email, accounts);
    return createSession(c, req, email);
  });
  return send(res, 200, { email, csrf: s.csrf }, { "Set-Cookie": s.cookie });
}
async function login(req, res, body) {
  await rateLimit("auth:" + clientIp(req), AUTH_LIMIT, AUTH_WINDOW_MIN);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  const password = typeof body.password === "string" ? body.password : "";
  const u = await q("select pass_hash, locked_until > now() as locked from mm_users where email = $1", [email]);
  const user = u.rows[0];
  if (user && user.locked) throw new ClientError(429, `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`);
  const ok = await checkPassword(password, user ? user.pass_hash : DUMMY_HASH);
  if (!user || !ok) {
    if (user) {
      await q(`update mm_users u set failed_logins = f.n,
          locked_until = case when f.n >= $2::int then now() + make_interval(mins => $3::int) else null end
        from (select email, case when locked_until is not null and locked_until <= now() then 1 else failed_logins + 1 end as n
              from mm_users where email = $1) f where u.email = f.email`, [email, MAX_FAILS, LOCK_MINUTES]);
    }
    await sleep(300 + crypto.randomInt(200));
    throw new ClientError(401, "Incorrect email or password.");
  }
  const s = await tx(async (c) => {
    await c.query("update mm_users set failed_logins = 0, locked_until = null where email = $1", [email]);
    return createSession(c, req, email);
  });
  return send(res, 200, { email, csrf: s.csrf }, { "Set-Cookie": s.cookie });
}
async function changePassword(req, res, sess, body) {
  await rateLimit("auth:" + clientIp(req), AUTH_LIMIT, AUTH_WINDOW_MIN);
  const u = await q("select pass_hash from mm_users where email = $1", [sess.email]);
  if (!u.rows.length || !(await checkPassword(body.current, u.rows[0].pass_hash))) {
    await sleep(300);
    throw new ClientError(400, "Current password is incorrect.");
  }
  const problem = passwordProblem(body.next, sess.email);
  if (problem) throw bad(problem);
  const hash = await hashPassword(body.next);
  await tx(async (c) => {
    await c.query("update mm_users set pass_hash = $2, failed_logins = 0, locked_until = null where email = $1", [sess.email, hash]);
    await c.query("delete from mm_sessions where user_email = $1 and token_hash <> $2", [sess.email, sess.tokenHash]);  // sign out other devices
  });
  return send(res, 200, { ok: true });
}
const ACC_COLS = `id::text as id, kind, slot, name, opening_balance::float8 as opening_balance, credit_limit::float8 as credit_limit`;
const TXN_COLS = `id::text as id, kind, month, to_char(expense_date, 'YYYY-MM-DD') as expense_date, name, amount::float8 as amount,
  category, type, account_id::text as account_id, to_account_id::text as to_account_id, created_at`;

async function saveAccounts(sess, body) {
  const accounts = cleanAccounts(body.accounts);
  const keep = new Set(accounts.map((a) => a.kind + ":" + a.slot));
  return tx(async (c) => {
    for (const a of accounts) {
      await c.query(`insert into mm_accounts (user_email, kind, slot, name, opening_balance, credit_limit) values ($1,$2,$3,$4,$5,$6)
        on conflict (user_email, kind, slot) do update set name = excluded.name, opening_balance = excluded.opening_balance,
        credit_limit = excluded.credit_limit`, [sess.email, a.kind, a.slot, a.name, a.opening, a.limit]);
    }
    for (const [kind, slot] of SLOTS) {
      if (keep.has(kind + ":" + slot)) continue;
      const used = await c.query(`select a.name from mm_accounts a where a.user_email = $1 and a.kind = $2 and a.slot = $3
        and exists (select 1 from mm_expenses e where e.user_email = $1 and (e.account_id = a.id or e.to_account_id = a.id))`, [sess.email, kind, slot]);
      if (used.rows.length) throw new ClientError(409, `"${used.rows[0].name}" has entries, so it can't be removed. Move or delete those entries first.`);
      await c.query(`delete from mm_accounts where user_email = $1 and kind = $2 and slot = $3`, [sess.email, kind, slot]);
    }
    const r = await c.query(`select ${ACC_COLS} from mm_accounts where user_email = $1 order by kind, slot`, [sess.email]);
    return r.rows;
  });
}
async function checkTxnAccounts(email, t, existing) {
  const ids = [t.account, t.to].filter(Boolean);
  const r = ids.length ? await q(`select id::text as id, kind from mm_accounts where user_email = $1 and id = any($2::bigint[])`, [email, ids]) : { rows: [] };
  const kindOf = Object.fromEntries(r.rows.map((x) => [x.id, x.kind]));
  for (const i of ids) if (!kindOf[i]) throw bad("Invalid account");
  if (t.kind === "transfer" && kindOf[t.account] === "card") throw bad("Transfers must come from a bank account or cash");
  if (!t.account && t.kind !== "transfer") {
    // Only entries from before accounts existed may stay unlinked.
    if (!existing || existing.account_id !== null) throw bad("Choose an account");
  }
}
async function addTxn(sess, body) {
  const t = cleanTxn(body.row);
  await checkTxnAccounts(sess.email, t, null);
  const r = await q(`insert into mm_expenses (user_email, kind, month, expense_date, name, amount, category, type, account_id, to_account_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${TXN_COLS}`,
    [sess.email, t.kind, t.month, t.date, t.name, t.amount, t.category, t.type, t.account, t.to]);
  return r.rows[0];
}
async function updateTxn(sess, body) {
  const txnId = id(body.id);
  const t = cleanTxn(body.row);
  const ex = await q(`select account_id::text as account_id from mm_expenses where id = $1::bigint and user_email = $2`, [txnId, sess.email]);
  if (!ex.rows.length) throw new ClientError(404, "Entry not found");
  await checkTxnAccounts(sess.email, t, ex.rows[0]);
  const r = await q(`update mm_expenses set kind=$3, month=$4, expense_date=$5, name=$6, amount=$7, category=$8, type=$9, account_id=$10, to_account_id=$11
    where id = $1::bigint and user_email = $2 returning ${TXN_COLS}`,
    [txnId, sess.email, t.kind, t.month, t.date, t.name, t.amount, t.category, t.type, t.account, t.to]);
  return r.rows[0];
}

// ---------- handler ----------
module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed" }, { Allow: "GET, POST" });
    const url = new URL(req.url, "http://localhost");
    let body = {};
    if (req.method === "POST") {
      if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return send(res, 415, { error: "JSON required" });
      if (!sameOrigin(req)) return send(res, 403, { error: "Cross-site request blocked" });
      body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Malformed request");
    }
    const op = req.method === "POST" ? body.op : url.searchParams.get("op");
    if (typeof op !== "string" || op.length > 40) throw bad("Unknown operation");

    if (op === "config" && req.method === "GET") return send(res, 200, { db: !!DB_URL, registrationRestricted: ALLOWED.length > 0 });
    if (!DB_URL) return send(res, 503, { error: "Database not connected. Add Neon Postgres to the Vercel project and redeploy." });
    await ensureSchema();
    housekeeping();

    if (req.method === "POST" && op === "register") return await register(req, res, body);
    if (req.method === "POST" && op === "login") return await login(req, res, body);

    const sess = await getSession(req);
    if (op === "session" && req.method === "GET") {
      return send(res, 200, sess ? { authenticated: true, email: sess.email, csrf: sess.csrf } : { authenticated: false });
    }
    if (!sess) return send(res, 401, { error: "Please sign in." });
    if (req.method === "POST" && !safeEqual(req.headers["x-csrf-token"] || "", sess.csrf)) {
      return send(res, 403, { error: "Security check failed. Reload the page and try again." });
    }

    if (req.method === "GET" && op === "all") {
      const acc = await q(`select ${ACC_COLS} from mm_accounts where user_email = $1 order by kind, slot`, [sess.email]);
      const txs = await q(`select ${TXN_COLS} from mm_expenses where user_email = $1 order by created_at, id`, [sess.email]);
      return send(res, 200, { accounts: acc.rows, transactions: txs.rows });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

    switch (op) {
      case "logout":
        await q("delete from mm_sessions where token_hash = $1", [sess.tokenHash]);
        return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
      case "changePassword": return await changePassword(req, res, sess, body);
      case "saveAccounts": return send(res, 200, { accounts: await saveAccounts(sess, body) });
      case "addTxn": return send(res, 200, { row: await addTxn(sess, body) });
      case "updateTxn": return send(res, 200, { row: await updateTxn(sess, body) });
      case "deleteTxn":
        await q(`delete from mm_expenses where id = $1::bigint and user_email = $2`, [id(body.id), sess.email]);
        return send(res, 200, { ok: true });
      default: throw bad("Unknown operation");
    }
  } catch (e) {
    if (e instanceof ClientError) return send(res, e.status, { error: e.message });
    if (e instanceof SyntaxError) return send(res, 400, { error: "Malformed request" });
    if (e && e.code === "23503") return send(res, 409, { error: "That account is in use by other entries." });
    if (e && ["23514", "22P02", "22003", "22007", "22008", "23502"].includes(e.code)) return send(res, 400, { error: "Invalid data" });
    console.error("api error", e && e.code ? e.code : "", e && e.message ? e.message : e);
    return send(res, 500, { error: "Something went wrong. Please try again." });
  }
};
