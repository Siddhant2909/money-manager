"use strict";
// Shared helpers for the sign-in, registration and app pages.
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
    if (r.status === 401 && op !== "login" && onUnauthorized) { onUnauthorized(); throw new Error("Please sign in."); }
    if (!r.ok) throw new Error(data.error || "Request failed (" + r.status + ")");
    return data;
  }

  function passwordProblem(pw, email) {
    if (pw.length < 10 || pw.length > 128) return "Password must be 10 to 128 characters.";
    const local = String(email || "").split("@")[0].toLowerCase();
    if (local.length >= 4 && pw.toLowerCase().includes(local)) return "Password must not contain your email name.";
    return null;
  }

  // ----- accounts form (first-time setup) -----
  // Bank account 1 and cash are always shown; the optional ones open with an "Add" button to keep the form short.
  const SLOTS = [
    { kind: "bank", slot: 1, title: "Bank account", required: true, ph: "e.g. HDFC Savings" },
    { kind: "bank", slot: 2, title: "Second bank account", ph: "e.g. SBI Salary" },
    { kind: "card", slot: 1, title: "Credit card", ph: "e.g. ICICI Amazon Pay" },
    { kind: "card", slot: 2, title: "Second credit card", ph: "e.g. HDFC Millennia" },
    { kind: "cash", slot: 1, title: "Cash in hand" },
  ];
  const KIND_ICON = { bank: "i-bank", card: "i-card", cash: "i-cash" };
  function accountsForm(container, existing) {
    const find = (k, s) => (existing || []).find((a) => a.kind === k && Number(a.slot) === s);
    let html = "";
    for (const s of SLOTS) {
      const a = find(s.kind, s.slot), p = `acc-${s.kind}${s.slot}`;
      const v = (x) => (x === null || x === undefined ? "" : esc(String(x)));
      const collapsed = !s.required && s.kind !== "cash" && !a;
      html += `<div class="acc-set${collapsed ? " closed" : ""}" id="${p}">
        <button type="button" class="acc-add" data-open="${p}">${icon("i-plus")}<span>Add ${esc(s.title.toLowerCase())}</span></button>
        <div class="acc-body"><div class="acc-head"><span class="r-ic">${icon(KIND_ICON[s.kind])}</span><span class="acc-title">${esc(s.title)}</span>
          ${collapsed ? `<button type="button" class="iconbtn plain sm" data-close="${p}" aria-label="Remove">${icon("i-x")}</button>` : ""}</div><div class="form">`;
      if (s.kind !== "cash") html += `<div class="full"><label for="${p}-name">Name</label><input id="${p}-name" maxlength="60" autocomplete="off" placeholder="${esc(s.ph)}" value="${v(a && a.name)}"></div>`;
      if (s.kind === "bank") html += `<div class="full"><label for="${p}-bal">Current balance (₹)</label><input id="${p}-bal" inputmode="decimal" placeholder="0.00" value="${v(a && a.opening_balance)}"></div>`;
      if (s.kind === "card") html += `<div><label for="${p}-limit">Credit limit (₹)</label><input id="${p}-limit" inputmode="decimal" placeholder="e.g. 100000" value="${v(a && a.credit_limit)}"></div>
        <div><label for="${p}-bal">Amount due now (₹)</label><input id="${p}-bal" inputmode="decimal" placeholder="0.00" value="${v(a && a.opening_balance)}"></div>`;
      if (s.kind === "cash") html += `<div class="full"><label for="${p}-bal">Amount (₹)</label><input id="${p}-bal" inputmode="decimal" placeholder="0.00" value="${v(a && a.opening_balance)}"></div>`;
      html += `</div></div></div>`;
    }
    container.innerHTML = html;
    container.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.open) { $(b.dataset.open).classList.remove("closed"); const f = $(b.dataset.open).querySelector("input"); if (f) f.focus(); }
      if (b.dataset.close) { const box = $(b.dataset.close); box.classList.add("closed"); box.querySelectorAll("input").forEach((i) => { i.value = ""; }); }
    };
    return {
      read() {
        const out = [];
        for (const s of SLOTS) {
          const p = `acc-${s.kind}${s.slot}`;
          if ($(p).classList.contains("closed")) continue;
          const name = s.kind === "cash" ? "Cash" : $(p + "-name").value.trim();
          if (!name) { if (s.required) return { error: `${s.title}: enter a name.` }; continue; }
          if (name.length > 60) return { error: `${s.title}: name is too long.` };
          const bal = ($(p + "-bal").value.trim() || "0").replace(/,/g, "");
          if (!MONEY_RE.test(bal)) return { error: `${s.title}: enter a valid amount (no minus sign, up to 2 decimals).` };
          const acc = { kind: s.kind, slot: s.slot, name, opening_balance: bal };
          if (s.kind === "card") {
            const lim = $(p + "-limit").value.trim().replace(/,/g, "");
            if (!MONEY_RE.test(lim) || Number(lim) <= 0) return { error: `${s.title}: enter the credit limit.` };
            acc.credit_limit = lim;
          }
          out.push(acc);
        }
        return { accounts: out };
      },
    };
  }

  // Errors passed back in the URL after Google sign-in.
  const AUTH_ERRORS = {
    google_off: "Google sign-in isn't set up for this app yet.",
    google_cancelled: "Google sign-in was cancelled.",
    google_expired: "Google sign-in was interrupted or took too long. Please try again.",
    google_failed: "Couldn't sign in with Google. Please try again.",
    rate: "Too many attempts from this network. Please wait a few minutes and try again.",
    not_allowed: "This Google account's email isn't allowed to use this app.",
    closed: "There's no account for this Google email, and registration is closed.",
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
    MONEY_RE, icon, api, passwordProblem, accountsForm, toast, takeAuthError, KIND_ICON,
    setCsrf(t) { csrf = t || ""; },
    setUnauthorizedHandler(fn) { onUnauthorized = fn; },
  };
})();
