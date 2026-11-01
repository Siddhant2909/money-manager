// Money Manager API (Vercel Node.js function).
// Environment variables:
//   DATABASE_URL (or POSTGRES_URL)  - set automatically when you add Neon Postgres in Vercel
//   GOOGLE_CLIENT_ID                - OAuth client ID from Google Cloud (Web application)
//   ALLOWED_EMAILS                  - comma-separated Google emails allowed to sign in
const crypto = require("crypto");
const { Pool } = require("pg");

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const ALLOWED = (process.env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const COOKIE = "mm_session";
const SESSION_DAYS = 30;
const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TYPES = ["Need", "Want", "Investment"];

let pool = null;
let ready = null;          // schema + secret promise
let secret = null;
let certs = { keys: null, until: 0 };

function db() {
  if (!pool) pool = new Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: 10000 });
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

// ---------- sessions ----------
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac("sha256", secret).update(body).digest());
  return body + "." + mac;
}
function sessionEmail(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok || !tok.includes(".")) return null;
  const [body, mac] = tok.split(".");
  const want = crypto.createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac || "", "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p || typeof p.e !== "string" || !(p.x > Date.now())) return null;
  if (!ALLOWED.includes(p.e)) return null;      // removed from the allow-list -> signed out
  return p.e;
}

// ---------- Google ID token verification ----------
async function googleKeys() {
  if (certs.keys && Date.now() < certs.until) return certs.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("Could not fetch Google certificates");
  const j = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  certs = { keys: j.keys || [], until: Date.now() + Math.min(m ? +m[1] : 3600, 21600) * 1000 };
  return certs.keys;
}
async function verifyGoogleToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "RS256") throw new Error("Unexpected algorithm");
  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) { certs.until = 0; jwk = (await googleKeys()).find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("Unknown signing key");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("Bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("Bad issuer");
  if (claims.aud !== CLIENT_ID) throw new Error("Token is for a different app");
  if (!(claims.exp > now - 60)) throw new Error("Token expired");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("Email not verified");
  return String(claims.email || "").toLowerCase();
}

// ---------- validation ----------
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

// ---------- handler ----------
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && !String(req.headers["content-type"] || "").startsWith("application/json")) {
      return send(res, 415, { error: "JSON required" });
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    const op = req.method === "POST" ? body.op : url.searchParams.get("op");

    if (op === "config") {
      return send(res, 200, { googleClientId: CLIENT_ID || null, db: !!DB_URL, allowList: ALLOWED.length > 0 });
    }
    if (!DB_URL) return send(res, 500, { error: "Database not connected. Add Neon Postgres to the Vercel project." });
    if (!CLIENT_ID || !ALLOWED.length) return send(res, 500, { error: "Set GOOGLE_CLIENT_ID and ALLOWED_EMAILS in Vercel." });
    await ensureSchema();

    if (op === "login" && req.method === "POST") {
      let email;
      try { email = await verifyGoogleToken(body.credential); }
      catch (e) { return send(res, 401, { error: "Google sign-in failed: " + e.message }); }
      if (!ALLOWED.includes(email)) return send(res, 403, { error: `${email} is not allowed to use this app.` });
      const tok = sign({ e: email, x: Date.now() + SESSION_DAYS * 864e5 });
      return send(res, 200, { email }, { "Set-Cookie": cookieHeader(req, tok, SESSION_DAYS * 86400) });
    }
    if (op === "logout") {
      return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
    }

    const email = sessionEmail(req);
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
    if ((op === "updateExpense" || op === "deleteExpense") && !/^[0-9]{1,18}$/.test(String(body.id))) return send(res, 400, { error: "Invalid id" });
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
    const clientErr = /Invalid|Missing|Date must|Body too large|JSON/.test(msg) || e instanceof SyntaxError;
    if (!clientErr) console.error(e);
    return send(res, clientErr ? 400 : 500, { error: clientErr ? msg : "Server error. Check the Vercel function logs." });
  }
};
