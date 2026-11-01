// Money Manager API (Vercel Node.js function).
// Environment variables:
//   DATABASE_URL (or POSTGRES_URL) - set automatically when you add Neon Postgres in Vercel
//   ALLOWED_EMAILS (optional)      - comma-separated emails allowed to create an account.
//                                    If not set, only the first account can be created.
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");
const scrypt = promisify(crypto.scrypt);

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const ALLOWED = (process.env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const COOKIE = "mm_session";
const SESSION_DAYS = 30;
const MAX_FAILS = 10, LOCK_MINUTES = 15;
const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPES = ["Need", "Want", "Investment"];

let pool = null;
let ready = null;
let secret = null;

// Neon's URL says sslmode=require; the pg driver already treats that as verify-full (full certificate check)
// and prints a warning about it. Asking for verify-full explicitly keeps the same security without the warning.
function connectionString() {
  try {
    const u = new URL(DB_URL);
    if (["prefer", "require", "verify-ca"].includes(u.searchParams.get("sslmode"))) u.searchParams.set("sslmode", "verify-full");
    return u.toString();
  } catch { return DB_URL; }
}
function db() {
  if (!pool) pool = new Pool({ connectionString: connectionString(), max: 3, idleTimeoutMillis: 10000 });
  return pool;
}

async function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const c = await db().connect();
      try {
        await c.query("begin");
        await c.query("select pg_advisory_xact_lock(727274)");
        await c.query(`create table if not exists mm_meta (key text primary key, value text not null)`);
        await c.query(`create table if not exists mm_users (
          email text primary key,
          pass_hash text not null,
          failed_logins int not null default 0,
          locked_until timestamptz,
          created_at timestamptz not null default now())`);
        await c.query(`create table if not exists mm_expenses (
          id bigserial primary key,
          user_email text not null,
          month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
          expense_date date,
          name text,
          amount numeric(12,2) not null check (amount >= 0),
          category text,
          type text check (type in ('Need','Want','Investment')),
          created_at timestamptz not null default now())`);
        await c.query(`create index if not exists mm_expenses_user_month on mm_expenses (user_email, month)`);
        await c.query(`create table if not exists mm_salaries (
          user_email text not null,
          month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
          amount numeric(12,2) not null default 0 check (amount >= 0),
          primary key (user_email, month))`);
        await c.query(`insert into mm_meta (key, value) values ('session_secret', $1) on conflict (key) do nothing`,
          [crypto.randomBytes(32).toString("hex")]);
        const r = await c.query(`select value from mm_meta where key = 'session_secret'`);
        await c.query("commit");
        secret = Buffer.from(r.rows[0].value, "hex");
      } catch (e) {
        await c.query("rollback").catch(() => {});
        ready = null;
        throw e;
      } finally {
        c.release();
      }
    })();
  }
  return ready;
}

// ---------- helpers ----------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const ch of req) { size += ch.length; if (size > 100000) throw new Error("Body too large"); chunks.push(ch); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}
function cookieHeader(req, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}

// ---------- passwords ----------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

// ---------- sessions ----------
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac("sha256", secret).update(body).digest());
  return body + "." + mac;
}
async function sessionEmail(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok || !tok.includes(".")) return null;
  const [body, mac] = tok.split(".");
  const want = crypto.createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac || "", "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p || typeof p.e !== "string" || !(p.x > Date.now())) return null;
  const u = await db().query("select 1 from mm_users where email = $1", [p.e]);   // deleted account -> signed out
  return u.rows.length ? p.e : null;
}
function startSession(req, res, email) {
  const tok = sign({ e: email, x: Date.now() + SESSION_DAYS * 864e5 });
  return send(res, 200, { email }, { "Set-Cookie": cookieHeader(req, tok, SESSION_DAYS * 86400) });
}

// ---------- validation ----------
function readCreds(body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error("Invalid email address");
  if (password.length < 8 || password.length > 200) throw new Error("Invalid password: use 8 to 200 characters");
  return { email, password };
}
function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}
function cleanRow(row) {
  if (!row || typeof row !== "object") throw new Error("Missing entry");
  const month = String(row.month || "");
  if (!MONTH_RE.test(month)) throw new Error("Invalid month");
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount >= 1e10) throw new Error("Invalid amount");
  let date = row.expense_date || null;
  if (date !== null) {
    date = String(date);
    if (!DATE_RE.test(date) || date.slice(0, 7) !== month || isNaN(Date.parse(date))) throw new Error("Date must be within the month");
  }
  const type = row.type || null;
  if (type !== null && !TYPES.includes(type)) throw new Error("Invalid type");
  return { month, date, name: cleanText(row.name, 200), amount: Math.round(amount * 100) / 100, category: cleanText(row.category, 100), type };
}
const EXP_COLS = `id::text as id, month, to_char(expense_date, 'YYYY-MM-DD') as expense_date, name,
                  amount::float8 as amount, category, type, created_at`;

// ---------- account operations ----------
async function signup(req, res, body) {
  const { email, password } = readCreds(body);
  const hash = await hashPassword(password);
  const c = await db().connect();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(727275)");   // one sign-up at a time
    if (ALLOWED.length) {
      if (!ALLOWED.includes(email)) { await c.query("rollback"); return send(res, 403, { error: "This email is not allowed to create an account." }); }
    } else {
      const n = await c.query("select count(*)::int as n from mm_users");
      if (n.rows[0].n > 0) { await c.query("rollback"); return send(res, 403, { error: "Sign-ups are closed. An account already exists for this app." }); }
    }
    const ins = await c.query("insert into mm_users (email, pass_hash) values ($1, $2) on conflict (email) do nothing returning email", [email, hash]);
    await c.query("commit");
    if (!ins.rows.length) return send(res, 409, { error: "An account with this email already exists. Please sign in." });
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return startSession(req, res, email);
}
async function login(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const u = await db().query("select pass_hash, failed_logins, locked_until > now() as locked from mm_users where email = $1", [email]);
  const user = u.rows[0];
  if (user && user.locked) return send(res, 429, { error: `Too many attempts. Try again in ${LOCK_MINUTES} minutes.` });
  const ok = await checkPassword(password.slice(0, 200), user ? user.pass_hash : DUMMY_HASH);
  if (!user || !ok) {
    if (user) {
      // count failures; an expired lock starts a fresh count
      await db().query(`update mm_users u set failed_logins = f.n,
          locked_until = case when f.n >= $2::int then now() + make_interval(mins => $3::int) else null end
        from (select email, case when locked_until is not null and locked_until <= now() then 1 else failed_logins + 1 end as n
              from mm_users where email = $1) f
        where u.email = f.email`, [email, MAX_FAILS, LOCK_MINUTES]);
    }
    await sleep(300);
    return send(res, 401, { error: "Incorrect email or password." });
  }
  await db().query("update mm_users set failed_logins = 0, locked_until = null where email = $1", [email]);
  return startSession(req, res, email);
}

// ---------- handler ----------
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && !String(req.headers["content-type"] || "").startsWith("application/json")) {
      return send(res, 415, { error: "JSON required" });
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    const op = req.method === "POST" ? body.op : url.searchParams.get("op");

    if (op === "config") return send(res, 200, { db: !!DB_URL });
    if (!DB_URL) return send(res, 500, { error: "Database not connected. Add Neon Postgres to the Vercel project." });
    await ensureSchema();

    if (op === "signup" && req.method === "POST") return await signup(req, res, body);
    if (op === "login" && req.method === "POST") return await login(req, res, body);
    if (op === "logout") return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });

    const email = await sessionEmail(req);
    if (op === "session") return send(res, 200, { authenticated: !!email, email });
    if (!email) return send(res, 401, { error: "Please sign in." });
    const q = (text, params) => db().query(text, params);

    if (op === "all" && req.method === "GET") {
      const ex = await q(`select ${EXP_COLS} from mm_expenses where user_email = $1 order by created_at, id`, [email]);
      const sal = await q(`select month, amount::float8 as amount from mm_salaries where user_email = $1 order by month`, [email]);
      return send(res, 200, { expenses: ex.rows, salaries: sal.rows });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

    if (op === "addExpense") {
      const r = cleanRow(body.row);
      const out = await q(`insert into mm_expenses (user_email, month, expense_date, name, amount, category, type)
                           values ($1,$2,$3,$4,$5,$6,$7) returning ${EXP_COLS}`,
                         [email, r.month, r.date, r.name, r.amount, r.category, r.type]);
      return send(res, 200, { row: out.rows[0] });
    }
    if ((op === "updateExpense" || op === "deleteExpense") && !/^[0-9]{1,18}$/.test(String(body.id))) {
      return send(res, 400, { error: "Invalid id" });
    }
    if (op === "updateExpense") {
      const r = cleanRow(body.row);
      const out = await q(`update mm_expenses set month=$3, expense_date=$4, name=$5, amount=$6, category=$7, type=$8
                           where id = $2::bigint and user_email = $1 returning ${EXP_COLS}`,
                         [email, String(body.id), r.month, r.date, r.name, r.amount, r.category, r.type]);
      if (!out.rows.length) return send(res, 404, { error: "Entry not found" });
      return send(res, 200, { row: out.rows[0] });
    }
    if (op === "deleteExpense") {
      await q(`delete from mm_expenses where id = $2::bigint and user_email = $1`, [email, String(body.id)]);
      return send(res, 200, { ok: true });
    }
    if (op === "setSalary") {
      const month = String(body.month || ""), amount = Number(body.amount);
      if (!MONTH_RE.test(month)) return send(res, 400, { error: "Invalid month" });
      if (!Number.isFinite(amount) || amount < 0 || amount >= 1e10) return send(res, 400, { error: "Invalid salary" });
      await q(`insert into mm_salaries (user_email, month, amount) values ($1,$2,$3)
               on conflict (user_email, month) do update set amount = excluded.amount`,
             [email, month, Math.round(amount * 100) / 100]);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: "Unknown operation" });
  } catch (e) {
    const msg = String(e && e.message || e);
    const clientErr = /^(Invalid|Missing|Date must|Body too large)/.test(msg) || e instanceof SyntaxError;
    if (!clientErr) console.error(e);
    return send(res, clientErr ? 400 : 500, { error: clientErr ? msg : "Server error. Check the Vercel function logs." });
  }
};