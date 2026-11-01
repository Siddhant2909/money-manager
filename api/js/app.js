"use strict";
(() => {
  const { $, esc, fmt, fmt0, num0, num2, round2, pad, monthLabel, monthLong, thisMonth, todayISO, shiftMonth, lastDay, fmtDate, shortDate, MONEY_RE, icon, api, toast } = MM;
  const PALETTE = ["#5b8def", "#3fb27f", "#d9a441", "#e07a5f", "#9b7bea", "#4fb3bf", "#e6739f", "#a3b84c", "#7d8ca3", "#c98b4f",
                   "#6aa6f8", "#58c79a", "#e8c062", "#f09a83", "#b39cf0", "#7cc9d2", "#f19cbd", "#bfd06e"];
  const KIND_LABEL = { bank: "Bank", card: "Card", cash: "Cash" };
  const state = { email: null, accounts: [], txns: [], month: thisMonth(), editing: null, editingRow: null, tab: "dashboard", charts: {} };

  // ---------- views ----------
  const VIEWS = ["setupView", "tab-dashboard", "tab-monthly", "tab-investment", "settingsView"];
  function showPage(id) { $("loginView").classList.toggle("hidden", id !== "login"); $("appView").classList.toggle("hidden", id !== "app"); }
  function showView(id) { for (const v of VIEWS) $(v).classList.toggle("hidden", v !== id); $("loader").classList.add("hidden"); }

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

  // ---------- charts ----------
  const centerText = {
    id: "centerText",
    afterDraw(chart, _a, o) {
      if (!o || !o.text) return;
      const { ctx, chartArea: a } = chart, x = (a.left + a.right) / 2, y = (a.top + a.bottom) / 2;
      ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#9aa3b2"; ctx.font = "500 11px system-ui, sans-serif"; ctx.fillText(o.sub, x, y - 12);
      ctx.fillStyle = o.neg ? "#ef6461" : "#e6e9ef"; ctx.font = "700 17px system-ui, sans-serif"; ctx.fillText(o.text, x, y + 8);
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
    const colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);
    state.charts[key] = new Chart(canvas, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#161a20", borderWidth: 2 }] },
      options: {
        maintainAspectRatio: false, cutout: "70%", animation: { duration: 300 },
        plugins: {
          legend: { display: false }, centerText: center,
          tooltip: { backgroundColor: "#1c2129", borderColor: "#353c48", borderWidth: 1, padding: 10,
            callbacks: { label: (c) => ` ${fmt(c.raw)} (${((c.raw / total) * 100).toFixed(1)}%)` } },
        },
      },
      plugins: [centerText],
    });
    return { colors, total };
  }
  // Legend rows: colours are applied through the DOM (no inline style attributes, so the strict CSP holds).
  function legend(el, labels, values, colors, total, opts = {}) {
    let html = "";
    labels.forEach((l, i) => {
      if (!(values[i] > 0) && !opts.keepZero) return;
      html += `<div class="lg"><span class="dot" data-i="${i}"></span><span class="name">${esc(l)}</span>
        <span class="pct">${total ? Math.round((values[i] / total) * 100) : 0}%</span><span class="val">${num0(opts.raw ? opts.raw[i] : values[i])}</span></div>`;
    });
    if (opts.totalRow) html += `<div class="lg total"><span></span><span class="name">Total</span><span class="pct"></span><span class="val" id="${esc(opts.totalId || "")}">${num0(total)}</span></div>`;
    el.innerHTML = html;
    el.querySelectorAll(".dot").forEach((d) => { d.style.backgroundColor = colors[+d.dataset.i] || "#8b95a5"; });
  }
  const kpi = (cls, label, value, sub, negative) =>
    `<div class="kpi ${cls}"><div class="k-label">${esc(label)}</div><div class="k-val${negative ? " neg" : ""}">${esc(value)}</div><div class="k-sub">${esc(sub)}</div></div>`;

  // ---------- dashboard ----------
  function accountCard(acc) {
    const s = accountStats(acc, null);
    if (acc.kind === "card") {
      const avail = round2(acc.credit_limit - s.closing), pct = acc.credit_limit ? Math.min(100, (s.closing / acc.credit_limit) * 100) : 0;
      return `<div class="acc"><div class="a-top"><span class="a-name">${esc(acc.name)}</span><span class="a-kind">Card</span></div>
        <div class="a-val${s.closing > 0 ? " neg" : ""}">${fmt(s.closing)}</div><div class="a-sub">due · ${fmt0(avail)} of ${fmt0(acc.credit_limit)} available</div>
        <div class="bar"><span data-w="${Math.max(0, pct).toFixed(1)}"${s.closing > acc.credit_limit ? ' class="over"' : ""}></span></div></div>`;
    }
    return `<div class="acc"><div class="a-top"><span class="a-name">${esc(acc.name)}</span><span class="a-kind">${KIND_LABEL[acc.kind]}</span></div>
      <div class="a-val${s.closing < 0 ? " neg" : ""}">${fmt(s.closing)}</div><div class="a-sub">balance</div></div>`;
  }
  function applyBars(root) { root.querySelectorAll(".bar > span").forEach((b) => { b.style.width = b.dataset.w + "%"; }); }
  function renderDashboard() {
    const months = monthsWithData(), tot = monthTotals(null);
    $("dashKpis").innerHTML = kpi("income", "Total income", fmt0(tot.income), months.length ? `${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}` : "No entries yet")
      + kpi("expense", "Total expenditure", fmt0(tot.exp), "Excludes investments")
      + kpi("savings", "Total savings", fmt0(tot.sav), "Income − Expenditure", tot.sav < 0)
      + kpi("invest", "Total investment", fmt0(tot.inv), "Entries marked Investment");
    const accs = sortedAccounts();
    $("dashAccounts").innerHTML = accs.map(accountCard).join("") || `<div class="empty">No accounts</div>`;
    applyBars($("dashAccounts"));
    const liquid = accs.filter((a) => a.kind !== "card").reduce((s, a) => s + accountStats(a, null).closing, 0);
    $("dashLiquid").textContent = fmt(liquid); $("dashLiquid").classList.toggle("neg", liquid < 0);

    let html = `<thead><tr><th>Month</th><th class="num">Income</th><th class="num"><span class="full-l">Expenditure</span><span class="short-l">Expense</span></th><th class="num">Savings</th><th class="num"><span class="full-l">Investment</span><span class="short-l">Invest.</span></th></tr></thead><tbody>`;
    const rows = months.map((m) => ({ m, ...monthTotals(m) }));
    for (const r of rows) html += `<tr><td>${monthLabel(r.m)}</td><td class="num">${num0(r.income)}</td><td class="num">${num0(r.exp)}</td><td class="num${r.sav < 0 ? " neg" : ""}">${num0(r.sav)}</td><td class="num">${num0(r.inv)}</td></tr>`;
    html += rows.length ? `<tr class="total"><td>Total</td><td class="num">${num0(tot.income)}</td><td class="num">${num0(tot.exp)}</td><td class="num${tot.sav < 0 ? " neg" : ""}">${num0(tot.sav)}</td><td class="num">${num0(tot.inv)}</td></tr>`
      : `<tr><td colspan="5" class="empty">No entries yet. Add income and expenses in the Monthly tab.</td></tr>`;
    $("dashTable").innerHTML = html + "</tbody>";

    const labels = months.map(monthLabel);
    let c = donut("exp", "chExp", labels, rows.map((r) => r.exp), { text: fmt0(tot.exp), sub: "TOTAL" });
    legend($("lgExp"), labels, rows.map((r) => r.exp), c.colors, c.total);
    const sav = rows.map((r) => Math.max(0, r.sav));
    c = donut("sav", "chSav", labels, sav, { text: fmt0(tot.sav), sub: "TOTAL", neg: tot.sav < 0 });
    legend($("lgSav"), labels, sav, c.colors, c.total, { keepZero: true, raw: rows.map((r) => r.sav) });
    const cats = new Map();
    for (const t of state.txns) {
      if (t.kind !== "expense" || t.type === "Investment") continue;
      const k = catKey(t.category) || "\u0000";
      if (!cats.has(k)) cats.set(k, { name: catKey(t.category) ? t.category.trim() : "Uncategorised", amt: 0 });
      cats.get(k).amt += t.amount;
    }
    const list = [...cats.values()].filter((x) => x.amt > 0).sort((a, b) => b.amt - a.amt);
    c = donut("cat", "chCat", list.map((x) => x.name), list.map((x) => x.amt), { text: fmt0(tot.exp), sub: "SPENT" });
    legend($("lgCat"), list.map((x) => x.name), list.map((x) => x.amt), c.colors, c.total, { totalRow: list.length > 0, totalId: "catTotal" });
  }

  // ---------- monthly ----------
  function setMonth(m) {
    state.month = m; $("month").value = m;
    $("monthLbl").textContent = monthLabel(m); $("monthTitle").textContent = monthLong(m);
    $("fDate").min = m + "-01"; $("fDate").max = m + "-" + pad(lastDay(m));
    cancelEdit();
    renderMonthly();
  }
  const defaultDate = () => (todayISO().slice(0, 7) === state.month ? todayISO() : state.month + "-01");
  function accountOptions(filter, selected, allowUnlinked) {
    let html = allowUnlinked ? `<option value="">Not linked (entry from before accounts)</option>` : `<option value="" disabled${selected ? "" : " selected"}>Choose…</option>`;
    for (const a of sortedAccounts().filter(filter)) {
      html += `<option value="${esc(a.id)}"${a.id === selected ? " selected" : ""}>${esc(a.name)} (${KIND_LABEL[a.kind]})</option>`;
    }
    return html;
  }
  function refreshFormFields() {
    const kind = $("fKind").value, editRow = state.editingRow;
    const unlinked = !!(editRow && !editRow.account_id && editRow.kind !== "transfer");
    $("wrapCat").classList.toggle("hidden", kind === "transfer");
    $("wrapType").classList.toggle("hidden", kind !== "expense");
    $("wrapAcc").classList.toggle("hidden", kind === "transfer");
    $("wrapFrom").classList.toggle("hidden", kind !== "transfer");
    $("wrapTo").classList.toggle("hidden", kind !== "transfer");
    $("lblAcc").textContent = kind === "income" ? "Received in" : "Payment mode";
    const isInvest = kind === "expense" && $("fType").value === "Investment";
    $("lblCat").textContent = kind === "income" ? "Source" : isInvest ? "Invested in" : "Category";
    $("fCat").placeholder = kind === "income" ? "e.g. Salary" : isInvest ? "e.g. Mutual fund, Gold, PPF" : "Type new or pick a previous one";
    $("lblName").textContent = kind === "transfer" ? "Description (optional)" : "Description";
    $("fName").placeholder = kind === "transfer" ? "e.g. Credit card bill, ATM withdrawal" : kind === "income" ? "e.g. November salary" : "e.g. Grocery shopping";
    const curAcc = $("fAcc").value || (editRow ? editRow.account_id : "");
    $("fAcc").innerHTML = accountOptions(() => true, curAcc, unlinked);
    if (unlinked && !curAcc) $("fAcc").value = "";
    const from = $("fFrom").value || (editRow && editRow.kind === "transfer" ? editRow.account_id : "");
    $("fFrom").innerHTML = accountOptions((a) => a.kind !== "card", from, false);
    const to = $("fTo").value || (editRow && editRow.kind === "transfer" ? editRow.to_account_id : "");
    $("fTo").innerHTML = accountOptions((a) => a.id !== $("fFrom").value, to === $("fFrom").value ? "" : to, false);
    // category suggestions depend on the entry type
    const pool = state.txns.filter((t) => kind === "income" ? t.kind === "income" : t.kind === "expense" && (isInvest ? t.type === "Investment" : t.type !== "Investment"));
    const sugg = distinct(pool.map((t) => t.category).concat(kind === "income" ? ["Salary"] : []));
    $("catList").innerHTML = sugg.map((c) => `<option value="${esc(c)}">`).join("");
  }
  function renderMonthly() {
    const m = state.month, t = monthTotals(m);
    $("monthKpis").innerHTML = kpi("income", "Income", fmt(t.income), "Salary and other income")
      + kpi("expense", "Expenditure", fmt(t.exp), "Excludes investments")
      + kpi("savings", "Savings", fmt(t.sav), "Income − Expenditure", t.sav < 0)
      + kpi("invest", "Investment", fmt(t.inv), "Entries marked Investment");

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

    refreshFormFields();

    const rows = state.txns.filter((x) => x.month === m).map((x, i) => ({ ...x, sl: i + 1 }));
    const keep = (sel, opts) => { const cur = $(sel).value; $(sel).innerHTML = opts; if ([...$(sel).options].some((o) => o.value === cur)) $(sel).value = cur; };
    keep("filCat", `<option value="">All</option>` + distinct(rows.map((r) => r.category)).map((c) => `<option value="${esc(catKey(c))}">${esc(c)}</option>`).join("") + `<option value="__blank">(none)</option>`);
    keep("filAcc", `<option value="">All</option>` + sortedAccounts().map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("") + `<option value="__none">Not linked</option>`);
    const fk = $("filKind").value, fc = $("filCat").value, ft = $("filType").value, fa = $("filAcc").value;
    const shown = rows.filter((r) => (!fk || r.kind === fk)
      && (!fc || (fc === "__blank" ? !catKey(r.category) : catKey(r.category) === fc))
      && (!ft || (ft === "__blank" ? !r.type : r.type === ft))
      && (!fa || (fa === "__none" ? !r.account_id : r.account_id === fa || r.to_account_id === fa)));
    $("entryCount").textContent = rows.length ? (shown.length === rows.length ? `${rows.length} entr${rows.length === 1 ? "y" : "ies"}` : `${shown.length} of ${rows.length}`) : "";

    let html = `<div class="erow head"><div>SL</div><div>Date</div><div>Description</div><div>Category</div><div>Type</div><div>Account</div><div class="ta-r">Amount (₹)</div><div></div></div>`;
    if (!shown.length) html += `<div class="empty">${rows.length ? "No entries match the filters." : "No entries for " + esc(monthLong(m)) + " yet."}</div>`;
    for (const r of shown) {
      const badges = `<span class="badges"><span class="badge ${r.kind}">${r.kind === "income" ? "Income" : r.kind === "expense" ? "Expense" : "Transfer"}</span>${r.type ? `<span class="badge ${esc(r.type)}">${esc(r.type)}</span>` : ""}${!r.account_id && r.kind !== "transfer" ? '<span class="badge unlinked">Not linked</span>' : ""}</span>`;
      const accTxt = r.kind === "transfer" ? `${esc(accName(r.account_id))} → ${esc(accName(r.to_account_id))}` : esc(r.account_id ? accName(r.account_id) : "—");
      const sign = r.kind === "income" ? "+" : r.kind === "expense" ? "−" : "";
      const cls = r.kind === "income" ? "pos" : r.kind === "expense" ? (r.type === "Investment" ? "inv" : "neg") : "";
      const name = r.name || (r.kind === "transfer" ? "Transfer" : "");
      const meta = [shortDate(r.expense_date), esc(r.category || ""), r.kind === "transfer" ? accTxt : r.account_id ? esc(accName(r.account_id)) : ""].filter(Boolean).join(" · ");
      html += `<div class="erow">
        <div class="c-sl"><span class="sl">${r.sl}</span></div>
        <div class="c-date">${fmtDate(r.expense_date)}</div>
        <div class="c-name">${esc(name) || '<span class="muted">—</span>'}</div>
        <div class="c-cat">${esc(r.category || "")}</div>
        <div class="c-type">${badges}</div>
        <div class="c-acc">${accTxt}</div>
        <div class="c-amt ${cls}">${sign}${num2(r.amount)}</div>
        <div class="c-meta">${meta ? `<span>${meta}</span>` : ""}${badges}</div>
        <div class="c-act"><button type="button" class="iconbtn sm" data-edit="${esc(r.id)}" aria-label="Edit entry">${icon("i-edit")}</button><button type="button" class="iconbtn sm danger" data-del="${esc(r.id)}" aria-label="Delete entry">${icon("i-trash")}</button></div>
      </div>`;
    }
    if (shown.length && (fk || fc || ft || fa)) {
      const sum = shown.reduce((s, r) => s + (r.kind === "income" ? r.amount : r.kind === "expense" ? -r.amount : 0), 0);
      html += `<div class="erow total"><div class="c-sl"></div><div class="c-name">Filtered net (income − expenses)</div><div class="c-amt${sum < 0 ? " neg" : " pos"}" id="filteredTotal">${num2(sum)}</div></div>`;
    }
    $("expList").innerHTML = html;
  }
  function readForm() {
    const kind = $("fKind").value;
    const amt = $("fAmt").value.trim().replace(/,/g, "");
    if (!MONEY_RE.test(amt) || Number(amt) <= 0) return { error: "Enter an amount greater than zero (up to 2 decimals)." };
    const d = $("fDate").value;
    if (d && d.slice(0, 7) !== state.month) return { error: "Date must be in " + monthLabel(state.month) + "." };
    const row = { kind, month: state.month, expense_date: d || null, amount: amt, name: $("fName").value.trim() || null };
    if (kind === "transfer") {
      row.account_id = $("fFrom").value; row.to_account_id = $("fTo").value;
      if (!row.account_id || !row.to_account_id) return { error: "Choose both accounts for the transfer." };
      if (row.account_id === row.to_account_id) return { error: "Choose two different accounts." };
    } else {
      row.category = $("fCat").value.trim() || null;
      row.account_id = $("fAcc").value || null;
      if (kind === "expense") row.type = $("fType").value || null;
      const unlinkedOk = state.editingRow && !state.editingRow.account_id;
      if (!row.account_id && !unlinkedOk) return { error: kind === "income" ? "Choose the account the money went into." : "Choose a payment mode." };
    }
    return { row };
  }
  function clearForm() {
    $("fName").value = ""; $("fAmt").value = ""; $("fCat").value = ""; $("fType").value = "";
    $("fDate").value = defaultDate(); $("fErr").textContent = "";
    $("fAcc").value = ""; $("fFrom").value = ""; $("fTo").value = "";
  }
  function cancelEdit() {
    state.editing = null; state.editingRow = null;
    $("formTitle").textContent = "Add entry"; $("fSave").querySelector("span").textContent = "Add entry";
    $("fCancel").classList.add("hidden"); $("fKind").disabled = false;
    clearForm(); refreshFormFields();
  }
  async function saveEntry() {
    $("fErr").textContent = "";
    const { row, error } = readForm();
    if (error) { $("fErr").textContent = error; return; }
    $("fSave").disabled = true;
    try {
      if (state.editing) {
        const { row: saved } = await api("updateTxn", { id: state.editing, row });
        state.txns = state.txns.map((x) => (x.id === saved.id ? saved : x));
        cancelEdit(); toast("Entry updated");
      } else {
        const { row: saved } = await api("addTxn", { row });
        state.txns.push(saved);
        const keepKind = $("fKind").value, keepAcc = $("fAcc").value;
        clearForm(); $("fKind").value = keepKind; refreshFormFields(); $("fAcc").value = keepAcc;
        toast("Entry added"); $("fAmt").focus();
      }
      renderMonthly();
    } catch (e) { $("fErr").textContent = "Could not save: " + e.message; }
    finally { $("fSave").disabled = false; }
  }
  function startEdit(id) {
    const r = state.txns.find((x) => x.id === id); if (!r) return;
    state.editing = id; state.editingRow = r;
    $("fKind").value = r.kind;
    $("fAcc").innerHTML = ""; $("fFrom").innerHTML = ""; $("fTo").innerHTML = "";
    $("fType").value = r.type || "";
    refreshFormFields();
    $("fDate").value = r.expense_date || ""; $("fName").value = r.name || ""; $("fAmt").value = String(r.amount);
    $("fCat").value = r.category || "";
    if (r.kind === "transfer") { $("fFrom").value = r.account_id; refreshFormFields(); $("fTo").value = r.to_account_id; }
    else $("fAcc").value = r.account_id || "";
    $("formTitle").textContent = "Edit entry"; $("fSave").querySelector("span").textContent = "Update";
    $("fCancel").classList.remove("hidden"); $("fErr").textContent = "";
    $("formTitle").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function deleteEntry(id) {
    const r = state.txns.find((x) => x.id === id); if (!r) return;
    if (!confirm(`Delete "${r.name || r.kind}" (${fmt(r.amount)})?`)) return;
    try { await api("deleteTxn", { id }); }
    catch (e) { $("appErr").textContent = "Could not delete: " + e.message; return; }
    state.txns = state.txns.filter((x) => x.id !== id);
    if (state.editing === id) cancelEdit();
    renderMonthly(); toast("Entry deleted");
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
    $("invKpis").innerHTML = kpi("invest", "Total invested", fmt0(total), "All months")
      + kpi("invest", "This month", fmt0(thisM), monthLabel(thisMonth()))
      + kpi("savings", "Places", String(list.length), list.length === 1 ? "1 place" : `${list.length} places`)
      + kpi("savings", "Largest", list.length ? list[0].name : "—", list.length ? fmt0(list[0].amt) : "No investments yet");
    const c = donut("inv", "chInv", list.map((p) => p.name), list.map((p) => p.amt), { text: fmt0(total), sub: "INVESTED" });
    let html = `<thead><tr><th></th><th>Place</th><th class="num hide-sm">Entries</th><th class="num">Total (₹)</th><th class="num">Share</th><th class="hide-sm">Last</th></tr></thead><tbody>`;
    list.forEach((p, i) => {
      html += `<tr><td><span class="lg"><span class="dot" data-i="${i}"></span></span></td><td>${esc(p.name)}</td><td class="num hide-sm">${p.n}</td><td class="num">${num2(p.amt)}</td><td class="num">${total ? Math.round((p.amt / total) * 100) : 0}%</td><td class="hide-sm">${fmtDate(p.last)}</td></tr>`;
    });
    html += list.length ? `<tr class="total"><td></td><td>Total</td><td class="num hide-sm">${inv.length}</td><td class="num">${num2(total)}</td><td class="num">100%</td><td class="hide-sm"></td></tr>`
      : `<tr><td colspan="6" class="empty">No investments yet. In the Monthly tab, add an expense and set Need/Want/Investment to Investment.</td></tr>`;
    $("invPlaces").innerHTML = html + "</tbody>";
    $("invPlaces").querySelectorAll(".dot").forEach((d) => { d.style.backgroundColor = c.colors[+d.dataset.i] || "#8b95a5"; });

    const cur = $("filPlace").value;
    $("filPlace").innerHTML = `<option value="">All places</option>` + list.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join("");
    if ([...$("filPlace").options].some((o) => o.value === cur)) $("filPlace").value = cur;
    const fp = $("filPlace").value;
    const rows = inv.filter((t) => !fp || (catKey(t.category) || "\u0000") === fp)
      .sort((a, b) => (b.expense_date || b.month).localeCompare(a.expense_date || a.month) || b.created_at.localeCompare(a.created_at));
    let ih = `<thead><tr><th>Date</th><th>Place</th><th class="hide-sm">Description</th><th class="hide-sm">Paid from</th><th class="num">Amount (₹)</th></tr></thead><tbody>`;
    for (const t of rows) ih += `<tr><td>${t.expense_date ? fmtDate(t.expense_date) : monthLabel(t.month)}</td><td>${esc(t.category || "Unspecified")}</td><td class="hide-sm">${esc(t.name || "")}</td><td class="hide-sm">${esc(t.account_id ? accName(t.account_id) : "—")}</td><td class="num">${num2(t.amount)}</td></tr>`;
    if (!rows.length) ih += `<tr><td colspan="5" class="empty">No investment entries.</td></tr>`;
    $("invTable").innerHTML = ih + "</tbody>";
  }

  // ---------- settings ----------
  let settingsForm = null, setupForm = null;
  function openSettings() {
    settingsForm = MM.accountsForm($("settingsForm"), state.accounts, "edit");
    $("settingsErr").textContent = ""; $("pwErr").textContent = ""; $("pwUser").value = state.email || "";
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
  async function enterApp(email) {
    state.email = email; $("who").textContent = email || "";
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
    setTab("dashboard");
  }
  async function saveSetup() {
    const { accounts, error } = setupForm.read();
    if (error) { $("setupErr").textContent = error; return; }
    $("setupSave").disabled = true; $("setupErr").textContent = "";
    try { const r = await api("saveAccounts", { accounts }); state.accounts = r.accounts; setMonth(state.month); setTab("dashboard"); }
    catch (e) { $("setupErr").textContent = e.message; }
    finally { $("setupSave").disabled = false; }
  }
  function signedOut(msg) {
    MM.setCsrf(""); state.email = null; state.accounts = []; state.txns = [];
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
      enterApp(r.email);
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
    $("pwForm").addEventListener("submit", changePassword);
    $("setupSave").addEventListener("click", saveSetup);
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
    $("monthBtn").addEventListener("click", () => { const i = $("month"); try { i.showPicker(); } catch { i.focus(); } });
    $("month").addEventListener("change", () => { if ($("month").value) setMonth($("month").value); });
    $("prevM").addEventListener("click", () => setMonth(shiftMonth(state.month, -1)));
    $("nextM").addEventListener("click", () => setMonth(shiftMonth(state.month, 1)));
    $("fKind").addEventListener("change", () => { $("fAcc").value = ""; refreshFormFields(); });
    $("fType").addEventListener("change", refreshFormFields);
    $("fFrom").addEventListener("change", refreshFormFields);
    $("fSave").addEventListener("click", saveEntry);
    $("fCancel").addEventListener("click", cancelEdit);
    ["fName", "fAmt", "fCat"].forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") saveEntry(); }));
    ["filKind", "filCat", "filType", "filAcc"].forEach((id) => $(id).addEventListener("change", renderMonthly));
    $("filPlace").addEventListener("change", renderInvestment);
    $("expList").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.edit) startEdit(b.dataset.edit);
      if (b.dataset.del) deleteEntry(b.dataset.del);
    });
  }

  async function start() {
    if (typeof Chart !== "undefined") { Chart.defaults.color = "#9aa3b2"; Chart.defaults.font.family = "system-ui, sans-serif"; }
    wire();
    try {
      const cfg = await api("config");
      if (!cfg.db) { showPage("login"); $("authErr").textContent = "Setup is not finished: connect Neon Postgres to the Vercel project, then redeploy."; return; }
      const s = await api("session");
      if (s.authenticated) { MM.setCsrf(s.csrf); enterApp(s.email); } else signedOut();
    } catch (e) { showPage("login"); $("authErr").textContent = "Could not reach the server: " + e.message; }
  }
  start();
})();
