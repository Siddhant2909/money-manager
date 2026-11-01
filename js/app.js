"use strict";
(() => {
  const { $, esc, fmt, fmt0, num0, num2, round2, pad, monthLabel, monthLong, thisMonth, todayISO, shiftMonth, lastDay, fmtDate, MON, MONEY_RE, icon, api, toast, KIND_ICON } = MM;
  const KIND_LABEL = { bank: "Bank", card: "Card", cash: "Cash" };
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const state = { email: null, name: null, onboarding: false, accounts: [], txns: [], recurring: [], budgets: [],
    reminder: { time: "21:00" }, today: todayISO(), month: thisMonth(),
    mode: "entry", editing: null, editingRow: null, editingRec: null, kind: "expense", filKind: "", tab: "monthly", charts: {} };

  // ---------- theme ----------
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const palette = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => css("--c" + i));

  // ---------- views ----------
  const VIEWS = ["tab-plan", "tab-dashboard", "tab-monthly", "tab-investment", "settingsView"];
  function showPage(id) { $("loginView").classList.toggle("hidden", id !== "login"); $("appView").classList.toggle("hidden", id !== "app"); }
  function showView(id) { for (const v of VIEWS) $(v).classList.toggle("hidden", v !== id); $("loader").classList.add("hidden"); }

  // ---------- user ----------
  const displayName = () => state.name || (state.email ? state.email.split("@")[0] : "");
  const firstName = () => displayName().split(" ")[0];
  const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  function renderUser() {
    const n = displayName();
    $("who").textContent = n;
    $("avatar").textContent = initials(n);
  }
  // Amount with the paise shown faintly: ₹22,000.00 → ₹22,000<span>.00</span>
  function money(n) {
    const s = num2(n), i = s.lastIndexOf(".");
    return `₹${esc(s.slice(0, i))}<span class="dec">${esc(s.slice(i))}</span>`;
  }
  // Stable colour per category, so the same category always gets the same tint.
  function hue(c) { let h = 0; for (const ch of catKey(c)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 1 + (h % 7); }
  // Round icon: arrows for income / transfers, a coloured initial for everything else.
  function entryIcon(kind, label) {
    if (kind === "income") return `<span class="e-ic income">${icon("i-in")}</span>`;
    if (kind === "transfer") return `<span class="e-ic transfer">${icon("i-swap")}</span>`;
    return `<span class="e-ic h${hue(label)}">${esc((label || "?").trim().charAt(0).toUpperCase())}</span>`;
  }
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const shortD = (d) => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
  function fmtTime(t) { const h = +t.slice(0, 2), m = t.slice(3, 5); return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`; }
  const overallBudget = () => state.budgets.find((b) => b.category === null);
  const catBudgets = () => state.budgets.filter((b) => b.category !== null);
  // Spending (expenses that aren't investments) in a month, by category.
  function spendByCat(m) {
    const out = new Map();
    for (const t of state.txns) {
      if (t.month !== m || t.kind !== "expense" || t.type === "Investment") continue;
      const k = catKey(t.category);
      if (!out.has(k)) out.set(k, { name: k ? t.category.trim() : "Uncategorised", amt: 0 });
      out.get(k).amt += t.amount;
    }
    return out;
  }
  function renderCurrent() {
    if (!$("settingsView").classList.contains("hidden")) return renderSettings();
    if (state.tab === "plan") renderPlan(); else if (state.tab === "dashboard") renderDashboard(); else if (state.tab === "investment") renderInvestment(); else renderMonthly();
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
    const ob = overallBudget();
    if (ob) {
      const pct = Math.round((t.exp / ob.amount) * 100), left = ob.amount - t.exp;
      $("monthKpis").insertAdjacentHTML("beforeend", `<button type="button" class="s-bar link" data-goto="plan"><div class="bar"><span data-w="${Math.min(100, pct)}"${left < 0 ? ' class="over"' : ""}></span></div>
        <span>${left >= 0 ? `${esc(fmt0(t.exp))} of ${esc(fmt0(ob.amount))} budget · ${esc(fmt0(left))} left` : `${esc(fmt0(-left))} over your ${esc(fmt0(ob.amount))} budget`}</span></button>`);
      applyBars($("monthKpis"));
    } else if (t.income > 0) {
      const pct = Math.round((t.exp / t.income) * 100);
      $("monthKpis").insertAdjacentHTML("beforeend", `<div class="s-bar"><div class="bar"><span data-w="${Math.min(100, pct)}"${pct > 100 ? ' class="over"' : ""}></span></div>
        <span>${pct > 100 ? `Spent ${pct}% of income` : `Spent ${pct}% of income · ${esc(fmt0(t.sav))} left`}</span></div>`);
      applyBars($("monthKpis"));
    }

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
    $("monthLiquidS").innerHTML = `${esc(fmt0(liquid))}<span class="hide-sm"> in banks + cash</span>`;

    renderDue();
    renderEntries();
  }
  // Recurring payments due in the month being viewed (only for the current month).
  function renderDue() {
    const m = state.month, end = m + "-" + pad(lastDay(m));
    const items = m === state.today.slice(0, 7) ? state.recurring.filter((r) => r.next_due <= end).sort((a, b) => a.next_due.localeCompare(b.next_due)) : [];
    $("duePanel").classList.toggle("hidden", !items.length);
    if (!items.length) return;
    const manual = items.filter((r) => !r.auto), auto = items.filter((r) => r.auto);
    $("dueCount").textContent = manual.length ? `${manual.length} to confirm` : "";
    // Payments to confirm get a row each; automatic ones are summed up in one line.
    $("dueRows").innerHTML = manual.map((r) => {
      const late = r.next_due < state.today;
      const when = late ? `Overdue · was due ${shortD(r.next_due)}` : r.next_due === state.today ? "Due today" : `Due ${shortD(r.next_due)}`;
      return `<div class="due-row">
        <button type="button" class="due-main" data-rec="${esc(r.id)}">${entryIcon(r.kind, r.category || r.name)}
          <span class="r-main"><span class="r-title">${esc(r.name)}</span><span class="r-sub${late ? " neg" : ""}">${esc(when)} · ${esc(fmt0(r.amount))}</span></span></button>
        <span class="due-acts"><button type="button" class="btn ghost sm" data-skip="${esc(r.id)}">Skip</button><button type="button" class="btn primary sm" data-post="${esc(r.id)}">Add</button></span></div>`;
    }).join("") + (auto.length ? `<div class="due-auto">Adds itself: ${auto.map((r) => `<button type="button" data-rec="${esc(r.id)}">${esc(r.name)} <span>${esc(shortD(r.next_due))}</span></button>`).join(", ")}</div>` : "");
  }
  async function postOrSkip(idv, post) {
    const r = state.recurring.find((x) => x.id === idv); if (!r) return;
    try {
      const res = await api(post ? "postRecurring" : "skipRecurring", { id: idv });
      if (res.row) state.txns.push({ ...res.row, amount: Number(res.row.amount) });
      state.recurring = state.recurring.map((x) => (x.id === idv ? res.recurring : x));
      renderCurrent(); toast(post ? `${r.name} added` : `Skipped ${r.name} for ${monthLabel(r.next_due.slice(0, 7))}`);
    } catch (e) { $("appErr").textContent = "Could not update: " + e.message; }
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
        const letter = (r.category || r.name || "?").trim().charAt(0).toUpperCase();
        const ic = r.kind === "income" ? `<span class="e-ic income">${icon("i-in")}</span>` : r.kind === "transfer" ? `<span class="e-ic transfer">${icon("i-swap")}</span>`
          : `<span class="e-ic h${hue(r.category || r.name)}">${esc(letter)}</span>`;
        html += `<button type="button" class="entry" data-edit="${esc(r.id)}">
          ${ic}
          <span class="e-main"><span class="e-name">${esc(name)}</span><span class="e-meta">${r.recurring_id ? `<span class="rep" title="Recurring">${icon("i-repeat")}</span>` : ""}${meta ? `<span class="m-txt">${meta}</span>` : ""}${tags}</span></span>
          <span class="e-amt ${cls}">${sign}${money(r.amount)}</span>
        </button>`;
      }
    }
    if (fk || q) {
      const sum = shown.reduce((s, r) => s + (r.kind === "income" ? r.amount : r.kind === "expense" ? -r.amount : 0), 0);
      html += `<div class="list-foot"><span>${shown.length} of ${rows.length} entries</span>${fk === "transfer" ? "" : `<span class="${sum < 0 ? "" : "pos"}" id="filteredTotal">Net ${sum < 0 ? "−" : "+"}${money(Math.abs(sum))}</span>`}</div>`;
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
    const rec = state.mode === "recurring";
    if (rec) { $("lblName").textContent = "Name"; $("fName").placeholder = "e.g. Rent, Maid, Netflix"; }
    $("lblDate").textContent = rec ? "Next due on" : "Date";
    $("repeatRow").classList.toggle("hidden", rec || !!state.editing);
    $("autoRow").classList.toggle("hidden", !(rec || $("fRepeat").checked));
    $("fPresets").classList.toggle("hidden", !rec || !!state.editingRec);
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
    const d = $("fDate").value, rec = state.mode === "recurring";
    if (rec && !d) return { error: "Choose the date it's next due.", field: "fDate" };
    const month = rec ? d.slice(0, 7) : state.editingRow ? state.editingRow.month : state.month;
    if (d && d.slice(0, 7) !== month) return { error: "Date must be in " + monthLabel(month) + ".", field: "fDate" };
    const row = { kind, month, expense_date: d || null, amount: amt, name: $("fName").value.trim() || null };
    if (rec) {
      if (!row.name) return { error: "Give it a name, e.g. Rent.", field: "fName" };
      row.next_due = d; row.auto = $("fAuto").checked;
      if (state.editingRec && d === state.editingRec.next_due) row.day = state.editingRec.day;   // keep "31st" when this month is shorter
    }
    if (kind === "transfer") {
      row.account_id = $("fFrom").value; row.to_account_id = $("fTo").value;
      if (!row.account_id || !row.to_account_id) return { error: "Choose both accounts for the transfer." };
      if (row.account_id === row.to_account_id) return { error: "Choose two different accounts." };
    } else {
      row.category = $("fCat").value.trim() || null;
      row.account_id = $("fAcc").value || null;
      if (kind === "expense") row.type = $("fType").value || null;
      const unlinkedOk = !rec && state.editingRow && !state.editingRow.account_id;
      if (!row.account_id && !unlinkedOk) return { error: kind === "income" ? "Choose the account the money went into." : "Choose where it was paid from.", field: "fAcc" };
    }
    return { row };
  }
  let lastAcc = "";
  function openEntry(id) {
    const r = id ? state.txns.find((x) => x.id === id) : null;
    if (id && !r) return;
    state.mode = "entry"; state.editingRec = null;
    $("fRepeat").checked = false; $("fAuto").checked = true;
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
  const PRESETS = {
    rent: { kind: "expense", name: "Rent", category: "Housing", type: "Need" },
    maid: { kind: "expense", name: "Maid", category: "Household help", type: "Need" },
    cook: { kind: "expense", name: "Cook", category: "Household help", type: "Need" },
    sip: { kind: "expense", name: "Mutual fund SIP", category: "Mutual fund", type: "Investment" },
    rd: { kind: "expense", name: "Recurring deposit", category: "Recurring deposit", type: "Investment" },
    sub: { kind: "expense", name: "Subscription", category: "Subscriptions", type: "Want" },
    emi: { kind: "expense", name: "Loan EMI", category: "EMI", type: "Need" },
    salary: { kind: "income", name: "Salary", category: "Salary" },
  };
  // The entry form doubles as the recurring-payment form.
  function openRecurring(idv) {
    const r = idv ? state.recurring.find((x) => x.id === idv) : null;
    if (idv && !r) return;
    state.mode = "recurring"; state.editing = null; state.editingRow = null; state.editingRec = r;
    $("fErr").textContent = "";
    $("fAcc").innerHTML = ""; $("fFrom").innerHTML = ""; $("fTo").innerHTML = "";
    $("fDate").min = ""; $("fDate").max = "";
    $("fRepeat").checked = false; $("fAuto").checked = r ? r.auto : true;
    $("fPresets").querySelectorAll("button").forEach((b) => b.classList.remove("on"));
    setKind(r ? r.kind : "expense");
    $("fType").value = r ? r.type || "" : "";
    refreshFormFields();
    $("fDate").value = r ? r.next_due : state.today;
    $("fName").value = r ? r.name : "";
    $("fAmt").value = r ? String(r.amount) : "";
    sizeAmount();
    $("fCat").value = r ? r.category || "" : "";
    if (r && r.kind === "transfer") { $("fFrom").value = r.account_id; refreshFormFields(); $("fTo").value = r.to_account_id; }
    else if (r) $("fAcc").value = r.account_id || "";
    else { const def = (lastAcc && accById(lastAcc)) ? lastAcc : (sortedAccounts()[0] || {}).id; if (def) $("fAcc").value = def; }
    $("formTitle").textContent = r ? "Edit recurring payment" : "New recurring payment";
    $("fSave").querySelector("span").textContent = r ? "Save changes" : "Save";
    $("fDelete").classList.toggle("hidden", !r);
    $("entryDlg").showModal();
  }
  function applyPreset(key) {
    const p = PRESETS[key]; if (!p) return;
    $("fPresets").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.p === key));
    if (p.kind !== state.kind) { setKind(p.kind); $("fAcc").value = ""; }
    $("fType").value = p.type || "";
    refreshFormFields();
    if (!$("fAcc").value) { const def = (sortedAccounts().find((a) => a.kind === "bank") || {}).id; if (def) $("fAcc").value = def; }
    $("fName").value = p.name; $("fCat").value = p.category;
    $("fAmt").focus();
  }
  function sizeAmount() { const i = $("fAmt"); i.style.width = Math.max(1, (i.value || i.placeholder).length) + 0.6 + "ch"; }
  function closeEntry() { $("entryDlg").close(); state.editing = null; state.editingRow = null; state.editingRec = null; }
  async function saveEntry(e) {
    if (e) e.preventDefault();
    $("fErr").textContent = "";
    const { row, error, field } = readForm();
    if (error) { $("fErr").textContent = error; if (field) $(field).focus(); return; }
    $("fSave").disabled = true;
    try {
      if (state.mode === "recurring") {
        const cur = state.editingRec;
        const { recurring } = await api("saveRecurring", { id: cur ? cur.id : undefined, row });
        state.recurring = cur ? state.recurring.map((x) => (x.id === recurring.id ? recurring : x)) : state.recurring.concat([recurring]);
        if (row.kind !== "transfer" && row.account_id) lastAcc = row.account_id;
        closeEntry();
        if (recurring.auto && recurring.next_due <= state.today) await reloadData();   // the server adds today's entry on load
        renderCurrent();
        toast(cur ? "Recurring payment saved" : `${recurring.name} added · next on ${shortD(recurring.next_due)}`);
        return;
      }
      if (state.editing) {
        const { row: saved } = await api("updateTxn", { id: state.editing, row });
        state.txns = state.txns.map((x) => (x.id === saved.id ? saved : x));
        toast("Entry updated");
      } else {
        const repeat = $("fRepeat").checked ? { auto: $("fAuto").checked } : undefined;
        const res = await api("addTxn", { row, repeat });
        state.txns.push(res.row);
        if (res.recurring) state.recurring.push(res.recurring);
        if (row.kind !== "transfer" && row.account_id) lastAcc = row.account_id;
        toast(res.recurring ? `Entry added · repeats on the ${ordinal(res.recurring.day)}` : "Entry added");
      }
      closeEntry();
      renderCurrent();
    } catch (ex) { $("fErr").textContent = "Could not save: " + ex.message; }
    finally { $("fSave").disabled = false; }
  }
  async function deleteEntry() {
    if (state.mode === "recurring") {
      const rr = state.editingRec; if (!rr) return;
      if (!confirm(`Delete the recurring payment "${rr.name}"? Entries already added stay as they are.`)) return;
      try { await api("deleteRecurring", { id: rr.id }); }
      catch (e) { $("fErr").textContent = "Could not delete: " + e.message; return; }
      state.recurring = state.recurring.filter((x) => x.id !== rr.id);
      closeEntry(); renderCurrent(); toast("Recurring payment deleted");
      return;
    }
    const r = state.editingRow; if (!r) return;
    if (!confirm(`Delete "${r.name || r.category || r.kind}" (${fmt(r.amount)})?`)) return;
    $("fDelete").disabled = true;
    try { await api("deleteTxn", { id: r.id }); }
    catch (e) { $("fErr").textContent = "Could not delete: " + e.message; return; }
    finally { $("fDelete").disabled = false; }
    state.txns = state.txns.filter((x) => x.id !== r.id);
    closeEntry(); renderCurrent(); toast("Entry deleted");
  }

  // ---------- plan: budgets and recurring payments ----------
  function renderPlan() {
    const m = state.month, t = monthTotals(m), ob = overallBudget(), spend = spendByCat(m);
    const isCur = m === state.today.slice(0, 7);
    $("pMonth").textContent = monthLabel(m);
    // overall budget
    if (!ob) {
      $("budgetMain").innerHTML = `<div class="b-empty"><div class="b-empty-t">Set a monthly budget</div>
        <p class="muted">One limit for everything you spend in a month (not counting investments). Then split it by category to see where it goes.</p>
        <button class="btn primary" type="button" data-bud="new-overall">${icon("i-plus")}<span>Set monthly budget</span></button></div>`;
    } else {
      const left = round2(ob.amount - t.exp), pct = Math.round((t.exp / ob.amount) * 100);
      const daysLeft = isCur ? lastDay(m) - Number(state.today.slice(8, 10)) + 1 : 0;
      const pace = isCur && left > 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} to go · about ${fmt0(left / daysLeft)} a day` : isCur ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} to go` : "";
      const allocated = catBudgets().reduce((s, b) => s + b.amount, 0);
      $("budgetMain").innerHTML = `<div class="b-top"><div><div class="s-label">Spent in ${esc(monthLong(m).split(" ")[0])}</div>
          <div class="b-big">${esc(fmt0(t.exp))}<span class="b-of"> of ${esc(fmt0(ob.amount))}</span></div></div>
          <button class="btn ghost sm" type="button" data-bud="${esc(ob.id)}">Edit</button></div>
        <div class="bar big"><span data-w="${Math.min(100, pct)}"${left < 0 ? ' class="over"' : ""}></span></div>
        <div class="b-foot"><span class="${left < 0 ? "neg" : "pos"}">${esc(left >= 0 ? fmt0(left) + " left" : fmt0(-left) + " over")}</span><span>${esc(pace)}</span></div>
        ${allocated ? `<div class="b-alloc${allocated > ob.amount ? " neg" : ""}">${esc(fmt0(allocated))} of ${esc(fmt0(ob.amount))} split into categories${allocated > ob.amount ? ", more than the monthly budget" : ""}</div>` : ""}`;
    }
    // category budgets
    const cats = catBudgets().map((b) => ({ b, spent: round2((spend.get(catKey(b.category)) || { amt: 0 }).amt) }))
      .sort((x, y) => y.spent / y.b.amount - x.spent / x.b.amount);
    $("budRows").innerHTML = cats.length ? cats.map(({ b, spent }) => {
      const left = round2(b.amount - spent), pct = Math.round((spent / b.amount) * 100);
      return `<button type="button" class="row b-row" data-bud="${esc(b.id)}">${entryIcon("expense", b.category)}
        <span class="r-main"><span class="r-title">${esc(b.category)}</span><span class="r-sub">${esc(fmt0(spent))} of ${esc(fmt0(b.amount))}</span>
          <span class="bar"><span data-w="${Math.min(100, pct)}"${left < 0 ? ' class="over"' : pct >= 85 ? ' class="near"' : ""}></span></span></span>
        <span class="r-val"><span class="r-amt${left < 0 ? " neg" : ""}">${esc(left >= 0 ? fmt0(left) : fmt0(-left))}</span><span class="r-sub">${left >= 0 ? "left" : "over"}</span></span>
      </button>`;
    }).join("") : `<div class="rows-empty">No category budgets yet. Add one for the things you want to keep an eye on, like Groceries or Eating out.</div>`;
    const budgeted = new Set(catBudgets().map((b) => catKey(b.category)));
    const other = [...spend.entries()].filter(([k]) => !budgeted.has(k)).reduce((s, [, v]) => s + v.amt, 0);
    $("budNote").textContent = cats.length && other > 0 ? `${fmt0(other)} spent this month in categories without a budget.` : "";
    // recurring
    const recs = [...state.recurring].sort((a, b) => a.day - b.day || a.name.localeCompare(b.name));
    $("recRows").innerHTML = recs.length ? recs.map((r) => {
      const acc = r.kind === "transfer" ? `${accName(r.account_id)} → ${accName(r.to_account_id)}` : accName(r.account_id);
      const sign = r.kind === "income" ? "+" : r.kind === "expense" ? "−" : "";
      return `<button type="button" class="row" data-rec="${esc(r.id)}">${entryIcon(r.kind, r.category || r.name)}
        <span class="r-main"><span class="r-title">${esc(r.name)}</span><span class="r-sub">${esc(ordinal(r.day))} of every month · ${esc(acc)}${r.auto ? "" : " · confirm"}</span></span>
        <span class="r-val"><span class="r-amt${r.kind === "income" ? " pos" : ""}">${sign}${esc(fmt0(r.amount))}</span><span class="r-sub">next ${esc(shortD(r.next_due))}</span></span>
      </button>`;
    }).join("") : `<div class="rows-empty">Nothing yet. Add rent, your maid or cook, SIPs, RDs and subscriptions once, and they're added for you every month.</div>`;
    const out = state.recurring.filter((r) => r.kind === "expense").reduce((s, r) => s + r.amount, 0);
    const inc = state.recurring.filter((r) => r.kind === "income").reduce((s, r) => s + r.amount, 0);
    $("recNote").textContent = out || inc ? [out ? `${fmt0(out)} goes out` : "", inc ? `${fmt0(inc)} comes in` : ""].filter(Boolean).join(" and ") + " every month through recurring payments." : "";
    applyBars($("tab-plan"));
  }

  // budget dialog: the overall budget (category null) or one category
  const bud = { id: null, overall: false };
  function expenseCategories() {
    return distinct(state.txns.filter((t) => t.kind === "expense" && t.type !== "Investment").map((t) => t.category));
  }
  function budgetHint() {
    if (bud.overall) {
      const prev = monthTotals(shiftMonth(state.month, -1)).exp;
      $("budHint").textContent = `Covers everything you spend, except investments and transfers.${prev ? ` Last month you spent ${fmt0(prev)}.` : ""}`;
      return;
    }
    const k = catKey($("budCat").value);
    if (!k) { $("budHint").textContent = ""; return; }
    const months = [1, 2, 3].map((i) => shiftMonth(state.month, -i));
    const vals = months.map((mm) => (spendByCat(mm).get(k) || { amt: 0 }).amt);
    const avg = vals.reduce((a, b) => a + b, 0) / 3;
    $("budHint").textContent = vals[0] || avg ? `Last month: ${fmt0(vals[0])} · 3-month average: ${fmt0(avg)}` : "No spending in this category in the last 3 months.";
  }
  function openBudget(key) {
    const b = key && key !== "new-overall" && key !== "new-cat" ? state.budgets.find((x) => x.id === key) : null;
    bud.id = b ? b.id : null; bud.overall = b ? b.category === null : key === "new-overall";
    $("budErr").textContent = "";
    $("budTitle").textContent = bud.overall ? "Monthly budget" : b ? "Category budget" : "New category budget";
    $("budCatWrap").classList.toggle("hidden", bud.overall);
    $("budCat").value = b && b.category ? b.category : "";
    $("budAmt").value = b ? String(b.amount) : "";
    const taken = new Set(catBudgets().map((x) => catKey(x.category)));
    const cats = expenseCategories().filter((c) => !taken.has(catKey(c)) || (b && catKey(c) === catKey(b.category)));
    $("budCatList").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
    // quick picks: biggest categories over the last 3 months that don't have a budget yet
    const totals = new Map();
    for (const i of [1, 2, 3, 0]) for (const [k, v] of spendByCat(shiftMonth(state.month, -i))) if (k && !taken.has(k)) totals.set(v.name, (totals.get(v.name) || 0) + v.amt);
    const picks = bud.overall || b ? [] : [...totals.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([n]) => n);
    $("budSugg").classList.toggle("hidden", !picks.length);
    $("budSugg").innerHTML = picks.map((n) => `<button type="button" data-c="${esc(n)}">${esc(n)}</button>`).join("");
    $("budDelete").classList.toggle("hidden", !b);
    budgetHint();
    sizeBudAmt();
    $("budDlg").showModal();
    (bud.overall || b ? $("budAmt") : $("budCat")).focus();
  }
  function sizeBudAmt() { const i = $("budAmt"); i.style.width = Math.max(1, (i.value || i.placeholder).length) + 0.6 + "ch"; }
  async function saveBudget(e) {
    e.preventDefault();
    $("budErr").textContent = "";
    const amt = $("budAmt").value.trim().replace(/,/g, "");
    if (!MONEY_RE.test(amt) || Number(amt) <= 0) { $("budErr").textContent = "Enter an amount greater than zero."; $("budAmt").focus(); return; }
    let category = null;
    if (!bud.overall) {
      category = $("budCat").value.trim();
      if (!category) { $("budErr").textContent = "Choose a category."; $("budCat").focus(); return; }
      const same = expenseCategories().find((c) => catKey(c) === catKey(category));   // keep the spelling used in entries
      if (same) category = same;
    }
    $("budSave").disabled = true;
    try {
      const { budget } = await api("saveBudget", { id: bud.id || undefined, category, amount: amt });
      state.budgets = state.budgets.filter((x) => x.id !== budget.id && (x.category === null ? budget.category !== null : budget.category === null || catKey(x.category) !== catKey(budget.category)));
      state.budgets.push(budget);
      $("budDlg").close(); renderCurrent(); toast(bud.overall ? "Monthly budget saved" : `Budget for ${budget.category} saved`);
    } catch (ex) { $("budErr").textContent = ex.message; }
    finally { $("budSave").disabled = false; }
  }
  async function deleteBudget() {
    const b = state.budgets.find((x) => x.id === bud.id); if (!b) return;
    if (!confirm(b.category === null ? "Remove your monthly budget?" : `Remove the budget for ${b.category}?`)) return;
    try { await api("deleteBudget", { id: b.id }); }
    catch (e) { $("budErr").textContent = e.message; return; }
    state.budgets = state.budgets.filter((x) => x.id !== b.id);
    $("budDlg").close(); renderCurrent(); toast("Budget removed");
  }

  // ---------- daily reminder (a repeating calendar event; no server scheduler needed) ----------
  function renderReminder() {
    const t = state.reminder.time;
    $("remTime").value = t;
    // A 5-minute event from the chosen time today (IST wall-clock time; Google applies ctz).
    const [y, mo, d] = state.today.split("-").map(Number), [h, mi] = t.split(":").map(Number);
    const stamp = (dt) => dt.toISOString().slice(0, 19).replace(/[-:]/g, "");
    const start = stamp(new Date(Date.UTC(y, mo - 1, d, h, mi))), end = stamp(new Date(Date.UTC(y, mo - 1, d, h, mi + 5)));
    const app = location.origin + "/";
    $("remGoogle").href = "https://calendar.google.com/calendar/render?" + new URLSearchParams({
      action: "TEMPLATE", text: "Add today's spending in Money Manager", details: `Open Money Manager: ${app}`,
      dates: `${start}/${end}`, ctz: "Asia/Kolkata", recur: "RRULE:FREQ=DAILY",
    }).toString();
    $("remIcs").href = "/api/data?op=ics&t=" + encodeURIComponent(t);
  }
  async function changeReminderTime() {
    const time = $("remTime").value;
    if (!/^\d{2}:\d{2}$/.test(time)) return;
    $("remErr").textContent = "";
    state.reminder.time = time; renderReminder();
    try { await api("saveReminder", { time }); toast(`Reminder time set to ${fmtTime(time)}. Add it to your calendar below.`); }
    catch (e) { $("remErr").textContent = e.message; }
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
  const KIND_NAME = { bank: "Bank account", card: "Credit card", cash: "Cash" };
  function openSettings() {
    renderSettings();
    $("profileForm").classList.add("hidden"); $("pfEdit").classList.remove("hidden"); $("pfErr").textContent = "";
    document.querySelector(".tabs").classList.add("hidden");  // Settings is its own page; Back returns to the tabs
    markNav("settings");
    showView("settingsView"); window.scrollTo({ top: 0 });
  }
  function renderSettings() {
    const n = displayName();
    $("pfAvatar").textContent = initials(n); $("pfNameTxt").textContent = n; $("pfEmail").textContent = state.email || "";
    let html = "";
    for (const a of sortedAccounts()) {
      const st = accountStats(a, null);
      const sub = a.kind === "card" ? `Limit ${fmt0(a.credit_limit)} · ${fmt0(round2(a.credit_limit - st.closing))} available` : KIND_NAME[a.kind];
      html += `<button type="button" class="row" data-acc="${esc(a.id)}">
        <span class="r-ic">${icon(KIND_ICON[a.kind])}</span>
        <span class="r-main"><span class="r-title">${esc(a.name)}</span><span class="r-sub">${esc(sub)}</span></span>
        <span class="r-val"><span class="r-amt${a.kind !== "card" && st.closing < 0 ? " neg" : ""}">${esc(fmt(st.closing))}</span><span class="r-sub">${a.kind === "card" ? "due" : "balance"}</span></span>
        <svg class="i chev" aria-hidden="true"><use href="#i-right"/></svg>
      </button>`;
    }
    $("accRows").innerHTML = html;
    const none = !state.accounts.length;
    $("accRows").classList.toggle("hidden", none);
    $("accAdd").classList.toggle("hidden", none || (!freeSlot("bank") && !freeSlot("card")));
    $("accSec").classList.toggle("hidden", none); $("accNote").classList.toggle("hidden", none);
    $("welcome").classList.toggle("hidden", !state.onboarding);
    $("welcomeTitle").textContent = firstName() ? `Welcome, ${firstName()}` : "Welcome";
    $("settingsBack").classList.toggle("hidden", state.onboarding);
    $("gEmail").textContent = state.email || "";
    renderReminder();
  }
  async function saveProfile(e) {
    e.preventDefault();
    const name = $("pfName").value.trim();
    $("pfErr").textContent = "";
    if (!name) { $("pfErr").textContent = "Enter your name."; return; }
    $("pfSave").disabled = true;
    try {
      const r = await api("saveProfile", { name }); state.name = r.name; renderUser(); renderSettings();
      $("profileForm").classList.add("hidden"); $("pfEdit").classList.remove("hidden"); toast("Name saved");
    } catch (ex) { $("pfErr").textContent = ex.message; }
    finally { $("pfSave").disabled = false; }
  }

  // account dialog: edits one account, then saves the full list (the API takes all accounts at once)
  const freeSlot = (kind) => [1, 2].find((n) => !state.accounts.some((a) => a.kind === kind && a.slot === n));
  const acc = { id: null, kind: "bank" };
  function setAccKind(k) {
    acc.kind = k;
    $("accKind").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
    $("accNameWrap").classList.toggle("hidden", k === "cash");
    $("accLimWrap").classList.toggle("hidden", k !== "card");
    $("accBalLbl").textContent = k === "card" ? "Amount due when you started (₹)" : k === "cash" ? "Cash you started with (₹)" : "Balance when you started (₹)";
    $("accName").placeholder = k === "card" ? "e.g. HDFC Millennia" : "e.g. SBI Salary";
  }
  function openAccount(id) {
    const a = id ? accById(id) : null;
    acc.id = a ? a.id : null;
    $("accErr").textContent = "";
    $("accTitle").textContent = a ? (a.kind === "cash" ? "Cash" : "Edit account") : "Add account";
    $("accKind").classList.toggle("hidden", !!a);
    const hasBank = state.accounts.some((x) => x.kind === "bank");
    if (!a) $("accKind").querySelectorAll("button").forEach((b) => { b.disabled = !freeSlot(b.dataset.k) || (b.dataset.k === "card" && !hasBank); });
    setAccKind(a ? a.kind : freeSlot("bank") ? "bank" : "card");
    $("accName").value = a ? a.name : "";
    $("accBal").value = a ? String(a.opening_balance) : "";
    $("accLim").value = a && a.credit_limit ? String(a.credit_limit) : "";
    const removable = a && a.kind !== "cash" && !(a.kind === "bank" && a.slot === 1);
    $("accRemove").classList.toggle("hidden", !removable);
    $("accHint").textContent = a ? "Current balances are worked out from this starting amount plus your entries."
      : !hasBank ? "Enter what's in the account today. Your balance updates as you add entries." : "";
    $("accDlg").showModal();
    if (!a) $("accName").focus();
  }
  const accPayload = (a) => ({ kind: a.kind, slot: a.slot, name: a.name, opening_balance: String(a.opening_balance), ...(a.kind === "card" ? { credit_limit: String(a.credit_limit) } : {}) });
  async function sendAccounts(list, msg) {
    $("accSave").disabled = $("accRemove").disabled = true;
    try {
      const r = await api("saveAccounts", { accounts: list });
      state.accounts = r.accounts; $("accDlg").close();
      if (state.onboarding) { finishOnboarding(); return; }
      renderSettings(); toast(msg);
    } catch (e) { $("accErr").textContent = e.message; }
    finally { $("accSave").disabled = $("accRemove").disabled = false; }
  }
  function saveAccount(e) {
    e.preventDefault();
    $("accErr").textContent = "";
    const k = acc.kind, cur = acc.id ? accById(acc.id) : null;
    const name = k === "cash" ? "Cash" : $("accName").value.trim();
    const bal = ($("accBal").value.trim() || "0").replace(/,/g, "");
    const lim = $("accLim").value.trim().replace(/,/g, "");
    if (!name) { $("accErr").textContent = "Enter a name."; $("accName").focus(); return; }
    if (!MONEY_RE.test(bal)) { $("accErr").textContent = "Enter a valid amount (no minus sign, up to 2 decimals)."; $("accBal").focus(); return; }
    if (k === "card" && (!MONEY_RE.test(lim) || Number(lim) <= 0)) { $("accErr").textContent = "Enter the credit limit."; $("accLim").focus(); return; }
    const updated = { kind: k, slot: cur ? cur.slot : freeSlot(k), name, opening_balance: bal, credit_limit: k === "card" ? lim : null };
    if (!updated.slot) { $("accErr").textContent = "You already have two of these."; return; }
    const list = state.accounts.filter((a) => !cur || a.id !== cur.id).map(accPayload).concat([accPayload(updated)]);
    sendAccounts(list, cur ? "Account saved" : "Account added");
  }
  function removeAccount() {
    const cur = accById(acc.id); if (!cur) return;
    if (!confirm(`Remove "${cur.name}"?`)) return;
    sendAccounts(state.accounts.filter((a) => a.id !== cur.id).map(accPayload), "Account removed");
  }

  // New users land on Settings to add their first bank account; the rest of the app opens after that.
  function startOnboarding() {
    state.onboarding = true;
    document.querySelector(".tabs").classList.add("hidden"); $("settingsBtn").disabled = true;
    $("bottomNav").classList.add("hidden");
    openSettings();
  }
  function finishOnboarding() {
    state.onboarding = false;
    $("settingsBtn").disabled = false; $("bottomNav").classList.remove("hidden");
    setMonth(state.month); setTab("monthly");
    toast("You're all set. Add your first entry.");
  }

  // ---------- navigation & auth ----------
  function markNav(key) {
    $("bottomNav").querySelectorAll("button").forEach((b) => {
      const on = (b.dataset.tab || b.dataset.nav) === key;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
  }
  function setTab(tab) {
    state.tab = tab;
    document.querySelector(".tabs").classList.remove("hidden"); $("settingsBtn").disabled = false;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    markNav(tab);
    showView("tab-" + tab);
    window.scrollTo({ top: 0 });
    if (tab === "dashboard") renderDashboard(); else if (tab === "monthly") renderMonthly(); else if (tab === "plan") renderPlan(); else renderInvestment();
  }
  function applyData(d) {
    state.accounts = d.accounts; state.txns = d.transactions.map((t) => ({ ...t, amount: Number(t.amount) }));
    state.recurring = d.recurring || []; state.budgets = d.budgets || [];
    state.reminder = d.reminder || state.reminder; state.today = d.today || todayISO();
  }
  async function reloadData() { try { applyData(await api("all")); } catch { /* keep what we have */ } }
  async function enterApp(email, name) {
    state.email = email; state.name = name || null; renderUser();
    showPage("app"); $("appErr").textContent = "";
    for (const v of VIEWS) $(v).classList.add("hidden");
    $("loader").classList.remove("hidden");
    try {
      applyData(await api("all"));
    } catch (e) { $("loader").classList.add("hidden"); $("appErr").textContent = "Could not load data: " + e.message; return; }
    if (!state.accounts.length) { startOnboarding(); return; }
    setMonth(state.month);
    setTab("monthly");
  }
  function signedOut(msg) {
    MM.setCsrf(""); state.email = null; state.name = null; state.accounts = []; state.txns = [];
    for (const d of ["entryDlg", "accDlg", "budDlg"]) if ($(d).open) $(d).close();
    state.onboarding = false; $("settingsBtn").disabled = false; $("bottomNav").classList.remove("hidden");
    for (const k of Object.keys(state.charts)) if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
    showPage("login"); $("authErr").textContent = msg || "";
  }
  function wire() {
    MM.setUnauthorizedHandler(() => signedOut("Your session ended. Please sign in again."));
    $("signOut2").addEventListener("click", async () => { try { await api("logout", {}); } catch { /* ignore */ } signedOut(); });
    $("settingsBtn").addEventListener("click", openSettings);
    $("settingsBack").addEventListener("click", () => setTab(state.tab));
    $("pfEdit").addEventListener("click", () => { $("pfName").value = state.name || ""; $("profileForm").classList.remove("hidden"); $("pfEdit").classList.add("hidden"); $("pfName").focus(); });
    $("pfCancel").addEventListener("click", () => { $("profileForm").classList.add("hidden"); $("pfEdit").classList.remove("hidden"); $("pfErr").textContent = ""; });
    $("profileForm").addEventListener("submit", saveProfile);
    $("accRows").addEventListener("click", (e) => { const b = e.target.closest("button[data-acc]"); if (b) openAccount(b.dataset.acc); });
    $("accAdd").addEventListener("click", () => openAccount(null));
    $("accKind").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && !b.disabled) setAccKind(b.dataset.k); });
    $("accForm").addEventListener("submit", saveAccount);
    $("accRemove").addEventListener("click", removeAccount);
    $("welcomeAdd").addEventListener("click", () => openAccount(null));
    for (const [dlg, ...btns] of [["accDlg", "accClose", "accCancel"]]) {
      for (const b of btns) $(b).addEventListener("click", () => $(dlg).close());
      $(dlg).addEventListener("click", (e) => { if (e.target === $(dlg)) $(dlg).close(); });
    }
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
    $("bottomNav").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const onSettings = !$("settingsView").classList.contains("hidden");
      if (b.dataset.nav === "settings") { if (!onSettings) openSettings(); }
      else if (b.dataset.tab === state.tab && !onSettings) window.scrollTo({ top: 0, behavior: "smooth" });  // tap the current tab to go to the top
      else setTab(b.dataset.tab);
    });
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
    $("fRepeat").addEventListener("change", refreshFormFields);
    $("fPresets").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) applyPreset(b.dataset.p); });
    // plan
    $("pPrev").addEventListener("click", () => { setMonth(shiftMonth(state.month, -1)); renderPlan(); });
    $("pNext").addEventListener("click", () => { setMonth(shiftMonth(state.month, 1)); renderPlan(); });
    $("budAdd").addEventListener("click", () => openBudget("new-cat"));
    $("recAdd").addEventListener("click", () => openRecurring(null));
    for (const el of ["budgetMain", "budRows"]) $(el).addEventListener("click", (e) => { const b = e.target.closest("[data-bud]"); if (b) openBudget(b.dataset.bud); });
    $("recRows").addEventListener("click", (e) => { const b = e.target.closest("[data-rec]"); if (b) openRecurring(b.dataset.rec); });
    $("dueRows").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.post) postOrSkip(b.dataset.post, true);
      else if (b.dataset.skip) postOrSkip(b.dataset.skip, false);
      else if (b.dataset.rec) openRecurring(b.dataset.rec);
    });
    $("monthKpis").addEventListener("click", (e) => { if (e.target.closest("[data-goto=plan]")) setTab("plan"); });
    $("budForm").addEventListener("submit", saveBudget);
    $("budDelete").addEventListener("click", deleteBudget);
    $("budAmt").addEventListener("input", sizeBudAmt);
    $("budCat").addEventListener("input", budgetHint);
    $("budSugg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { $("budCat").value = b.dataset.c; budgetHint(); $("budAmt").focus(); } });
    for (const b of ["budClose", "budCancel"]) $(b).addEventListener("click", () => $("budDlg").close());
    $("budDlg").addEventListener("click", (e) => { if (e.target === $("budDlg")) $("budDlg").close(); });
    // reminder
    $("remTime").addEventListener("change", changeReminderTime);
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
      if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey && state.tab === "monthly" && !document.querySelector("dialog[open]")
        && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && !$("tab-monthly").classList.contains("hidden")) { e.preventDefault(); openEntry(null); }
    });
  }

  async function start() {
    if (typeof Chart !== "undefined") { Chart.defaults.color = css("--muted"); Chart.defaults.font.family = css("--font"); }
    wire();
    const authError = MM.takeAuthError();
    try {
      const cfg = await api("config");
      if (!cfg.db) { showPage("login"); $("authErr").textContent = "Setup is not finished: connect Neon Postgres to the Vercel project, then redeploy."; return; }
      const s = await api("session");
      if (s.authenticated) { MM.setCsrf(s.csrf); enterApp(s.email, s.name); return; }
      signedOut(authError);
      if (!cfg.google) { $("googleBtn").classList.add("hidden"); $("authErr").textContent = MM.AUTH_ERRORS.google_off; }
    } catch (e) { showPage("login"); $("authErr").textContent = "Could not reach the server: " + e.message; }
  }
  start();
})();
