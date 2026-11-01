"use strict";
// Shared helpers for the app.
// Security notes: no eval/inline handlers (strict CSP), all user text is escaped before it is placed in HTML,
// the CSRF token lives only in memory, nothing sensitive is stored in localStorage.
const MM = (() => {
  const $ = (id) => document.getElementById(id);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const inr0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const fmt = (n) => { n = round2(n); return (n < 0 ? "-₹" : "₹") + inr.format(Math.abs(n)); };
  const fmt0 = (n) => { n = Math.round(Number(n) || 0); return (n < 0 ? "-₹" : "₹") + inr0.format(Math.abs(n)); };
  const num0 = (n) => inr0.format(Math.round(Number(n) || 0));
  const num2 = (n) => inr.format(round2(n));
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]);
  const pad = (n) => String(n).padStart(2, "0");
  const monthLabel = (m) => MON[+m.slice(5, 7) - 1] + " " + m.slice(0, 4);
  const monthLong = (m) => MONTH_FULL[+m.slice(5, 7) - 1] + " " + m.slice(0, 4);
  const thisMonth = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1); };
  const todayISO = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  const shiftMonth = (m, k) => { const d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1); return d.getFullYear() + "-" + pad(d.getMonth() + 1); };
  const lastDay = (m) => new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
  const fmtDate = (d) => (d ? `${d.slice(8, 10)}-${MON[+d.slice(5, 7) - 1]}-${d.slice(0, 4)}` : "");
  const shortDate = (d) => (d ? `${d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}` : "");
  const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
  const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;

  let csrf = "";
  let onUnauthorized = null;
  async function api(op, body) {
    const post = body !== undefined;
    let r;
    try {
      r = await fetch(post ? "/api/data" : "/api/data?op=" + encodeURIComponent(op), post
        ? { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ ...body, op }) }
        : { credentials: "same-origin", headers: { Accept: "application/json" } });
    } catch { throw new Error("Network error. Check your connection."); }
    let data = {};
    try { data = await r.json(); } catch { /* non-JSON */ }
    if (r.status === 401 && onUnauthorized) { onUnauthorized(); throw new Error("Please sign in."); }
    if (!r.ok) throw new Error(data.error || "Request failed (" + r.status + ")");
    return data;
  }

  const KIND_ICON = { bank: "i-bank", card: "i-card", cash: "i-cash" };

  // Errors passed back in the URL after Google sign-in.
  const AUTH_ERRORS = {
    google_off: "Google sign-in isn't set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel, then redeploy.",
    google_cancelled: "Google sign-in was cancelled.",
    google_expired: "Google sign-in was interrupted or took too long. Please try again.",
    google_failed: "Couldn't sign in with Google. Please try again.",
    rate: "Too many attempts from this network. Please wait a few minutes and try again.",
    not_allowed: "This Google account's email isn't allowed to use this app.",
  };
  function takeAuthError() {
    const u = new URL(location.href), code = u.searchParams.get("auth_error");
    if (!code) return "";
    u.searchParams.delete("auth_error");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    return AUTH_ERRORS[code] || AUTH_ERRORS.google_failed;
  }

  function toast(msg) {
    const t = $("toast"); if (!t) return;
    $("toastMsg").textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1800);
  }

  return {
    $, MON, esc, fmt, fmt0, num0, num2, round2, pad, monthLabel, monthLong, thisMonth, todayISO, shiftMonth, lastDay, fmtDate, shortDate,
    MONEY_RE, icon, api, toast, takeAuthError, AUTH_ERRORS, KIND_ICON,
    setCsrf(t) { csrf = t || ""; },
    setUnauthorizedHandler(fn) { onUnauthorized = fn; },
  };
})();
