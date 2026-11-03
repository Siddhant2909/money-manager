// Money Manager API (Vercel Node.js function)
//
// Environment variables
//   DATABASE_URL (or POSTGRES_URL)  set automatically when Neon Postgres is added in Vercel
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  required. Google OAuth web client used for sign-in (the only way in).
//   ALLOWED_EMAILS   optional. Comma-separated Google emails allowed to create an account. If unset, anyone
//                    with a Google account can sign up (each user only ever sees their own data).
//   AUTH_RATE_LIMIT  optional. Sign-in attempts allowed per IP per 10 minutes (default 40).
//   APP_URL          optional. Public URL of the app (e.g. https://money.example.com), used for the Google
//                    redirect URI. If unset, it is taken from the request's host.
//
// Security controls (OWASP ASVS-oriented)
//   - Parameterised SQL only; every query is scoped to the signed-in user; composite foreign keys stop
//     entries from pointing at another user's accounts (IDOR).
//   - Server-side sessions: random 256-bit token in a __Host- cookie (HttpOnly, Secure, SameSite=Strict),
//     only its SHA-256 hash is stored; absolute and idle expiry; new session on every sign-in; logout
//     revokes the session.
//   - CSRF: per-session synchronizer token required on every state-changing request, plus Origin check
//     and JSON-only bodies.
//   - Sign-in: Google only (OAuth 2.0 code flow with PKCE and a one-time state); per-IP rate limiting.
//     There are no passwords to guess or leak.
//   - Strict allow-list validation of every field; size limits; control characters stripped.
//   - Security headers on every response; generic error messages (details only in server logs, no user data).
const crypto = require("crypto");
const { Pool } = require("pg");

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const ALLOWED = (process.env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const AUTH_LIMIT = Math.max(5, parseInt(process.env.AUTH_RATE_LIMIT || "40", 10) || 40);
const AUTH_WINDOW_MIN = 10;
const SESSION_DAYS = 14, IDLE_DAYS = 7;
const MAX_BODY = 64 * 1024;
const G_ID = process.env.GOOGLE_CLIENT_ID || "", G_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const googleOn = () => !!(G_ID && G_SECRET);

const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
const ID_RE = /^[0-9]{1,18}$/;
const KINDS = ["expense", "income", "transfer", "invest"];
// Investments are their own entry type (not spending). The type is kept in the category column.
const INVEST_TYPES = ["Mutual fund", "Stocks", "Gold", "FD", "RD", "PPF", "NPS", "Other"];
const TYPES = ["Need", "Want", "Investment"];
// Prepaid cards / wallets (metro card, FASTag, Paytm...) hold your own money, like a small bank account.
const SLOTS = [["bank", 1], ["bank", 2], ["card", 1], ["card", 2], ["prepaid", 1], ["prepaid", 2], ["cash", 1]];
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
      await c.query(`alter table mm_users add column if not exists name text`);
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
      // v2 of the account kind check adds 'prepaid'.
      await c.query(`alter table mm_accounts drop constraint if exists mm_accounts_kind_check`);
      await c.query(addConstraint("mm_accounts", "mm_acc_kind2", "check (kind in ('bank','card','cash','prepaid'))"));
      await c.query(`create table if not exists mm_expenses (
        id bigserial primary key, user_email text not null,
        month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        expense_date date, name text, amount numeric(12,2) not null check (amount >= 0),
        category text, type text check (type in ('Need','Want','Investment')),
        created_at timestamptz not null default now())`);
      await c.query(`alter table mm_expenses add column if not exists kind text not null default 'expense'`);
      await c.query(`alter table mm_expenses add column if not exists account_id bigint`);
      await c.query(`alter table mm_expenses add column if not exists to_account_id bigint`);
      // v2 of the kind check adds 'invest'.
      await c.query(`alter table mm_expenses drop constraint if exists mm_exp_kind`);
      await c.query(addConstraint("mm_expenses", "mm_exp_kind2", "check (kind in ('expense','income','transfer','invest'))"));
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
      // Recurring payments (rent, maid, SIPs, RDs, salary...). next_due is the date of the next entry to add.
      await c.query(`create table if not exists mm_recurring (
        id bigserial primary key, user_email text not null references mm_users(email) on delete cascade,
        kind text not null,
        name text not null check (length(name) between 1 and 120),
        amount numeric(12,2) not null check (amount > 0),
        category text, type text check (type in ('Need','Want','Investment')),
        account_id bigint, to_account_id bigint,
        day smallint not null check (day between 1 and 31),
        next_due date not null, auto boolean not null default true,
        created_at timestamptz not null default now(),
        check (kind = 'expense' or type is null),
        check (kind = 'transfer' or to_account_id is null),
        check (kind <> 'transfer' or (account_id is not null and to_account_id is not null and account_id <> to_account_id)),
        foreign key (user_email, account_id) references mm_accounts (user_email, id) on delete restrict,
        foreign key (user_email, to_account_id) references mm_accounts (user_email, id) on delete restrict)`);
      await c.query(`create index if not exists mm_recurring_user on mm_recurring (user_email, next_due)`);
      await c.query(`alter table mm_recurring drop constraint if exists mm_recurring_kind_check`);
      await c.query(addConstraint("mm_recurring", "mm_rec_kind2", "check (kind in ('expense','income','transfer','invest'))"));
      // How often it repeats: monthly, or every 84 days for the Recharge category (existing ones stay monthly).
      await c.query(`alter table mm_recurring add column if not exists every smallint not null default 1`);
      await c.query(`alter table mm_recurring add column if not exists unit text not null default 'month'`);
      await c.query(addConstraint("mm_recurring", "mm_rec_interval", "check ((unit = 'month' and every = 1) or (unit = 'day' and every = 84))"));
      await c.query(`alter table mm_expenses add column if not exists recurring_id bigint`);
      // Monthly budgets: category null = the overall monthly budget.
      await c.query(`create table if not exists mm_budgets (
        id bigserial primary key, user_email text not null references mm_users(email) on delete cascade,
        category text, amount numeric(12,2) not null check (amount > 0))`);
      await c.query(`create unique index if not exists mm_budgets_cat on mm_budgets (user_email, (lower(coalesce(category, ''))))`);
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
function nameOf(v) {
  const n = text(v, 60);
  if (!n) throw bad("Enter your name");
  return n;
}
function cleanAccounts(list) {
  if (!Array.isArray(list) || list.length > SLOTS.length) throw bad("Invalid accounts");
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
  } else if (kind === "invest") {
    const typ = INVEST_TYPES.find((x) => x.toLowerCase() === String(row.category || "").trim().toLowerCase());
    if (!typ) throw bad("Choose the type of investment");
    t.category = typ;
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

// ---------- sessions ----------
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
  const r = await q(`select s.user_email, s.csrf, u.name, s.last_seen < now() - interval '10 minutes' as stale
    from mm_sessions s join mm_users u on u.email = s.user_email
    where s.token_hash = $1 and s.expires_at > now() and s.last_seen > now() - make_interval(days => $2::int)`, [h, IDLE_DAYS]);
  if (!r.rows.length) return null;
  if (r.rows[0].stale) await q(`update mm_sessions set last_seen = now() where token_hash = $1`, [h]);
  const row = r.rows[0];
  return { email: row.user_email, name: row.name || null, csrf: row.csrf, tokenHash: h };
}

// ---------- operations ----------
const ACC_COLS = `id::text as id, kind, slot, name, opening_balance::float8 as opening_balance, credit_limit::float8 as credit_limit`;
const TXN_COLS = `id::text as id, kind, month, to_char(expense_date, 'YYYY-MM-DD') as expense_date, name, amount::float8 as amount,
  category, type, account_id::text as account_id, to_account_id::text as to_account_id, recurring_id::text as recurring_id, created_at`;
const REC_COLS = `id::text as id, kind, name, amount::float8 as amount, category, type, account_id::text as account_id,
  to_account_id::text as to_account_id, day, every, unit, to_char(next_due, 'YYYY-MM-DD') as next_due, auto`;
// Same row, with the amount as exact text, for copying into entries.
const REC_RAW = `id::text as id, kind, name, amount::text as amount, category, type, account_id::text as account_id,
  to_account_id::text as to_account_id, day, every, unit, to_char(next_due, 'YYYY-MM-DD') as next_due`;
const BUD_COLS = `id::text as id, category, amount::float8 as amount`;

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
      const rec = await c.query(`select a.name from mm_accounts a where a.user_email = $1 and a.kind = $2 and a.slot = $3
        and exists (select 1 from mm_recurring r where r.user_email = $1 and (r.account_id = a.id or r.to_account_id = a.id))`, [sess.email, kind, slot]);
      if (rec.rows.length) throw new ClientError(409, `"${rec.rows[0].name}" is used by a recurring payment, so it can't be removed. Change or delete that first.`);
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
  if (t.kind === "transfer" && kindOf[t.account] === "card") throw bad("Transfers must come from a bank account, prepaid card or cash");
  if (!t.account && t.kind !== "transfer") {
    // Only entries from before accounts existed may stay unlinked.
    if (!existing || existing.account_id !== null) throw bad("Choose an account");
  }
}
async function addTxn(sess, body) {
  const t = cleanTxn(body.row);
  await checkTxnAccounts(sess.email, t, null);
  if (!body.repeat) {
    const r = await q(`insert into mm_expenses (user_email, kind, month, expense_date, name, amount, category, type, account_id, to_account_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${TXN_COLS}`,
      [sess.email, t.kind, t.month, t.date, t.name, t.amount, t.category, t.type, t.account, t.to]);
    return { row: r.rows[0] };
  }
  // "Repeat": save this entry and a recurring payment whose next one is a month later (84 days for a Recharge).
  if (!t.account) throw bad("Choose an account");
  const date = t.date || t.month + "-01", day = Number(date.slice(8, 10)), iv = intervalFor(t);
  const name = t.name || t.category || (t.kind === "income" ? "Income" : t.kind === "transfer" ? "Transfer" : t.kind === "invest" ? "Investment" : "Payment");
  return tx(async (c) => {
    const rec = await c.query(`insert into mm_recurring (user_email, kind, name, amount, category, type, account_id, to_account_id, day, next_due, auto, every, unit)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning ${REC_COLS}`,
      [sess.email, t.kind, name, t.amount, t.category, t.type, t.account, t.to, day, nextDue(date, { day, ...iv }), body.repeat.auto !== false, iv.every, iv.unit]);
    const r = await c.query(`insert into mm_expenses (user_email, kind, month, expense_date, name, amount, category, type, account_id, to_account_id, recurring_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${TXN_COLS}`,
      [sess.email, t.kind, t.month, date, t.name, t.amount, t.category, t.type, t.account, t.to, rec.rows[0].id]);
    return { row: r.rows[0], recurring: rec.rows[0] };
  });
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

// ---------- dates in India Standard Time ----------
const pad2 = (n) => String(n).padStart(2, "0");
function istNow() {
  const d = new Date(Date.now() + 330 * 60000);   // IST is UTC+5:30 all year
  return { date: d.toISOString().slice(0, 10) };
}
// The given day of a month, moved back to the month's last day if needed (31 → 30 Apr, 28/29 Feb).
function clampDate(y, m, day) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad2(m)}-${pad2(Math.min(day, last))}`;
}
// The next date after `date`: N days later (recharges), or the same day N months later.
function nextDue(date, { day, every = 1, unit = "month" }) {
  const n = Number(every) || 1;
  if (unit === "day") {
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const total = Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1) + n;
  return clampDate(Math.floor(total / 12), (total % 12) + 1, Number(day) || Number(date.slice(8, 10)));
}
// Recurring payments repeat every month, except the built-in "Recharge" expense category,
// which always repeats every 84 days.
const RECHARGE = { every: 84, unit: "day" }, MONTHLY = { every: 1, unit: "month" };
const isRecharge = (t) => t.kind === "expense" && String(t.category || "").trim().toLowerCase() === "recharge";
const intervalFor = (t) => (isRecharge(t) ? RECHARGE : MONTHLY);

// ---------- recurring payments ----------
function cleanRecurring(row) {
  if (!row || typeof row !== "object") throw bad("Missing recurring payment");
  const due = String(row.next_due || "");
  if (!DATE_RE.test(due)) throw bad("Choose the next due date");
  const t = cleanTxn({ ...row, month: due.slice(0, 7), expense_date: due });
  if (!t.name) throw bad("Give it a name, e.g. Rent");
  if (!t.account) throw bad("Choose an account");
  const day = row.day === undefined || row.day === null || row.day === "" ? Number(due.slice(8, 10)) : Number(row.day);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw bad("Invalid day of the month");
  return { ...t, next_due: due, day, auto: row.auto !== false, ...intervalFor(t) };
}
async function saveRecurring(sess, body) {
  const r = cleanRecurring(body.row);
  await checkTxnAccounts(sess.email, { kind: r.kind, account: r.account, to: r.to }, null);
  const vals = [sess.email, r.kind, r.name, r.amount, r.category, r.type, r.account, r.to, r.day, r.next_due, r.auto, r.every, r.unit];
  if (body.id) {
    const u = await q(`update mm_recurring set kind=$2, name=$3, amount=$4, category=$5, type=$6, account_id=$7, to_account_id=$8, day=$9, next_due=$10, auto=$11,
      every=$12, unit=$13 where user_email = $1 and id = $14::bigint returning ${REC_COLS}`, [...vals, id(body.id)]);
    if (!u.rows.length) throw new ClientError(404, "Recurring payment not found");
    return u.rows[0];
  }
  const n = await q(`select count(*)::int as n from mm_recurring where user_email = $1`, [sess.email]);
  if (n.rows[0].n >= 100) throw bad("You can have up to 100 recurring payments");
  const ins = await q(`insert into mm_recurring (user_email, kind, name, amount, category, type, account_id, to_account_id, day, next_due, auto, every, unit)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning ${REC_COLS}`, vals);
  return ins.rows[0];
}
// Adds the entry for a recurring payment's next due date, then moves next_due on by one interval.
async function postOccurrence(c, email, r, date) {
  const d = date || r.next_due;
  const e = await c.query(`insert into mm_expenses (user_email, kind, month, expense_date, name, amount, category, type, account_id, to_account_id, recurring_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${TXN_COLS}`,
    [email, r.kind, d.slice(0, 7), d, r.name, r.amount, r.category, r.type, r.account_id, r.to_account_id, r.id]);
  await advance(c, email, r);
  return e.rows[0];
}
async function advance(c, email, r) {
  r.next_due = nextDue(r.next_due, r);
  await c.query(`update mm_recurring set next_due = $3 where user_email = $1 and id = $2::bigint`, [email, r.id, r.next_due]);
}
// Automatic ones are added when their day comes (checked whenever the app loads), catching up on missed months.
async function postDueRecurring(email) {
  const today = istNow().date;
  const due = await q(`select 1 from mm_recurring where user_email = $1 and auto and next_due <= $2::date limit 1`, [email, today]);
  if (!due.rows.length) return;
  await tx(async (c) => {
    const rs = await c.query(`select ${REC_RAW} from mm_recurring where user_email = $1 and auto and next_due <= $2::date for update`, [email, today]);
    for (const r of rs.rows) for (let i = 0; i < 60 && r.next_due <= today; i++) await postOccurrence(c, email, r);
  });
}
async function recurringStep(sess, body, post) {
  return tx(async (c) => {
    const rs = await c.query(`select ${REC_RAW} from mm_recurring where user_email = $1 and id = $2::bigint for update`, [sess.email, id(body.id)]);
    if (!rs.rows.length) throw new ClientError(404, "Recurring payment not found");
    const r = rs.rows[0];
    // Confirmed early in the same month? Then it was paid today, so date it today.
    const today = istNow().date;
    const date = r.next_due > today && r.next_due.slice(0, 7) === today.slice(0, 7) ? today : r.next_due;
    const row = post ? await postOccurrence(c, sess.email, r, date) : (await advance(c, sess.email, r), null);
    const out = await c.query(`select ${REC_COLS} from mm_recurring where user_email = $1 and id = $2::bigint`, [sess.email, r.id]);
    return { row, recurring: out.rows[0] };
  });
}

// ---------- budgets ----------
async function saveBudget(sess, body) {
  const category = body.category === null || body.category === undefined || body.category === "" ? null : text(body.category, 60);
  const amount = money(body.amount);
  try {
    if (body.id) {
      const u = await q(`update mm_budgets set category = $3, amount = $4 where user_email = $1 and id = $2::bigint returning ${BUD_COLS}`,
        [sess.email, id(body.id), category, amount]);
      if (!u.rows.length) throw new ClientError(404, "Budget not found");
      return u.rows[0];
    }
    const n = await q(`select count(*)::int as n from mm_budgets where user_email = $1`, [sess.email]);
    if (n.rows[0].n >= 60) throw bad("You can have up to 60 budgets");
    const r = await q(`insert into mm_budgets (user_email, category, amount) values ($1, $2, $3)
      on conflict (user_email, (lower(coalesce(category, '')))) do update set amount = excluded.amount, category = excluded.category
      returning ${BUD_COLS}`, [sess.email, category, amount]);
    return r.rows[0];
  } catch (e) {
    if (e && e.code === "23505") throw new ClientError(409, `There's already a budget for ${category || "the month"}.`);
    throw e;
  }
}

// ---------- Google sign-in (OAuth 2.0 authorization code flow with PKCE) ----------
// No Google scripts run in the page, so the strict CSP stays as it is: the browser is sent to Google and back.
function appOrigin(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return (isHttps(req) ? "https://" : "http://") + host;
}
const oauthCookie = (req) => (isHttps(req) ? "__Host-mm_oauth" : "mm_oauth");
const clearOauth = (req) => `${oauthCookie(req)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;
function redirect(res, location, cookies) {
  res.statusCode = 302;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== "Content-Type") res.setHeader(k, v);
  res.setHeader("Location", location);
  if (cookies && cookies.length) res.setHeader("Set-Cookie", cookies);
  res.end();
}
function googleStart(req, res, url) {
  if (!googleOn()) return redirect(res, "/?auth_error=google_off");
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: G_ID, redirect_uri: appOrigin(req) + "/auth/google/callback", response_type: "code",
    scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  });
  // SameSite=Lax so the cookie comes back on the top-level redirect from Google.
  const cookie = `${oauthCookie(req)}=${state}.${verifier}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${isHttps(req) ? "; Secure" : ""}`;
  return redirect(res, "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString(), [cookie]);
}
async function googleCallback(req, res, url) {
  const [state, verifier] = (readCookie(req, oauthCookie(req)) || "").split(".");
  const fail = (code) => redirect(res, "/?auth_error=" + code, [clearOauth(req)]);
  try {
    if (!googleOn()) return fail("google_off");
    if (url.searchParams.get("error")) return fail("google_cancelled");
    const code = url.searchParams.get("code"), gotState = url.searchParams.get("state");
    if (!state || !verifier || !code || !gotState || code.length > 2048 || !safeEqual(state, gotState)) return fail("google_expired");
    await rateLimit("auth:" + clientIp(req), AUTH_LIMIT, AUTH_WINDOW_MIN);
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: G_ID, client_secret: G_SECRET, redirect_uri: appOrigin(req) + "/auth/google/callback",
        grant_type: "authorization_code", code_verifier: verifier }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || typeof tok.id_token !== "string") return fail("google_failed");
    // The ID token came straight from Google's token endpoint over TLS, so (per OpenID Connect Core 3.1.3.7)
    // its claims can be trusted without checking the signature. The claims themselves are still checked.
    const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1] || "", "base64url").toString("utf8"));
    if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss) || claims.aud !== G_ID
      || !(Number(claims.exp) * 1000 > Date.now()) || claims.email_verified !== true || typeof claims.email !== "string") return fail("google_failed");
    const email = emailOf(claims.email);
    const gname = text(typeof claims.name === "string" ? claims.name : null, 60);
    const s = await tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(727275)");
      const ex = await c.query("select email from mm_users where email = $1 for update", [email]);
      if (ex.rows.length) {
        await c.query("update mm_users set name = coalesce(name, $2) where email = $1", [email, gname]);
      } else {
        // Anyone with a verified Google account can sign up, unless ALLOWED_EMAILS limits it.
        // Every query is scoped to the signed-in user, so users never see each other's data.
        if (ALLOWED.length && !ALLOWED.includes(email)) throw new ClientError(403, "not_allowed");
        // pass_hash is a legacy column from password sign-in; Google accounts don't use it.
        await c.query("insert into mm_users (email, pass_hash, name) values ($1, 'GOOGLE', $2)", [email, gname]);
      }
      return createSession(c, req, email);
    });
    return redirect(res, "/", [s.cookie, clearOauth(req)]);
  } catch (e) {
    if (e instanceof ClientError) return fail(e.status === 429 ? "rate" : e.status === 403 ? e.message : "google_failed");
    console.error("google sign-in error", e && e.code ? e.code : "", e && e.message ? e.message : e);
    return fail("google_failed");
  }
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
    let op = req.method === "POST" ? body.op : url.searchParams.get("op");
    if (req.method === "GET" && url.pathname === "/auth/google") op = "google";
    if (req.method === "GET" && url.pathname === "/auth/google/callback") op = "google_cb";
    if (typeof op !== "string" || op.length > 40) throw bad("Unknown operation");

    if (op === "config" && req.method === "GET") return send(res, 200, { db: !!DB_URL, google: googleOn() });
    if (op === "google" && req.method === "GET") return googleStart(req, res, url);
    if (!DB_URL) return send(res, 503, { error: "Database not connected. Add Neon Postgres to the Vercel project and redeploy." });
    await ensureSchema();
    housekeeping();
    if (op === "google_cb" && req.method === "GET") return await googleCallback(req, res, url);


    const sess = await getSession(req);
    if (op === "session" && req.method === "GET") {
      return send(res, 200, sess ? { authenticated: true, email: sess.email, name: sess.name, csrf: sess.csrf } : { authenticated: false });
    }
    if (!sess) return send(res, 401, { error: "Please sign in." });
    if (req.method === "POST" && !safeEqual(req.headers["x-csrf-token"] || "", sess.csrf)) {
      return send(res, 403, { error: "Security check failed. Reload the page and try again." });
    }

    if (req.method === "GET" && op === "all") {
      await postDueRecurring(sess.email);
      const [acc, txs, rec, bud] = await Promise.all([
        q(`select ${ACC_COLS} from mm_accounts where user_email = $1 order by kind, slot`, [sess.email]),
        q(`select ${TXN_COLS} from mm_expenses where user_email = $1 order by created_at, id`, [sess.email]),
        q(`select ${REC_COLS} from mm_recurring where user_email = $1 order by day, id`, [sess.email]),
        q(`select ${BUD_COLS} from mm_budgets where user_email = $1 order by category nulls first, id`, [sess.email]),
      ]);
      return send(res, 200, { accounts: acc.rows, transactions: txs.rows, recurring: rec.rows, budgets: bud.rows, today: istNow().date });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

    switch (op) {
      case "logout":
        await q("delete from mm_sessions where token_hash = $1", [sess.tokenHash]);
        return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
      case "saveProfile": {
        const name = nameOf(body.name);
        await q("update mm_users set name = $2 where email = $1", [sess.email, name]);
        return send(res, 200, { name });
      }
      case "saveAccounts": return send(res, 200, { accounts: await saveAccounts(sess, body) });
      case "addTxn": return send(res, 200, await addTxn(sess, body));
      case "updateTxn": return send(res, 200, { row: await updateTxn(sess, body) });
      case "deleteTxn":
        await q(`delete from mm_expenses where id = $1::bigint and user_email = $2`, [id(body.id), sess.email]);
        return send(res, 200, { ok: true });
      case "saveRecurring": return send(res, 200, { recurring: await saveRecurring(sess, body) });
      case "deleteRecurring":
        await q(`delete from mm_recurring where id = $1::bigint and user_email = $2`, [id(body.id), sess.email]);
        return send(res, 200, { ok: true });
      case "postRecurring": return send(res, 200, await recurringStep(sess, body, true));
      case "skipRecurring": return send(res, 200, await recurringStep(sess, body, false));
      case "saveBudget": return send(res, 200, { budget: await saveBudget(sess, body) });
      case "deleteBudget":
        await q(`delete from mm_budgets where id = $1::bigint and user_email = $2`, [id(body.id), sess.email]);
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
