"use strict";
(() => {
  const { $, esc, fmt, fmt0, num0, num2, round2, pad, monthLabel, monthLong, thisMonth, todayISO, shiftMonth, lastDay, fmtDate, MON, MONEY_RE, icon, api, toast } = MM;
  const KIND_LABEL = { bank: "Bank", card: "Card", cash: "Cash" };
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const state = { email: null, name: null, accounts: [], txns: [], month: thisMonth(), editing: null, editingRow: null, kind: "expense",
    filKind: "", tab: "monthly", charts: {} };

  // ---------- theme ----------
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const palette = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => css("--c" + i));

  // ---------- views ----------
  const VIEWS = ["setupView", "tab-dashboard", "tab-monthly", "tab-investment", "settingsView"];
  function showPage(id) { $("loginView").classList.toggle("hidden", id !== "login"); $("appView").classList.toggle("hidden", id !== "app"); }
  function showView(id) { for (const v of VIEWS) $(v).classList.toggle("hidden", v !== id); $("loader").classList.add("hidden"); }

  // ---------- user ----------
  const displayName = () => state.name || (state.email ? state.email.split("@")[0] : "");
  const firstName = () => displayName().split(" ")[0];
  function renderUser() {
    const n = displayName();
    $("who").textContent = n;
    $("avatar").textContent = n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  }

  // ---------- accounts & balances ----------
  const accById = (id) => state.accounts.find((a) => a.id === id);
  const accName = (id) => (id ? (accById(id) ? accById(id).name : "Unknown account") : "Not linked");
  const sortedAccounts = () => [...state.accounts].sort((a, b) => ["bank", "card", "cash"].indexOf(a.kind) - ["bank", "card", "cash"].indexOf(b.kind) || a.slot - b.slot);
  // For bank/cash: in = money received, out = money spent. For cards: in = amount spent on the card, out = amount paid off.
  function effect(acc, t) {
    const a = Number(t.amount);
    if (t.kind === "transfer") {
      if (t.account_id === acc.id) return { out: a };
      if (t.to_account_id === acc.id) return acc.kind === "card" ? { out: a } : { in: a };
      return null;
    }
    if (t.account_id !== acc.id) return null;
    if (acc.kind === "card") return t.kind === "expense" ? { in: a } : { out: a };
    return t.kind === "income" ? { in: a } : { out: a };
  }
  function accountStats(acc, month) {
    let before = 0, inn = 0, out = 0;
    for (const t of state.txns) {
      const e = effect(acc, t); if (!e) continue;
      const i = e.in || 0, o = e.out || 0;
      if (month && t.month < month) before += i - o;
      else if (!month || t.month === month) { inn += i; out += o; }
    }
    const opening = round2(acc.opening_balance + before);
    return { opening, inn: round2(inn), out: round2(out), closing: round2(opening + inn - out) };
  }

  // ---------- totals ----------
  const isInv = (t) => t.kind === "expense" && t.type === "Investment";
  function monthTotals(m) {
    let income = 0, exp = 0, inv = 0;
    for (const t of state.txns) {
      if (m && t.month !== m) continue;
      if (t.kind === "income") income += t.amount;
      else if (t.kind === "expense") { if (t.type === "Investment") inv += t.amount; else exp += t.amount; }
    }
    return { income: round2(income), exp: round2(exp), inv: round2(inv), sav: round2(income - exp) };
  }
  const monthsWithData = () => [...new Set(state.txns.map((t) => t.month))].sort();
  const catKey = (c) => (c || "").trim().toLowerCase();
  function distinct(list) {
    const seen = new Map();
    for (const c of list) { const k = catKey(c); if (k && !seen.has(k)) seen.set(k, c.trim()); }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }
  const stat = (label, value, sub, cls = "") =>
    `<div class="stat"><div class="s-label">${esc(label)}</div><div class="s-val ${cls}">${esc(value)}</div>${sub ? `<div class="s-sub">${esc(sub)}</div>` : ""}</div>`;

  // ---------- charts ----------
  const centerText = {
    id: "centerText",
    afterDraw(chart, _a, o) {
      if (!o || !o.text) return;
      const { ctx, chartArea: a } = chart, x = (a.left + a.right) / 2, y = (a.top + a.bottom) / 2;
      ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = css("--muted"); ctx.font = "500 11px " + css("--font"); ctx.fillText(o.sub, x, y - 12);
      ctx.fillStyle = o.neg ? css("--red") : css("--text"); ctx.font = "650 17px " + css("--font"); ctx.fillText(o.text, x, y + 8);
      ctx.restore();
    },
  };
  function donut(key, canvasId, labels, values, center) {
    if (state.charts[key]) { state.charts[key].destroy(); state.charts[key] = null; }
    const canvas = $(canvasId), box = canvas.parentElement;
    const old = box.querySelector(".empty"); if (old) old.remove();
    const total = values.reduce((a, b) => a + b, 0);
    if (!(total > 0) || typeof Chart === "undefined") {
      canvas.classList.add("hidden");
      const d = document.createElement("div"); d.className = "empty"; d.textContent = "No data yet"; box.appendChild(d);
      return { colors: [], total: 0 };
    }
    canvas.classList.remove("hidden");
    const pal = palette(), colors = labels.map((_, i) => pal[i % pal.length]);
    state.charts[key] = new Chart(canvas, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: css("--surface"), borderWidth: 2 }] },
      options: {
        maintainAspectRatio: false, cutout: "74%", animation: { duration: 300 },
        plugins: {
          legend: { display: false }, centerText: center,
          tooltip: { backgroundColor: css("--text"), titleColor: css("--surface"), bodyColor: css("--surface"), padding: 10, cornerRadius: 8, displayColors: false,
            callbacks: { label: (c) => ` ${fmt(c.raw)} (${((c.raw / total) * 100).toFixed(1)}%)` } },
        },
      },
      plugins: [centerText],
    });
    return { colors, total };
  }
  // Legend rows: colours are applied through the DOM (no inline style attributes, so the strict CSP holds).
  function legend(el, labels, values, colors, total) {
    let html = "";
    labels.forEach((l, i) => {
      if (!(values[i] > 0)) return;
      html += `<div class="lg"><span class="dot" data-i="${i}"></span><span class="name">${esc(l)}</span>
        <span class="pct">${total ? Math.round((values[i] / total) * 100) : 0}%</span><span class="val">${num0(values[i])}</span></div>`;
    });
    el.innerHTML = html;
    el.querySelectorAll(".dot").forEach((d) => { d.style.backgroundColor = colors[+d.dataset.i] || css("--faint"); });
  }

  // ---------- overview ----------
  function accountCard(acc) {
    const s = accountStats(acc, null);
    if (acc.kind === "card") {
      const avail = round2(acc.credit_limit - s.closing), pct = acc.credit_limit ? Math.min(100, (s.closing / acc.credit_limit) * 100) : 0;
      return `<div class="acc"><div class="a-top"><span class="a-name">${esc(acc.name)}</span><span class="a-kind">Card</span></div>
        <div class="a-val">${fmt(s.closing)}</div><div class="a-sub">due · ${fmt0(avail)} of ${fmt0(acc.credit_limit)} available</div>
        <div class="bar"><span data-w="${Math.max(0, pct).toFixed(1)}"${s.closing > acc.credit_limit ? ' class="over"' : ""}></span></div></div>`;
    }
    return `<div class="acc"><div class="a-top"><span class="a-name">${esc(acc.name)}</span><span class="a-kind">${KIND_LABEL[acc.kind]}</span></div>
      <div class="a-val${s.closing < 0 ? " neg" : ""}">${fmt(s.closing)}</div><div class="a-sub">balance</div></div>`;
  }
  function applyBars(root) { root.querySelectorAll(".bar > span").forEach((b) => { b.style.width = b.dataset.w + "%"; }); }
  function renderDashboard() {
    const months = monthsWithData(), tot = monthTotals(null);
    $("dashKpis").innerHTML = stat("Income", fmt0(tot.income), months.length ? `${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}` : "No entries yet")
      + stat("Spent", fmt0(tot.exp), "Excludes investments")
      + stat("Saved", fmt0(tot.sav), "Income − spent", tot.sav < 0 ? "neg" : "pos")
      + stat("Invested", fmt0(tot.inv), "Marked Investment");
    const accs = sortedAccounts();
    $("dashAccounts").innerHTML = accs.map(accountCard).join("") || `<div class="empty">No accounts</div>`;
    applyBars($("dashAccounts"));
    const liquid = accs.filter((a) => a.kind !== "card").reduce((s, a) => s + accountStats(a, null).closing, 0);
    $("dashLiquid").textContent = fmt(liquid); $("dashLiquid").classList.toggle("neg", liquid < 0);

    let html = `<thead><tr><th>Month</th><th class="num">Income</th><th class="num">Spent</th><th class="num">Saved</th><th class="num">Invested</th></tr></thead><tbody>`;
    const rows = months.map((m) => ({ m, ...monthTotals(m) }));
    for (const r of [...rows].reverse()) html += `<tr><td>${monthLabel(r.m)}</td><td class="num">${num0(r.income)}</td><td class="num">${num0(r.exp)}</td><td class="num${r.sav < 0 ? " neg" : ""}">${num0(r.sav)}</td><td class="num">${num0(r.inv)}</td></tr>`;
    html += rows.length ? `<tr class="total"><td>Total</td><td class="num">${num0(tot.income)}</td><td class="num">${num0(tot.exp)}</td><td class="num${tot.sav < 0 ? " neg" : ""}">${num0(tot.sav)}</td><td class="num">${num0(tot.inv)}</td></tr>`
      : `<tr><td colspan="5" class="empty">No entries yet.</td></tr>`;
    $("dashTable").innerHTML = html + "</tbody>";

    const labels = months.map(monthLabel);
    let c = donut("exp", "chExp", labels, rows.map((r) => r.exp), { text: fmt0(tot.exp), sub: "TOTAL" });
    legend($("lgExp"), labels, rows.map((r) => r.exp), c.colors, c.total);
    const cats = new Map();
    for (const t of state.txns) {
      if (t.kind !== "expense" || t.type === "Investment") continue;
      const k = catKey(t.category) || "\u0000";
      if (!cats.has(k)) cats.set(k, { name: catKey(t.category) ? t.category.trim() : "Uncategorised", amt: 0 });
      cats.get(k).amt += t.amount;
    }
    const list = [...cats.values()].filter((x) => x.amt > 0).sort((a, b) => b.amt - a.amt);
    c = donut("cat", "chCat", list.map((x) => x.name), list.map((x) => x.amt), { text: fmt0(tot.exp), sub: "SPENT" });
    legend($("lgCat"), list.map((x) => x.name), list.map((x) => x.amt), c.colors, c.total);
  }

  // ---------- monthly ----------
  function setMonth(m) {
    state.month = m; $("month").value = m;
    $("monthTitle").textContent = monthLong(m);
    $("fDate").min = m + "-01"; $("fDate").max = m + "-" + pad(lastDay(m));
    renderMonthly();
  }
  function greeting() {
    const h = new Date().getHours();
    return (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + (firstName() ? ", " + firstName() : "");
  }
  function dayLabel(d) {
    if (!d) return "No date";
    if (d === todayISO()) return "Today";
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (d === `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`) return "Yesterday";
    const dt = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    return `${DOW[dt.getDay()]}, ${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
  }
  function renderMonthly() {
    const m = state.month, t = monthTotals(m);
    $("greet").textContent = greeting();
    $("monthKpis").innerHTML = stat("Income", fmt0(t.income), "")
      + stat("Spent", fmt0(t.exp), "")
      + stat("Saved", fmt0(t.sav), "", t.sav < 0 ? "neg" : t.sav > 0 ? "pos" : "")
      + stat("Invested", fmt0(t.inv), "");

    // accounts this month (opening = previous month's closing)
    let at = `<thead><tr><th>Account</th><th class="num">Opening</th><th class="num">In</th><th class="num">Out</th><th class="num">Closing</th></tr></thead><tbody>`;
    let liquid = 0;
    for (const a of sortedAccounts()) {
      const s = accountStats(a, m);
      if (a.kind === "card") {
        at += `<tr><td>${esc(a.name)} <span class="faint">due</span></td><td class="num">${num2(s.opening)}</td><td class="num" title="Spent">${num2(s.inn)}</td><td class="num" title="Paid">${num2(s.out)}</td><td class="num${s.closing > a.credit_limit ? " neg" : ""}">${num2(s.closing)}</td></tr>`;
      } else {
        liquid += s.closing;
        at += `<tr><td>${esc(a.name)}</td><td class="num">${num2(s.opening)}</td><td class="num">${num2(s.inn)}</td><td class="num">${num2(s.out)}</td><td class="num${s.closing < 0 ? " neg" : ""}">${num2(s.closing)}</td></tr>`;
      }
    }
    $("accMonthTable").innerHTML = at + "</tbody>";
    $("monthLiquid").textContent = fmt(liquid); $("monthLiquid").classList.toggle("neg", liquid < 0);
    $("monthLiquidS").textContent = fmt0(liquid) + " in banks + cash";

    renderEntries();
  }
  function renderEntries() {
    const m = state.month;
    const rows = state.txns.filter((x) => x.month === m);
    const fk = state.filKind, q = $("filQ").value.trim().toLowerCase();
    const shown = rows.filter((r) => (!fk || r.kind === fk) && (!q || [r.name, r.category, r.type, accName(r.account_id), r.to_account_id ? accName(r.to_account_id) : ""]
      .some((s) => String(s || "").toLowerCase().includes(q))))
      .sort((a, b) => (b.expense_date || "").localeCompare(a.expense_date || "") || String(b.created_at).localeCompare(String(a.created_at)));

    if (!rows.length) {
      $("expList").innerHTML = `<div class="blank"><div class="blank-t">No entries for ${esc(monthLong(m))}</div>
        <div class="muted">Add your income, expenses and transfers to see where your money goes.</div>
        <button class="btn primary" type="button" data-add="1">${icon("i-plus")}<span>Add your first entry</span></button></div>`;
      return;
    }
    if (!shown.length) { $("expList").innerHTML = `<div class="blank"><div class="muted">No entries match.</div></div>`; return; }

    const groups = [];
    for (const r of shown) {
      const k = r.expense_date || "";
      if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, rows: [] });
      groups[groups.length - 1].rows.push(r);
    }
    let html = "";
    for (const g of groups) {
      const net = g.rows.reduce((s, r) => s + (r.kind === "income" ? r.amount : r.kind === "expense" ? -r.amount : 0), 0);
      html += `<div class="day"><span>${esc(dayLabel(g.k))}</span><span class="day-net">${net === 0 ? "" : (net > 0 ? "+" : "−") + num0(Math.abs(net))}</span></div>`;
      for (const r of g.rows) {
        const name = r.name || (r.kind === "transfer" ? "Transfer" : r.category || (r.kind === "income" ? "Income" : "Expense"));
        const acc = r.kind === "transfer" ? `${accName(r.account_id)} → ${accName(r.to_account_id)}` : r.account_id ? accName(r.account_id) : "";
        const meta = [r.kind !== "transfer" && r.name ? r.category : "", acc].filter(Boolean).map(esc).join(" · ");
        const tags = (r.type ? `<span class="tag ${esc(r.type)}">${esc(r.type)}</span>` : "") + (!r.account_id && r.kind !== "transfer" ? '<span class="tag unlinked">Not linked</span>' : "");
        const sign = r.kind === "income" ? "+" : r.kind === "expense" ? "−" : "";
        const cls = r.kind === "income" ? "pos" : r.kind === "transfer" ? "muted-amt" : isInv(r) ? "inv" : "";
        const ic = r.kind === "income" ? "i-in" : r.kind === "transfer" ? "i-swap" : "i-outa";
        html += `<button type="button" class="entry" data-edit="${esc(r.id)}">
          <span class="e-ic ${r.kind}">${icon(ic)}</span>
          <span class="e-main"><span class="e-name">${esc(name)}</span><span class="e-meta">${meta}${tags}</span></span>
          <span class="e-amt ${cls}">${sign}₹${num2(r.amount)}</span>
        </button>`;
      }
    }
    if (fk || q) {
      const sum = shown.reduce((s, r) => s + (r.kind === "income" ? r.amount : r.kind === "expense" ? -r.amount : 0), 0);
      html += `<div class="list-foot"><span>${shown.length} of ${rows.length} entries</span>${fk === "transfer" ? "" : `<span class="${sum < 0 ? "" : "pos"}" id="filteredTotal">Net ${sum < 0 ? "−" : "+"}₹${num2(Math.abs(sum))}</span>`}</div>`;
    } else {
      html += `<div class="list-foot"><span>${rows.length} entr${rows.length === 1 ? "y" : "ies"}</span></div>`;
    }
    $("expList").innerHTML = html;
  }

  // ---------- entry dialog ----------
  const defaultDate = () => (todayISO().slice(0, 7) === state.month ? todayISO() : state.month + "-01");
  function accountOptions(filter, selected, allowUnlinked) {
    let html = allowUnlinked ? `<option value="">Not linked (entry from before accounts)</option>` : `<option value="" disabled${selected ? "" : " selected"}>Choose…</option>`;
    for (const a of sortedAccounts().filter(filter)) {
      html += `<option value="${esc(a.id)}"${a.id === selected ? " selected" : ""}>${esc(a.name)}</option>`;
    }
    return html;
  }
  function setKind(k) {
    state.kind = k;
    $("fKind").querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.k === k); b.setAttribute("aria-checked", String(b.dataset.k === k)); });
    $("entryDlg").dataset.kind = k;
  }
  function refreshFormFields() {
    const kind = state.kind, editRow = state.editingRow;
    const unlinked = !!(editRow && !editRow.account_id && editRow.kind !== "transfer");
    $("wrapCat").classList.toggle("hidden", kind === "transfer");
    $("wrapType").classList.toggle("hidden", kind !== "expense");
    $("wrapAcc").classList.toggle("hidden", kind === "transfer");
    $("wrapFrom").classList.toggle("hidden", kind !== "transfer");
    $("wrapTo").classList.toggle("hidden", kind !== "transfer");
    $("lblAcc").textContent = kind === "income" ? "Received in" : "Paid from";
    const isInvest = kind === "expense" && $("fType").value === "Investment";
    $("lblCat").textContent = kind === "income" ? "Source" : isInvest ? "Invested in" : "Category";
    $("fCat").placeholder = kind === "income" ? "e.g. Salary" : isInvest ? "e.g. Mutual fund, Gold" : "e.g. Groceries";
    $("lblName").textContent = kind === "transfer" ? "Description (optional)" : "Description";
    $("fName").placeholder = kind === "transfer" ? "e.g. Credit card bill, ATM withdrawal" : kind === "income" ? "e.g. November salary" : "What was it for?";
    const curAcc = $("fAcc").value || (editRow ? editRow.account_id : "");
    $("fAcc").innerHTML = accountOptions(() => true, curAcc, unlinked);
    if (unlinked && !curAcc) $("fAcc").value = "";
    const from = $("fFrom").value || (editRow && editRow.kind === "transfer" ? editRow.account_id : "");
    $("fFrom").innerHTML = accountOptions((a) => a.kind !== "card", from, false);
    const to = $("fTo").value || (editRow && editRow.kind === "transfer" ? editRow.to_account_id : "");
    $("fTo").innerHTML = accountOptions((a) => a.id !== $("fFrom").value, to === $("fFrom").value ? "" : to, false);
    const pool = state.txns.filter((t) => kind === "income" ? t.kind === "income" : t.kind === "expense" && (isInvest ? t.type === "Investment" : t.type !== "Investment"));
    const sugg = distinct(pool.map((t) => t.category).concat(kind === "income" ? ["Salary"] : []));
    $("catList").innerHTML = sugg.map((c) => `<option value="${esc(c)}">`).join("");
  }
  function readForm() {
    const kind = state.kind;
    const amt = $("fAmt").value.trim().replace(/,/g, "");
    if (!MONEY_RE.test(amt) || Number(amt) <= 0) return { error: "Enter an amount greater than zero (up to 2 decimals).", field: "fAmt" };
    const d = $("fDate").value;
    const month = state.editingRow ? state.editingRow.month : state.month;
    if (d && d.slice(0, 7) !== month) return { error: "Date must be in " + monthLabel(month) + ".", field: "fDate" };
    const row = { kind, month, expense_date: d || null, amount: amt, name: $("fName").value.trim() || null };
    if (kind === "transfer") {
      row.account_id = $("fFrom").value; row.to_account_id = $("fTo").value;
      if (!row.account_id || !row.to_account_id) return { error: "Choose both accounts for the transfer." };
      if (row.account_id === row.to_account_id) return { error: "Choose two different accounts." };
    } else {
      row.category = $("fCat").value.trim() || null;
      row.account_id = $("fAcc").value || null;
      if (kind === "expense") row.type = $("fType").value || null;
      const unlinkedOk = state.editingRow && !state.editingRow.account_id;
      if (!row.account_id && !unlinkedOk) return { error: kind === "income" ? "Choose the account the money went into." : "Choose where it was paid from.", field: "fAcc" };
    }
    return { row };
  }
  let lastAcc = "";
  function openEntry(id) {
    const r = id ? state.txns.find((x) => x.id === id) : null;
    if (id && !r) return;
    state.editing = r ? r.id : null; state.editingRow = r;
    $("fErr").textContent = "";
    $("fAcc").innerHTML = ""; $("fFrom").innerHTML = ""; $("fTo").innerHTML = "";
    const m = r ? r.month : state.month;
    $("fDate").min = m + "-01"; $("fDate").max = m + "-" + pad(lastDay(m));
    setKind(r ? r.kind : state.kind || "expense");
    $("fType").value = r ? r.type || "" : "";
    refreshFormFields();
    $("fDate").value = r ? r.expense_date || "" : defaultDate();
    $("fName").value = r ? r.name || "" : "";
    $("fAmt").value = r ? String(r.amount) : "";
    sizeAmount();
    $("fCat").value = r ? r.category || "" : "";
    if (r && r.kind === "transfer") { $("fFrom").value = r.account_id; refreshFormFields(); $("fTo").value = r.to_account_id; }
    else if (r) $("fAcc").value = r.account_id || "";
    else { const def = (lastAcc && accById(lastAcc)) ? lastAcc : (sortedAccounts()[0] || {}).id; if (def && state.kind !== "transfer") $("fAcc").value = def; }
    $("fKind").querySelectorAll("button").forEach((b) => { b.disabled = false; });
    $("formTitle").textContent = r ? "Edit entry" : "New entry";
    $("fSave").querySelector("span").textContent = r ? "Save changes" : "Add entry";
    $("fDelete").classList.toggle("hidden", !r);
    $("entryDlg").showModal();
    if (!r) $("fAmt").focus();
  }
  function sizeAmount() { const i = $("fAmt"); i.style.width = Math.max(1, (i.value || i.placeholder).length) + 0.6 + "ch"; }
  function closeEntry() { $("entryDlg").close(); state.editing = null; state.editingRow = null; }
  async function saveEntry(e) {
    if (e) e.preventDefault();
    $("fErr").textContent = "";
    const { row, error, field } = readForm();
    if (error) { $("fErr").textContent = error; if (field) $(field).focus(); return; }
    $("fSave").disabled = true;
    try {
      if (state.editing) {
        const { row: saved } = await api("updateTxn", { id: state.editing, row });
        state.txns = state.txns.map((x) => (x.id === saved.id ? saved : x));
        toast("Entry updated");
      } else {
        const { row: saved } = await api("addTxn", { row });
        state.txns.push(saved);
        if (row.kind !== "transfer" && row.account_id) lastAcc = row.account_id;
        toast("Entry added");
      }
      closeEntry();
      renderMonthly();
    } catch (ex) { $("fErr").textContent = "Could not save: " + ex.message; }
    finally { $("fSave").disabled = false; }
  }
  async function deleteEntry() {
    const r = state.editingRow; if (!r) return;
    if (!confirm(`Delete "${r.name || r.category || r.kind}" (${fmt(r.amount)})?`)) return;
    $("fDelete").disabled = true;
    try { await api("deleteTxn", { id: r.id }); }
    catch (e) { $("fErr").textContent = "Could not delete: " + e.message; return; }
    finally { $("fDelete").disabled = false; }
    state.txns = state.txns.filter((x) => x.id !== r.id);
    closeEntry(); renderMonthly(); toast("Entry deleted");
  }

  // ---------- investment ----------
  function renderInvestment() {
    const inv = state.txns.filter(isInv);
    const places = new Map();
    for (const t of inv) {
      const k = catKey(t.category) || "\u0000";
      if (!places.has(k)) places.set(k, { key: k, name: catKey(t.category) ? t.category.trim() : "Unspecified", amt: 0, n: 0, last: "" });
      const p = places.get(k); p.amt += t.amount; p.n += 1;
      const d = t.expense_date || t.month + "-01"; if (d > p.last) p.last = d;
    }
    const list = [...places.values()].sort((a, b) => b.amt - a.amt);
    const total = round2(inv.reduce((s, t) => s + t.amount, 0));
    const thisM = round2(inv.filter((t) => t.month === thisMonth()).reduce((s, t) => s + t.amount, 0));
    $("invKpis").innerHTML = stat("Total invested", fmt0(total), "All months")
      + stat("This month", fmt0(thisM), monthLabel(thisMonth()))
      + stat("Places", String(list.length), "")
      + stat("Largest", list.length ? list[0].name : "—", list.length ? fmt0(list[0].amt) : "");
    const c = donut("inv", "chInv", list.map((p) => p.name), list.map((p) => p.amt), { text: fmt0(total), sub: "INVESTED" });
    let html = `<thead><tr><th>Place</th><th class="num hide-sm">Entries</th><th class="num">Total (₹)</th><th class="num">Share</th></tr></thead><tbody>`;
    list.forEach((p, i) => {
      html += `<tr><td><span class="lg-inline"><span class="dot" data-i="${i}"></span>${esc(p.name)}</span></td><td class="num hide-sm">${p.n}</td><td class="num">${num2(p.amt)}</td><td class="num">${total ? Math.round((p.amt / total) * 100) : 0}%</td></tr>`;
    });
    html += list.length ? `<tr class="total"><td>Total</td><td class="num hide-sm">${inv.length}</td><td class="num">${num2(total)}</td><td class="num">100%</td></tr>`
      : `<tr><td colspan="4" class="empty">No investments yet. Add an expense and set Need / Want / Investment to Investment.</td></tr>`;
    $("invPlaces").innerHTML = html + "</tbody>";
    $("invPlaces").querySelectorAll(".dot").forEach((d) => { d.style.backgroundColor = c.colors[+d.dataset.i] || css("--faint"); });

    const cur = $("filPlace").value;
    $("filPlace").innerHTML = `<option value="">All places</option>` + list.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join("");
    if ([...$("filPlace").options].some((o) => o.value === cur)) $("filPlace").value = cur;
    const fp = $("filPlace").value;
    const rows = inv.filter((t) => !fp || (catKey(t.category) || "\u0000") === fp)
      .sort((a, b) => (b.expense_date || b.month).localeCompare(a.expense_date || a.month) || String(b.created_at).localeCompare(String(a.created_at)));
    let ih = `<thead><tr><th>Date</th><th>Place</th><th class="hide-sm">Description</th><th class="hide-sm">Paid from</th><th class="num">Amount (₹)</th></tr></thead><tbody>`;
    for (const t of rows) ih += `<tr><td>${t.expense_date ? fmtDate(t.expense_date) : monthLabel(t.month)}</td><td>${esc(t.category || "Unspecified")}</td><td class="hide-sm">${esc(t.name || "")}</td><td class="hide-sm">${esc(t.account_id ? accName(t.account_id) : "—")}</td><td class="num">${num2(t.amount)}</td></tr>`;
    if (!rows.length) ih += `<tr><td colspan="5" class="empty">No investment entries.</td></tr>`;
    $("invTable").innerHTML = ih + "</tbody>";
  }

  // ---------- settings ----------
  let settingsForm = null, setupForm = null;
  function openSettings() {
    settingsForm = MM.accountsForm($("settingsForm"), state.accounts, "edit");
    $("settingsErr").textContent = ""; $("pwErr").textContent = ""; $("pfErr").textContent = ""; $("pwUser").value = state.email || "";
    $("pfName").value = state.name || ""; $("pfEmail").textContent = "Signed in as " + (state.email || "");
    for (const b of document.querySelectorAll(".tabs button")) b.classList.remove("active");
    showView("settingsView"); window.scrollTo({ top: 0 });
  }
  async function saveSettings() {
    const { accounts, error } = settingsForm.read();
    if (error) { $("settingsErr").textContent = error; return; }
    $("settingsSave").disabled = true; $("settingsErr").textContent = "";
    try {
      const r = await api("saveAccounts", { accounts });
      state.accounts = r.accounts;
      settingsForm = MM.accountsForm($("settingsForm"), state.accounts, "edit");
      toast("Accounts saved");
    } catch (e) { $("settingsErr").textContent = e.message; }
    finally { $("settingsSave").disabled = false; }
  }
  async function saveProfile(e) {
    e.preventDefault();
    const name = $("pfName").value.trim();
    $("pfErr").textContent = "";
    if (!name) { $("pfErr").textContent = "Enter your name."; return; }
    $("pfSave").disabled = true;
    try { const r = await api("saveProfile", { name }); state.name = r.name; renderUser(); toast("Name saved"); }
    catch (ex) { $("pfErr").textContent = ex.message; }
    finally { $("pfSave").disabled = false; }
  }
  async function changePassword(e) {
    e.preventDefault();
    const cur = $("pwCur").value, n1 = $("pwNew").value, n2 = $("pwNew2").value;
    $("pwErr").textContent = "";
    const p = MM.passwordProblem(n1, state.email);
    if (!cur) { $("pwErr").textContent = "Enter your current password."; return; }
    if (p) { $("pwErr").textContent = p; return; }
    if (n1 !== n2) { $("pwErr").textContent = "The new passwords don't match."; return; }
    $("pwSave").disabled = true;
    try { await api("changePassword", { current: cur, next: n1 }); $("pwCur").value = $("pwNew").value = $("pwNew2").value = ""; toast("Password changed"); }
    catch (ex) { $("pwErr").textContent = ex.message; }
    finally { $("pwSave").disabled = false; }
  }

  // ---------- navigation & auth ----------
  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    showView("tab-" + tab);
    window.scrollTo({ top: 0 });
    if (tab === "dashboard") renderDashboard(); else if (tab === "monthly") renderMonthly(); else renderInvestment();
  }
  async function enterApp(email, name) {
    state.email = email; state.name = name || null; renderUser();
    showPage("app"); $("appErr").textContent = "";
    for (const v of VIEWS) $(v).classList.add("hidden");
    $("loader").classList.remove("hidden");
    try {
      const d = await api("all");
      state.accounts = d.accounts; state.txns = d.transactions.map((t) => ({ ...t, amount: Number(t.amount) }));
    } catch (e) { $("loader").classList.add("hidden"); $("appErr").textContent = "Could not load data: " + e.message; return; }
    if (!state.accounts.length) {
      setupForm = MM.accountsForm($("setupForm"), [], "register");
      showView("setupView"); return;
    }
    setMonth(state.month);
    setTab("monthly");
  }
  async function saveSetup() {
    const { accounts, error } = setupForm.read();
    if (error) { $("setupErr").textContent = error; return; }
    $("setupSave").disabled = true; $("setupErr").textContent = "";
    try { const r = await api("saveAccounts", { accounts }); state.accounts = r.accounts; setMonth(state.month); setTab("monthly"); }
    catch (e) { $("setupErr").textContent = e.message; }
    finally { $("setupSave").disabled = false; }
  }
  function signedOut(msg) {
    MM.setCsrf(""); state.email = null; state.name = null; state.accounts = []; state.txns = [];
    if ($("entryDlg").open) $("entryDlg").close();
    for (const k of Object.keys(state.charts)) if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
    showPage("login"); $("authErr").textContent = msg || ""; $("password").value = "";
  }
  async function login(e) {
    e.preventDefault();
    const email = $("email").value.trim(), password = $("password").value;
    $("authErr").textContent = "";
    if (!email || !password) { $("authErr").textContent = "Enter your email and password."; return; }
    $("signIn").disabled = true;
    try {
      const r = await api("login", { email, password });
      MM.setCsrf(r.csrf); $("password").value = "";
      enterApp(r.email, r.name);
    } catch (ex) { $("authErr").textContent = ex.message; }
    finally { $("signIn").disabled = false; }
  }

  function wire() {
    MM.setUnauthorizedHandler(() => signedOut("Your session ended. Please sign in again."));
    $("loginForm").addEventListener("submit", login);
    $("signOut").addEventListener("click", async () => { try { await api("logout", {}); } catch { /* ignore */ } signedOut(); });
    $("settingsBtn").addEventListener("click", openSettings);
    $("settingsBack").addEventListener("click", () => setTab(state.tab));
    $("settingsSave").addEventListener("click", saveSettings);
    $("profileForm").addEventListener("submit", saveProfile);
    $("pwForm").addEventListener("submit", changePassword);
    $("setupSave").addEventListener("click", saveSetup);
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
    $("monthBtn").addEventListener("click", () => { const i = $("month"); try { i.showPicker(); } catch { i.focus(); } });
    $("month").addEventListener("change", () => { if ($("month").value) setMonth($("month").value); });
    $("prevM").addEventListener("click", () => setMonth(shiftMonth(state.month, -1)));
    $("nextM").addEventListener("click", () => setMonth(shiftMonth(state.month, 1)));
    // filters
    $("filKind").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state.filKind = b.dataset.k;
      $("filKind").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderEntries();
    });
    $("filQ").addEventListener("input", renderEntries);
    $("expList").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.edit) openEntry(b.dataset.edit);
      if (b.dataset.add) openEntry(null);
    });
    // entry dialog
    $("addBtn").addEventListener("click", () => openEntry(null));
    $("fKind").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || b.dataset.k === state.kind) return;
      setKind(b.dataset.k); $("fAcc").value = ""; refreshFormFields();
    });
    $("fType").addEventListener("change", refreshFormFields);
    $("fAmt").addEventListener("input", sizeAmount);
    $("fFrom").addEventListener("change", refreshFormFields);
    $("entryForm").addEventListener("submit", saveEntry);
    $("fCancel").addEventListener("click", closeEntry);
    $("fClose").addEventListener("click", closeEntry);
    $("fDelete").addEventListener("click", deleteEntry);
    $("entryDlg").addEventListener("close", () => { state.editing = null; state.editingRow = null; });
    $("entryDlg").addEventListener("click", (e) => { if (e.target === $("entryDlg")) closeEntry(); });  // click on backdrop
    $("filPlace").addEventListener("change", renderInvestment);
    document.addEventListener("keydown", (e) => {
      if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey && state.tab === "monthly" && !$("entryDlg").open
        && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && !$("tab-monthly").classList.contains("hidden")) { e.preventDefault(); openEntry(null); }
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (typeof Chart !== "undefined") Chart.defaults.color = css("--muted");
      if (state.tab === "dashboard" && !$("tab-dashboard").classList.contains("hidden")) renderDashboard();
      if (state.tab === "investment" && !$("tab-investment").classList.contains("hidden")) renderInvestment();
    });
  }

  async function start() {
    if (typeof Chart !== "undefined") { Chart.defaults.color = css("--muted"); Chart.defaults.font.family = css("--font"); }
    wire();
    try {
      const cfg = await api("config");
      if (!cfg.db) { showPage("login"); $("authErr").textContent = "Setup is not finished: connect Neon Postgres to the Vercel project, then redeploy."; return; }
      const s = await api("session");
      if (s.authenticated) { MM.setCsrf(s.csrf); enterApp(s.email, s.name); } else signedOut();
    } catch (e) { showPage("login"); $("authErr").textContent = "Could not reach the server: " + e.message; }
  }
  start();
})();
