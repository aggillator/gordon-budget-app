const monthLabel = document.getElementById("monthLabel");
const monthPicker = document.getElementById("monthPicker");
const categoryFilter = document.getElementById("categoryFilter");
const clearFilterBtn = document.getElementById("clearFilterBtn");
const searchBox = document.getElementById("searchBox");
const summaryList = document.getElementById("summaryList");
const txnList = document.getElementById("txnList");
const statusBar = document.getElementById("statusBar");
const categoryManageList = document.getElementById("categoryManageList");
const filterDateFrom = document.getElementById("filterDateFrom");
const filterDateTo = document.getElementById("filterDateTo");
const filterType = document.getElementById("filterType");
const filterMinAmount = document.getElementById("filterMinAmount");
const filterMaxAmount = document.getElementById("filterMaxAmount");
const filterAccount = document.getElementById("filterAccount");

let categories = [];
let accounts = [];
let spendingChartInstance = null;
const NEW_CATEGORY_VALUE = "__new__";

const CHART_PALETTE = [
  "#1B2A4A", "#2F6B4F", "#B3492D", "#8A7B4F", "#5B6B85",
  "#6B8F71", "#C97B4A", "#4A6FA5", "#A0785A", "#3E7C7C",
  "#7A5C8E", "#9A8B4F",
];

// Same category always gets the same color, without needing to store one -
// just hashes the name into the existing chart palette.
function categoryColor(name) {
  if (!name) return "#C0C0C0";
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return CHART_PALETTE[Math.abs(hash) % CHART_PALETTE.length];
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function fmt(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Plaid's raw convention is the opposite of how people read a statement:
// positive = money out, negative = money in. This flips it for display only
// - debits show "-", deposits show "+" - the underlying data/math is untouched.
function fmtTxnAmount(amount) {
  const isDeposit = amount < 0;
  const abs = Math.abs(amount);
  const sign = isDeposit ? "+" : "-";
  const cls = isDeposit ? "txn-deposit" : "txn-debit";
  return `<span class="${cls}">${sign}${fmt(abs)}</span>`;
}

function monthName(m) {
  if (m === "all") return "All Transactions";
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function populateMonthPicker() {
  const now = new Date();
  let monthsBack = 6; // fallback if there's no data yet

  try {
    const res = await fetch("/api/date-range");
    const { earliest } = await res.json();
    if (earliest) {
      const [ey, em] = earliest.split("-").map(Number);
      monthsBack =
        (now.getUTCFullYear() - ey) * 12 + (now.getUTCMonth() + 1 - em) + 1;
      monthsBack = Math.max(1, Math.min(monthsBack, 36)); // sane cap either direction
    }
  } catch {
    // fall back to 6 months if this fails for any reason
  }

  monthPicker.innerHTML = `<option value="all">All transactions</option>`;
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const val = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = monthName(val);
    monthPicker.appendChild(opt);
  }
  monthPicker.value = currentMonth();
}

function showStatus(msg, ms = 3000) {
  statusBar.textContent = msg;
  statusBar.hidden = false;
  setTimeout(() => (statusBar.hidden = true), ms);
}

function isTabActive(panelName) {
  const panel = document.querySelector(`.tab-panel[data-panel="${panelName}"]`);
  return panel ? panel.classList.contains("active") : false;
}

function setupTabGroups() {
  document.querySelectorAll(".tab-group").forEach((group) => {
    const buttons = group.querySelectorAll(".tab-btn");
    const panels = group.querySelectorAll(".tab-panel");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const alreadyActive = btn.classList.contains("active");
        buttons.forEach((b) => b.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));
        if (alreadyActive) return; // second click on the open tab just collapses it
        btn.classList.add("active");
        const target = group.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`);
        if (target) target.classList.add("active");
        document.dispatchEvent(new CustomEvent("tabshown", { detail: { tab: btn.dataset.tab } }));
      });
    });
  });
}

document.addEventListener("tabshown", (e) => {
  if (e.detail.tab === "averages") loadInsights();
  if (e.detail.tab === "history") loadRecentActions();
  if (e.detail.tab === "chart") loadSummary(monthPicker.value);
  if (e.detail.tab === "trends") loadTrends();
  if (e.detail.tab === "pending-matches") loadPendingMatches();
});

function sortedCategoriesAlpha() {
  return [...categories].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadAccounts() {
  const res = await fetch("/api/accounts");
  accounts = await res.json();
  const current = filterAccount.value;
  filterAccount.innerHTML =
    `<option value="">All accounts</option>` +
    accounts
      .map(
        (a) =>
          `<option value="${a.id}">${a.name}${a.mask ? ` (...${a.mask})` : ""}${
            a.sync_disabled ? " - sync paused" : ""
          }</option>`
      )
      .join("");
  filterAccount.value = current || "";
}

async function loadSummary(month) {
  if (month === "all") {
    summaryList.innerHTML = `<p class="empty">Budget caps are monthly, so this view needs a specific month. Check the "Averages" tab above for all-time totals and trends instead.</p>`;
    if (isTabActive("chart")) renderSpendingChart([]);
    return;
  }

  const res = await fetch(`/api/summary?month=${month}`);
  const { summary: fullSummary } = await res.json();
  const summary = fullSummary.filter((c) => c.actual > 0);
  summaryList.innerHTML = "";

  if (!fullSummary.length) {
    summaryList.innerHTML = `<p class="empty">No categories yet - run schema.sql in Supabase.</p>`;
    return;
  }

  if (!summary.length) {
    summaryList.innerHTML = `<p class="empty">No transactions yet for this month.</p>`;
    return;
  }

  for (const c of summary) {
    const pct = c.budget > 0 ? Math.min(100, (c.actual / c.budget) * 100) : c.actual > 0 ? 100 : 0;
    const over = c.actual > c.budget && c.budget > 0;
    const active = categoryFilter.value === c.id;
    const row = document.createElement("div");
    row.className = `cat-row${active ? " cat-row-active" : ""}`;
    row.dataset.id = c.id;
    row.title = "Click to filter transactions by this category";
    row.innerHTML = `
      <div class="cat-name"><span class="cat-dot" style="background:${categoryColor(c.name)}"></span>${c.name} ${c.is_fixed ? '<span class="badge">FIXED</span>' : ""}</div>
      <div class="cat-figures">
        <span class="${over ? "over" : "under"}">${fmt(c.actual)}</span> / ${fmt(c.budget)}
      </div>
      <div class="bar-track"><div class="bar-fill ${over ? "over" : "under"}" style="width:${pct}%"></div></div>
    `;
    row.addEventListener("click", () => {
      categoryFilter.value = c.id;
      onFilterChange();
      document.querySelector(".transactions").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    summaryList.appendChild(row);
  }

  const totalBudget = summary.reduce((s, c) => s + c.budget, 0);
  const totalActual = summary.reduce((s, c) => s + c.actual, 0);
  const totalPct = totalBudget > 0 ? Math.min(100, (totalActual / totalBudget) * 100) : totalActual > 0 ? 100 : 0;
  const totalOver = totalActual > totalBudget && totalBudget > 0;
  const totalRow = document.createElement("div");
  totalRow.className = "cat-row cat-row-total";
  totalRow.innerHTML = `
    <div class="cat-name">Total</div>
    <div class="cat-figures">
      <span class="${totalOver ? "over" : "under"}">${fmt(totalActual)}</span> / ${fmt(totalBudget)}
    </div>
    <div class="bar-track"><div class="bar-fill ${totalOver ? "over" : "under"}" style="width:${totalPct}%"></div></div>
  `;
  summaryList.appendChild(totalRow);

  if (isTabActive("chart")) renderSpendingChart(summary);
}

function renderSpendingChart(summary) {
  const data = summary.filter((c) => c.actual > 0);
  const ctx = document.getElementById("spendingChart").getContext("2d");
  if (spendingChartInstance) spendingChartInstance.destroy();

  if (!data.length) {
    spendingChartInstance = null;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    return;
  }

  spendingChartInstance = new Chart(ctx, {
    type: "pie",
    data: {
      labels: data.map((c) => c.name),
      datasets: [
        {
          data: data.map((c) => c.actual),
          backgroundColor: data.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]),
          borderColor: "#FAF7EF",
          borderWidth: 2,
        },
      ],
    },
    options: {
      plugins: {
        legend: { position: "right", labels: { font: { family: "Inter" } } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}`,
          },
        },
      },
    },
  });
}

function populateCategoryFilter() {
  const current = categoryFilter.value;
  categoryFilter.innerHTML =
    `<option value="">All categories</option><option value="unassigned">Unassigned</option>` +
    sortedCategoriesAlpha()
      .map((c) => `<option value="${c.id}">${c.name}</option>`)
      .join("");
  categoryFilter.value = current || "";
  updateClearFilterVisibility();
}

function updateClearFilterVisibility() {
  clearFilterBtn.hidden = !categoryFilter.value;
}

function onFilterChange() {
  updateClearFilterVisibility();
  loadSummary(monthPicker.value);
  loadTransactions(monthPicker.value);
}

function categoryOptionsHtml(selectedId) {
  return sortedCategoriesAlpha()
    .map(
      (c) =>
        `<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${c.name}</option>`
    )
    .join("");
}

function renderCategoryManage() {
  const sorted = sortedCategoriesAlpha();
  const mergeOptions = (excludeId) =>
    `<option value="">Merge into...</option>` +
    sorted
      .filter((c) => c.id !== excludeId)
      .map((c) => `<option value="${c.id}">${escapeAttr(c.name)}</option>`)
      .join("");

  categoryManageList.innerHTML = sorted
    .map(
      (c) => `
    <div class="manage-row" style="border-left: 4px solid ${categoryColor(c.name)}; padding-left: 10px;">
      <input type="text" value="${escapeAttr(c.name)}" data-id="${c.id}" class="name-input" />
      <label class="checkbox-label manage-checkbox">
        <input type="checkbox" data-id="${c.id}" class="exclude-input" ${c.exclude_from_budget ? "checked" : ""} />
        Not in budget
      </label>
      <label class="checkbox-label manage-checkbox">
        <input type="checkbox" data-id="${c.id}" class="exclude-trends-input" ${c.exclude_from_trends ? "checked" : ""} />
        Not in trends
      </label>
      <input type="number" step="0.01" min="0" value="${c.monthly_budget}" data-id="${c.id}" class="budget-input" ${c.exclude_from_budget ? "disabled" : ""} />
      ${c.is_fixed ? '<span class="badge">FIXED</span>' : "<span></span>"}
      <select class="merge-select" data-id="${c.id}" data-name="${escapeAttr(c.name)}">${mergeOptions(c.id)}</select>
      <button type="button" class="delete-cat-btn" data-id="${c.id}" data-name="${escapeAttr(c.name)}" title="Delete category">×</button>
    </div>`
    )
    .join("");

  categoryManageList.querySelectorAll(".merge-select").forEach((select) => {
    select.addEventListener("change", async (e) => {
      const sourceId = e.target.dataset.id;
      const sourceName = e.target.dataset.name;
      const targetId = e.target.value;
      if (!targetId) return;
      const targetName = e.target.options[e.target.selectedIndex].textContent;
      if (
        !confirm(
          `Merge "${sourceName}" into "${targetName}"?\n\nAll of "${sourceName}"'s transactions and keyword rules move to "${targetName}", their budgets combine, and "${sourceName}" is deleted. This cannot be undone.`
        )
      ) {
        e.target.value = "";
        return;
      }
      const res = await fetch("/api/merge-category", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source_id: sourceId, target_id: targetId }),
      });
      const data = await res.json();
      if (!res.ok) {
        showStatus(`Merge failed: ${data.error}`, 6000);
        return;
      }
      showStatus(`Merged "${sourceName}" into "${targetName}" - ${data.moved} transaction${data.moved === 1 ? "" : "s"} moved`);
      refresh();
    });
  });

  categoryManageList.querySelectorAll(".name-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const name = e.target.value.trim();
      if (!name) return;
      await fetch("/api/categories", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: e.target.dataset.id, name }),
      });
      showStatus("Category renamed");
      refresh();
    });
  });

  categoryManageList.querySelectorAll(".budget-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      await fetch("/api/categories", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: e.target.dataset.id,
          monthly_budget: parseFloat(e.target.value) || 0,
        }),
      });
      loadSummary(monthPicker.value);
      showStatus("Budget updated");
    });
  });

  categoryManageList.querySelectorAll(".exclude-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      await fetch("/api/categories", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: e.target.dataset.id,
          exclude_from_budget: e.target.checked,
        }),
      });
      showStatus(
        e.target.checked
          ? "Marked as not a budget category"
          : "Marked as a budget category"
      );
      refresh();
    });
  });

  categoryManageList.querySelectorAll(".exclude-trends-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      await fetch("/api/categories", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: e.target.dataset.id,
          exclude_from_trends: e.target.checked,
        }),
      });
      showStatus(
        e.target.checked
          ? "Excluded from income/spending trends"
          : "Included in income/spending trends"
      );
      if (isTabActive("trends")) loadTrends();
    });
  });

  categoryManageList.querySelectorAll(".delete-cat-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const { id, name } = e.target.dataset;
      if (
        !confirm(
          `Delete "${name}"? Any transactions currently in this category will become uncategorized - they won't be deleted, just unassigned.`
        )
      ) {
        return;
      }
      const res = await fetch(`/api/categories?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      showStatus(
        data.uncategorized
          ? `Deleted "${name}" - ${data.uncategorized} transaction${data.uncategorized === 1 ? "" : "s"} now unassigned`
          : `Deleted "${name}"`
      );
      refresh();
    });
  });
}

let amazonRows = [];
let amazonHeaders = [];

document.getElementById("amazonFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      amazonRows = results.data;
      amazonHeaders = results.meta.fields || [];
      populateAmazonMapping();
    },
    error: (err) => showStatus(`Couldn't read CSV: ${err.message}`, 6000),
  });
});

function guessColumn(headers, candidates) {
  const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const cand of candidates) {
    const match = headers.find((h) => norm(h) === cand);
    if (match) return match;
  }
  for (const cand of candidates) {
    const match = headers.find((h) => norm(h).includes(cand));
    if (match) return match;
  }
  return "";
}

function populateAmazonMapping() {
  const dateGuess = guessColumn(amazonHeaders, ["shipdate", "shipmentdate", "orderdate", "date"]);
  const titleGuess = guessColumn(amazonHeaders, ["title", "productname", "itemname", "description"]);
  const amountGuess = guessColumn(amazonHeaders, [
    "totalamount", "itemtotal", "totalowed", "itemsubtotal", "amount", "total",
  ]);
  const orderIdGuess = guessColumn(amazonHeaders, ["orderid", "orderno", "orderno."]);

  const opts = (selected) =>
    `<option value="">-- none --</option>` +
    amazonHeaders
      .map((h) => `<option value="${escapeAttr(h)}" ${h === selected ? "selected" : ""}>${escapeAttr(h)}</option>`)
      .join("");

  document.getElementById("amazonMappingSection").innerHTML = `
    <label>Ship/order date column<select id="mapDate">${opts(dateGuess)}</select></label>
    <label>Item title column<select id="mapTitle">${opts(titleGuess)}</select></label>
    <label>Amount column (use "Total Amount" - already includes tax, shipping, discounts)<select id="mapAmount">${opts(amountGuess)}</select></label>
    <label>Order ID column (required - groups items into shipments)<select id="mapOrderId">${opts(orderIdGuess)}</select></label>
  `;
  document.getElementById("amazonMappingSection").hidden = false;
  document.getElementById("amazonPreviewNote").textContent =
    `${amazonRows.length} rows loaded. "Total Amount" already nets out tax, shipping, and discounts per item - use that column for the most accurate match.`;
  document.getElementById("matchAmazonBtn").hidden = false;
}

function normalizeAmazonDate(raw) {
  const d = new Date(raw);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

document.getElementById("matchAmazonBtn").addEventListener("click", async () => {
  const dateCol = document.getElementById("mapDate").value;
  const titleCol = document.getElementById("mapTitle").value;
  const amountCol = document.getElementById("mapAmount").value;
  const orderIdCol = document.getElementById("mapOrderId").value;

  if (!dateCol || !titleCol || !amountCol) {
    showStatus("Please map at least date, title, and amount columns", 5000);
    return;
  }

  const groups = {};
  amazonRows.forEach((row, i) => {
    const idPart = orderIdCol ? row[orderIdCol] : `row-${i}`;
    const key = `${idPart}|${row[dateCol]}`;
    if (!groups[key]) groups[key] = { date: row[dateCol], titles: [], amount: 0, items: [] };
    const amt = parseFloat(String(row[amountCol]).replace(/[^0-9.-]/g, "")) || 0;
    const title = row[titleCol];
    groups[key].titles.push(title);
    groups[key].amount += amt;
    groups[key].items.push({ title, amount: Number(amt.toFixed(2)) });
  });

  const allOrders = Object.values(groups)
    .map((g) => ({
      date: normalizeAmazonDate(g.date),
      title: g.titles.filter(Boolean).join(", ").slice(0, 200),
      amount: Number(g.amount.toFixed(2)),
      items: g.items.filter((it) => it.title && it.amount),
    }))
    .filter((o) => o.date && o.amount > 0);

  if (!allOrders.length) {
    showStatus("No valid orders found with that column mapping", 5000);
    return;
  }

  // Sent in small batches - the endpoint fetches candidate transactions once
  // per call, so keeping batches modest avoids Cloudflare's subrequest cap.
  const CHUNK = 30;
  let totalMatched = 0;

  for (let i = 0; i < allOrders.length; i += CHUNK) {
    const chunk = allOrders.slice(i, i + CHUNK);
    showStatus(`Matching orders... (${totalMatched} matched so far)`, 20000);
    const res = await fetch("/api/import-amazon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orders: chunk }),
    });
    const data = await res.json();
    if (!res.ok) {
      showStatus(`Import failed: ${data.error}`, 6000);
      return;
    }
    totalMatched += data.matched;
  }

  showStatus(`Matched ${totalMatched} of ${allOrders.length} orders to transactions`, 8000);
  refresh();
});

let insightsSortKey = "average";
let insightsSortDir = "desc";

async function loadInsights() {
  const res = await fetch("/api/insights");
  const { months_tracked, categories: rows } = await res.json();

  document.getElementById("insightsNote").textContent = months_tracked
    ? `Based on ${months_tracked} month${months_tracked === 1 ? "" : "s"} of transaction history.`
    : "Not enough history yet to compute averages.";

  const sorted = [...rows].sort((a, b) => {
    const dir = insightsSortDir === "asc" ? 1 : -1;
    if (insightsSortKey === "name") return a.name.localeCompare(b.name) * dir;
    return (a[insightsSortKey] - b[insightsSortKey]) * dir;
  });

  document.querySelectorAll(".insights-header span").forEach((el) => {
    el.classList.toggle("sort-active", el.dataset.sort === insightsSortKey);
  });

  const table = document.getElementById("insightsTable");
  if (!sorted.length) {
    table.innerHTML = `<p class="empty">No spending history yet.</p>`;
    return;
  }

  const rowsHtml = sorted
    .map((c) => {
      const overAvg = c.budget > 0 && c.average > c.budget;
      return `
    <div class="insight-row">
      <span class="insight-name">${c.name}</span>
      <span class="${overAvg ? "over-budget" : ""}">${fmt(c.average)}</span>
      <span>${fmt(c.min)}</span>
      <span>${fmt(c.max)}</span>
      <span>${fmt(c.budget)}</span>
    </div>`;
    })
    .join("");

  const totalAverage = sorted.reduce((s, c) => s + c.average, 0);
  const totalMin = sorted.reduce((s, c) => s + c.min, 0);
  const totalMax = sorted.reduce((s, c) => s + c.max, 0);
  const totalBudget = sorted.reduce((s, c) => s + c.budget, 0);
  const totalOverAvg = totalBudget > 0 && totalAverage > totalBudget;
  const totalRowHtml = `
    <div class="insight-row insight-row-total">
      <span class="insight-name">Total</span>
      <span class="${totalOverAvg ? "over-budget" : ""}">${fmt(totalAverage)}</span>
      <span>${fmt(totalMin)}</span>
      <span>${fmt(totalMax)}</span>
      <span>${fmt(totalBudget)}</span>
    </div>`;

  table.innerHTML = rowsHtml + totalRowHtml;
}

document.querySelectorAll(".insights-header span").forEach((el) => {
  el.addEventListener("click", () => {
    const key = el.dataset.sort;
    if (insightsSortKey === key) {
      insightsSortDir = insightsSortDir === "asc" ? "desc" : "asc";
    } else {
      insightsSortKey = key;
      insightsSortDir = "desc";
    }
    loadInsights();
  });
});

async function loadConnectedAccounts() {
  const res = await fetch("/api/plaid-items");
  const items = await res.json();
  const list = document.getElementById("connectedAccountsList");

  if (!items.length) {
    list.innerHTML = `<p class="empty">No banks connected yet.</p>`;
    return;
  }

  list.innerHTML = items
    .map((it) => {
      const accountsStr = it.accounts
        .map((a) => `${a.name}${a.mask ? ` (...${a.mask})` : ""}`)
        .join(", ");
      return `
    <div class="connected-item">
      <div class="inst-name">${escapeAttr(it.institution_name)}</div>
      <button type="button" class="disconnect-btn" data-id="${it.id}" data-name="${escapeAttr(it.institution_name)}" data-count="${it.txn_count}">
        Disconnect
      </button>
      <div class="inst-accounts">${accountsStr || "No accounts"} - ${it.txn_count} transaction${it.txn_count === 1 ? "" : "s"}</div>
    </div>`;
    })
    .join("");

  list.querySelectorAll(".disconnect-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const { id, name, count } = e.target.dataset;
      if (
        !confirm(
          `Disconnect "${name}"?\n\nThis will revoke Plaid's access and permanently delete all ${count} transaction${count === "1" ? "" : "s"} for this account from your database. This does NOT free up a Trial-plan Item slot - if you reconnect the same bank later, it uses a new slot.\n\nThis cannot be undone. Continue?`
        )
      ) {
        return;
      }
      showStatus(`Disconnecting ${name}...`, 15000);
      const res = await fetch(`/api/plaid-items?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        showStatus(`Failed to disconnect: ${data.error || "unknown error"}`, 6000);
        return;
      }
      showStatus(`Disconnected ${data.institution_name}`);
      refresh();
    });
  });
}

async function loadCategories() {
  const res = await fetch("/api/categories");
  categories = await res.json();
  populateCategoryFilter();
  renderCategoryManage();
}

// Creates a category via the API and returns its id. Used by both the
// bottom "Manage categories" form and the inline quick-add in each
// transaction row, so both stay in sync with the same logic.
async function createCategory({ name, monthly_budget = 0, exclude_from_budget = false }) {
  const res = await fetch("/api/categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, monthly_budget, exclude_from_budget }),
  });
  const created = await res.json();
  await loadCategories();
  return created.id;
}

async function setTransactionCategory(txnId, categoryId) {
  if (!categoryId) {
    return applyTransactionCategory(txnId, null, false);
  }

  const previewRes = await fetch("/api/transactions", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: txnId, category_id: categoryId, preview: true }),
  });
  const preview = await previewRes.json();

  let applyToAll = false;
  if (preview.match_count > 0) {
    applyToAll = confirm(
      `${preview.match_count} other transaction${preview.match_count === 1 ? "" : "s"} match "${preview.keyword}".\n\nOK = apply this category to all ${preview.match_count + 1} of them\nCancel = just this one transaction`
    );
  }

  await applyTransactionCategory(txnId, categoryId, applyToAll);
}

async function applyTransactionCategory(txnId, categoryId, applyToAll) {
  const res = await fetch("/api/transactions", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: txnId, category_id: categoryId || null, apply_to_all: applyToAll }),
  });
  const data = await res.json();
  showStatus(
    data.propagated
      ? `Category updated - applied to ${data.propagated} similar transaction${data.propagated === 1 ? "" : "s"}`
      : "Category updated"
  );
  refresh();
}

// Builds the query params shared by both the on-screen transaction list and
// the PDF export, so what you see is what you get.
function buildTransactionParams(month) {
  const params = new URLSearchParams();
  const search = searchBox.value.trim();
  const dateFrom = filterDateFrom.value;
  const dateTo = filterDateTo.value;

  if (search) {
    params.set("search", search);
  } else if (dateFrom || dateTo) {
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
  } else if (month !== "all") {
    params.set("month", month);
  }
  if (categoryFilter.value) params.set("category_id", categoryFilter.value);
  if (filterAccount.value) params.set("account_id", filterAccount.value);
  return params;
}

// Type (deposit/withdrawal) and min/max amount are applied client-side after
// fetch rather than in SQL - Plaid stores withdrawals positive and deposits
// negative, so a clean "amount over $X regardless of direction" filter is
// simpler and more robust done here than as a sign-aware Postgres query.
function applyClientFilters(rows) {
  const type = filterType.value;
  const min = parseFloat(filterMinAmount.value);
  const max = parseFloat(filterMaxAmount.value);

  return rows.filter((t) => {
    if (type === "withdrawal" && t.amount <= 0) return false;
    if (type === "deposit" && t.amount >= 0) return false;
    const abs = Math.abs(t.amount);
    if (!isNaN(min) && abs < min) return false;
    if (!isNaN(max) && abs > max) return false;
    return true;
  });
}

async function fetchFilteredTransactions(month) {
  const res = await fetch(`/api/transactions?${buildTransactionParams(month).toString()}`);
  const rows = await res.json();
  return applyClientFilters(rows);
}

function applySort(rows) {
  const [key, dir] = document.getElementById("txnSort").value.split("-");
  const sorted = [...rows].sort((a, b) => {
    const diff = key === "amount" ? Math.abs(a.amount) - Math.abs(b.amount) : new Date(a.date) - new Date(b.date);
    return dir === "asc" ? diff : -diff;
  });
  return sorted;
}

let selectedTxnIds = new Set();

function updateBulkToolbar() {
  const btn = document.getElementById("deleteSelectedBtn");
  btn.textContent = `Delete selected (${selectedTxnIds.size})`;
  btn.hidden = selectedTxnIds.size === 0;
  const selectAll = document.getElementById("selectAllTxns");
  const boxes = txnList.querySelectorAll(".txn-checkbox");
  selectAll.checked = boxes.length > 0 && [...boxes].every((b) => b.checked);
}

async function loadTransactions(month) {
  let rows = await fetchFilteredTransactions(month);
  rows = applySort(rows);
  txnList.innerHTML = "";
  selectedTxnIds = new Set();

  if (!rows.length) {
    const search = searchBox.value.trim();
    txnList.innerHTML = search
      ? `<p class="empty">No transactions match "${search}".</p>`
      : `<p class="empty">No transactions match the current filters.</p>`;
    updateBulkToolbar();
    return;
  }

  for (const t of rows) {
    const row = document.createElement("div");
    row.className = "txn-row";
    const sourceName = t.accounts?.name || "Unknown account";
    const displayName = t.custom_name || t.merchant_name || t.name;
    row.innerHTML = `
      <input type="checkbox" class="txn-checkbox" data-id="${t.id}" />
      <div class="txn-date">${t.date}</div>
      <div>
        <input type="text" class="txn-name-input" value="${escapeAttr(displayName)}" data-id="${t.id}" />
        <div class="txn-source">${sourceName}</div>
      </div>
      <div class="txn-amount">${fmtTxnAmount(t.amount)}</div>
      <select data-id="${t.id}" style="border-left: 4px solid ${categoryColor(t.categories?.name)};">
        <option value="">- uncategorized -</option>
        ${categoryOptionsHtml(t.category_id)}
        <option value="${NEW_CATEGORY_VALUE}">+ New category...</option>
      </select>
    `;

    row.querySelector(".txn-checkbox").addEventListener("change", (e) => {
      if (e.target.checked) selectedTxnIds.add(t.id);
      else selectedTxnIds.delete(t.id);
      updateBulkToolbar();
    });

    row.querySelector(".txn-name-input").addEventListener("change", async (e) => {
      const newName = e.target.value.trim();
      await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: t.id, custom_name: newName }),
      });
      showStatus("Transaction renamed");
    });

    row.querySelector("select").addEventListener("change", async (e) => {
      if (e.target.value === NEW_CATEGORY_VALUE) {
        const name = prompt("New category name:");
        if (!name || !name.trim()) {
          e.target.value = t.category_id || "";
          return;
        }
        const isBudgetCategory = confirm(
          `Should "${name.trim()}" count toward your monthly budget?\n\nOK = yes, it's a normal spending category.\nCancel = no, it's income/Maaser/transfers/something that shouldn't count as spending.`
        );
        let monthly_budget = 0;
        if (isBudgetCategory) {
          const budgetInput = prompt(
            "Monthly budget for this category (you can change this later):",
            "0"
          );
          monthly_budget = parseFloat(budgetInput) || 0;
        }
        const newId = await createCategory({
          name: name.trim(),
          monthly_budget,
          exclude_from_budget: !isBudgetCategory,
        });
        await setTransactionCategory(t.id, newId);
        return;
      }
      await setTransactionCategory(t.id, e.target.value);
    });

    txnList.appendChild(row);
  }

  updateBulkToolbar();
}

document.getElementById("selectAllTxns").addEventListener("change", (e) => {
  const boxes = txnList.querySelectorAll(".txn-checkbox");
  boxes.forEach((b) => {
    b.checked = e.target.checked;
    if (e.target.checked) selectedTxnIds.add(b.dataset.id);
    else selectedTxnIds.delete(b.dataset.id);
  });
  updateBulkToolbar();
});

document.getElementById("deleteSelectedBtn").addEventListener("click", async () => {
  const count = selectedTxnIds.size;
  if (!count) return;
  if (
    !confirm(
      `Permanently delete ${count} selected transaction${count === 1 ? "" : "s"}? This cannot be undone.`
    )
  ) {
    return;
  }
  const res = await fetch("/api/delete-transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [...selectedTxnIds] }),
  });
  const data = await res.json();
  if (!res.ok) {
    showStatus(`Delete failed: ${data.error}`, 6000);
    return;
  }
  showStatus(`Deleted ${data.deleted} transaction${data.deleted === 1 ? "" : "s"}`);
  refresh();
});

async function loadRecentActions() {
  const res = await fetch("/api/undo");
  const rows = await res.json();
  const list = document.getElementById("recentActionsList");

  if (!rows.length) {
    list.innerHTML = `<p class="empty">No actions logged yet.</p>`;
    return;
  }

  list.innerHTML = rows
    .map((r) => {
      const time = new Date(r.created_at).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      return `
    <div class="action-log-row">
      <span>${escapeAttr(r.description)}</span>
      <span class="action-time">${time}</span>
      <button type="button" class="undo-btn" data-id="${r.id}" ${r.undone ? "disabled" : ""}>
        ${r.undone ? "Undone" : "Undo"}
      </button>
    </div>`;
    })
    .join("");

  list.querySelectorAll(".undo-btn:not(:disabled)").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.dataset.id;
      if (!confirm("Undo this action? This restores the prior state for everything it affected.")) {
        return;
      }
      const res = await fetch("/api/undo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) {
        showStatus(`Undo failed: ${data.error}`, 6000);
        return;
      }
      showStatus(`Undone - restored ${data.restored} transaction${data.restored === 1 ? "" : "s"}`);
      refresh();
    });
  });
}

let trendsChartInstance = null;

async function loadTrends() {
  const dateFrom = document.getElementById("trendsDateFrom").value;
  const dateTo = document.getElementById("trendsDateTo").value;
  const params = new URLSearchParams();
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);

  const res = await fetch(`/api/monthly-trends?${params.toString()}`);
  const { months, averages } = await res.json();

  const statsEl = document.getElementById("trendsStats");
  if (!months.length) {
    statsEl.innerHTML = `<p class="empty">No transaction history in this range.</p>`;
    document.getElementById("trendsChart").getContext("2d").clearRect(0, 0, 9999, 9999);
    return;
  }

  const last = months[months.length - 1];
  const prev = months.length > 1 ? months[months.length - 2] : null;

  function deltaHtml(current, previous) {
    if (previous === null || previous === 0) return "";
    const pct = ((current - previous) / Math.abs(previous)) * 100;
    const sign = pct >= 0 ? "+" : "";
    return `<div class="delta">${sign}${pct.toFixed(0)}% vs previous month</div>`;
  }

  statsEl.innerHTML = `
    <div class="trends-stat">
      <span class="label">Avg income/mo</span>
      <span class="value">${fmt(averages.income)}</span>
    </div>
    <div class="trends-stat">
      <span class="label">Avg spending/mo</span>
      <span class="value">${fmt(averages.spending)}</span>
    </div>
    <div class="trends-stat">
      <span class="label">Avg net/mo</span>
      <span class="value ${averages.net >= 0 ? "under" : "over"}">${fmt(averages.net)}</span>
    </div>
    <div class="trends-stat">
      <span class="label">${monthName(last.month)} income</span>
      <span class="value">${fmt(last.income)}</span>
      ${prev ? deltaHtml(last.income, prev.income) : ""}
    </div>
    <div class="trends-stat">
      <span class="label">${monthName(last.month)} spending</span>
      <span class="value">${fmt(last.spending)}</span>
      ${prev ? deltaHtml(last.spending, prev.spending) : ""}
    </div>
  `;

  const ctx = document.getElementById("trendsChart").getContext("2d");
  if (trendsChartInstance) trendsChartInstance.destroy();
  trendsChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: months.map((m) => monthName(m.month)),
      datasets: [
        { label: "Income", data: months.map((m) => m.income), backgroundColor: "#2F6B4F" },
        { label: "Spending", data: months.map((m) => m.spending), backgroundColor: "#B3492D" },
      ],
    },
    options: {
      plugins: { legend: { position: "top", labels: { font: { family: "Inter" } } } },
      scales: {
        x: { ticks: { font: { family: "Inter" }, maxRotation: 45, minRotation: 45 } },
        y: { ticks: { callback: (v) => fmt(v) } },
      },
    },
  });
}

document.getElementById("trendsDateFrom").addEventListener("change", loadTrends);
document.getElementById("trendsDateTo").addEventListener("change", loadTrends);
document.getElementById("clearTrendsRange").addEventListener("click", () => {
  document.getElementById("trendsDateFrom").value = "";
  document.getElementById("trendsDateTo").value = "";
  loadTrends();
});

async function loadPendingMatches() {
  const res = await fetch("/api/suggested-matches");
  const rows = await res.json();
  const list = document.getElementById("pendingMatchesList");
  const countBadge = document.getElementById("pendingMatchesCount");

  if (rows.length) {
    countBadge.textContent = rows.length;
    countBadge.hidden = false;
  } else {
    countBadge.hidden = true;
  }

  if (!rows.length) {
    list.innerHTML = `<p class="empty">No pending matches right now.</p>`;
    return;
  }

  function txnLine(t) {
    if (!t) return `<div class="match-txn">(transaction not found)</div>`;
    const name = t.custom_name || t.merchant_name || t.name;
    return `
      <div class="match-txn">
        <div class="txn-line1">${escapeAttr(name)}</div>
        <div class="txn-line2">${t.date} · ${fmt(t.amount)}</div>
      </div>`;
  }

  list.innerHTML = rows
    .map(
      (r) => `
    <div class="match-row" data-id="${r.id}">
      <div class="match-reason">${r.match_type === "refund" ? "Possible refund" : "Possible transfer"} - ${escapeAttr(r.reason)} - would move to "${r.categories?.name || "?"}"</div>
      <div class="match-txns">
        ${txnLine(r.txn_a)}
        ${txnLine(r.txn_b)}
      </div>
      <div class="match-actions">
        <button type="button" class="match-accept" data-id="${r.id}">Accept</button>
        <button type="button" class="match-reject" data-id="${r.id}">Reject</button>
      </div>
    </div>`
    )
    .join("");

  list.querySelectorAll(".match-accept, .match-reject").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.dataset.id;
      const action = e.target.classList.contains("match-accept") ? "accept" : "reject";
      await fetch("/api/suggested-matches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      showStatus(action === "accept" ? "Match accepted" : "Match rejected");
      refresh();
    });
  });
}

async function loadUncategorizedBadge() {
  const res = await fetch("/api/uncategorized-count");
  const { count } = await res.json();
  const badge = document.getElementById("uncategorizedBadge");
  if (count > 0) {
    badge.textContent = `${count} uncategorized`;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

document.getElementById("uncategorizedBadge").addEventListener("click", () => {
  monthPicker.value = "all";
  categoryFilter.value = "unassigned";
  refresh();
  document.querySelector(".transactions").scrollIntoView({ behavior: "smooth", block: "start" });
});

async function refresh() {
  const month = monthPicker.value;
  monthLabel.textContent = monthName(month);
  await loadCategories();
  await loadAccounts();
  await loadConnectedAccounts();
  await loadSummary(month);
  await loadTransactions(month);
  await loadUncategorizedBadge();
  await loadPendingMatches();
  if (isTabActive("averages")) loadInsights();
  if (isTabActive("history")) loadRecentActions();
  if (isTabActive("trends")) loadTrends();
}

monthPicker.addEventListener("change", refresh);
categoryFilter.addEventListener("change", onFilterChange);
clearFilterBtn.addEventListener("click", () => {
  categoryFilter.value = "";
  onFilterChange();
});

let searchDebounce;
searchBox.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => loadTransactions(monthPicker.value), 300);
});

[filterDateFrom, filterDateTo, filterType, filterAccount].forEach((el) =>
  el.addEventListener("change", () => loadTransactions(monthPicker.value))
);

document.getElementById("txnSort").addEventListener("change", () => loadTransactions(monthPicker.value));

let amountDebounce;
[filterMinAmount, filterMaxAmount].forEach((el) =>
  el.addEventListener("input", () => {
    clearTimeout(amountDebounce);
    amountDebounce = setTimeout(() => loadTransactions(monthPicker.value), 300);
  })
);

document.getElementById("clearAdvancedFilters").addEventListener("click", () => {
  filterDateFrom.value = "";
  filterDateTo.value = "";
  filterType.value = "";
  filterMinAmount.value = "";
  filterMaxAmount.value = "";
  filterAccount.value = "";
  loadTransactions(monthPicker.value);
});

document.getElementById("addCategoryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("newCatName").value.trim();
  const monthly_budget = parseFloat(document.getElementById("newCatBudget").value) || 0;
  const exclude_from_budget = document.getElementById("newCatExclude").checked;
  if (!name) return;
  await createCategory({ name, monthly_budget, exclude_from_budget });
  document.getElementById("newCatName").value = "";
  document.getElementById("newCatBudget").value = "";
  document.getElementById("newCatExclude").checked = false;
  showStatus(`Added category "${name}"`);
  refresh(); // repopulates every dropdown already on screen, not just the manage panel
});

async function runFullSync() {
  let totalAdded = 0,
    totalModified = 0,
    hasMore = true,
    rounds = 0;

  while (hasMore && rounds < 30) {
    rounds++;
    showStatus(`Syncing... (${totalAdded} transactions so far)`, 60000);
    const res = await fetch("/api/sync-transactions", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Sync failed");
    totalAdded += data.added;
    totalModified += data.modified;
    hasMore = data.hasMore;
  }
  return { totalAdded, totalModified };
}

async function runAiCategorize() {
  let totalCategorized = 0,
    hasMore = true,
    rounds = 0,
    allNewCategories = new Set();

  while (hasMore && rounds < 60) {
    rounds++;
    showStatus(`AI categorizing... (${totalCategorized} done)`, 60000);
    const res = await fetch("/api/categorize-ai", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "AI categorization failed");
    totalCategorized += data.categorized;
    hasMore = data.hasMore;
    (data.newCategories || []).forEach((n) => allNewCategories.add(n));
  }

  return { totalCategorized, newCategories: [...allNewCategories] };
}

async function runMatchers() {
  const [refundRes, transferRes] = await Promise.all([
    fetch("/api/find-refunds", { method: "POST" }),
    fetch("/api/find-transfers", { method: "POST" }),
  ]);
  const refundData = await refundRes.json();
  const transferData = await transferRes.json();
  return {
    marked: (refundData.marked || 0) + (transferData.marked || 0),
    suggested: (refundData.suggested || 0) + (transferData.suggested || 0),
  };
}

document.getElementById("findRefundsBtn").addEventListener("click", async () => {
  showStatus("Looking for refunded purchases...", 15000);
  const res = await fetch("/api/find-refunds", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    showStatus(`Failed: ${data.error}`, 6000);
    return;
  }
  const parts = [];
  if (data.marked) parts.push(`excluded ${data.marked}`);
  if (data.suggested) parts.push(`${data.suggested} pending review`);
  showStatus(parts.length ? `Refunded purchases: ${parts.join(", ")}` : "No new refunded purchases found");
  refresh();
});

document.getElementById("findTransfersBtn").addEventListener("click", async () => {
  showStatus("Looking for internal transfers...", 15000);
  const res = await fetch("/api/find-transfers", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    showStatus(`Failed: ${data.error}`, 6000);
    return;
  }
  const parts = [];
  if (data.marked) parts.push(`excluded ${data.marked}`);
  if (data.suggested) parts.push(`${data.suggested} pending review`);
  showStatus(parts.length ? `Internal transfers: ${parts.join(", ")}` : "No new internal transfers found");
  refresh();
});

document.getElementById("syncBtn").addEventListener("click", async () => {
  try {
    const { totalAdded, totalModified } = await runFullSync();
    const { marked, suggested } = await runMatchers();
    let msg = `Synced - ${totalAdded} new, ${totalModified} updated`;
    if (marked) msg += `, ${marked} transfer/refund${marked === 1 ? "" : "s"} auto-excluded`;
    if (suggested) msg += `, ${suggested} pending your review`;
    showStatus(msg, 6000);
    refresh();
  } catch (err) {
    showStatus(`Sync failed: ${err.message}`, 6000);
  }
});

document.getElementById("aiCategorizeBtn").addEventListener("click", async () => {
  try {
    const { totalCategorized, newCategories } = await runAiCategorize();
    const newCatMsg = newCategories.length
      ? ` (created: ${newCategories.join(", ")})`
      : "";
    showStatus(
      `AI categorized ${totalCategorized} transaction${totalCategorized === 1 ? "" : "s"}${newCatMsg}`,
      6000
    );
    refresh();
  } catch (err) {
    showStatus(`AI categorization failed: ${err.message}`, 6000);
  }
});

document.getElementById("connectBtn").addEventListener("click", async () => {
  const res = await fetch("/api/create-link-token", { method: "POST" });
  const { link_token } = await res.json();
  const handler = Plaid.create({
    token: link_token,
    onSuccess: async (public_token) => {
      showStatus("Linking account...");
      await fetch("/api/exchange-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ public_token }),
      });
      showStatus("Bank connected - syncing now...", 60000);
      const { totalAdded } = await runFullSync();
      await runMatchers();
      showStatus(`Connected - pulled ${totalAdded} transactions`);
      refresh();
    },
  });
  handler.open();
});

setupTabGroups();
populateMonthPicker().then(refresh);

async function exportPdf() {
  showStatus("Generating PDF...", 10000);
  const month = monthPicker.value;
  const search = searchBox.value.trim();
  const filterCat = categories.find((c) => c.id === categoryFilter.value);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(18);
  doc.text("Household Ledger", 14, 18);
  doc.setFontSize(11);
  doc.setTextColor(100);
  let subtitle = monthName(month);
  if (search) subtitle = `Search: "${search}" (all time)`;
  else if (filterDateFrom.value || filterDateTo.value) {
    subtitle = `${filterDateFrom.value || "..."} to ${filterDateTo.value || "..."}`;
  }
  if (filterCat) subtitle += ` - ${filterCat.name} only`;
  doc.text(subtitle, 14, 25);

  // Budget vs. actual (always reflects the selected month, regardless of
  // any other filter applied to the transaction list below) - skipped for
  // "All transactions" since budget caps are inherently monthly
  let nextY = 32;
  if (month !== "all") {
    const summaryRes = await fetch(`/api/summary?month=${month}`);
    const { summary } = await summaryRes.json();
    doc.autoTable({
      startY: 32,
      head: [["Category", "Budget", "Actual", "Difference"]],
      body: summary.map((c) => {
        const diff = c.budget - c.actual;
        return [
          c.name,
          fmt(c.budget),
          fmt(c.actual),
          diff >= 0 ? `${fmt(diff)} under` : `${fmt(-diff)} over`,
        ];
      }),
      theme: "striped",
      headStyles: { fillColor: [27, 42, 74] },
      styles: { fontSize: 9 },
    });
    nextY = doc.lastAutoTable.finalY + 10;
  }

  // Transaction list - respects every active filter (search, category,
  // date range, account, type, amount range)
  const txns = await fetchFilteredTransactions(month);

  doc.autoTable({
    startY: nextY,
    head: [["Date", "Description", "Category", "Account", "Amount"]],
    body: txns.map((t) => {
      const isDeposit = t.amount < 0;
      const amountStr = `${isDeposit ? "+" : "-"}${fmt(Math.abs(t.amount))}`;
      return [
        t.date,
        t.custom_name || t.merchant_name || t.name,
        t.categories?.name || "Uncategorized",
        t.accounts?.name || "",
        amountStr,
      ];
    }),
    theme: "striped",
    headStyles: { fillColor: [27, 42, 74] },
    styles: { fontSize: 8 },
  });

  const filenamePart = search ? "search" : filterCat ? filterCat.name.replace(/\s+/g, "-") : month;
  doc.save(`ledger-${filenamePart}.pdf`);
  showStatus("PDF downloaded");
}

document.getElementById("exportPdfBtn").addEventListener("click", () => {
  exportPdf().catch((err) => showStatus(`Export failed: ${err.message}`, 6000));
});

// ---------- CSV Import (bank/credit card statements) ----------

const csvAccountSelect = document.getElementById("csvAccountSelect");
const csvFileInput = document.getElementById("csvFileInput");
const csvMappingArea = document.getElementById("csvMappingArea");
const csvDateCol = document.getElementById("csvDateCol");
const csvDescCol = document.getElementById("csvDescCol");
const csvAmountMode = document.getElementById("csvAmountMode");
const csvAmountCol = document.getElementById("csvAmountCol");
const csvFlipSign = document.getElementById("csvFlipSign");
const csvAmountSingleWrap = document.getElementById("csvAmountSingleWrap");
const csvFlipWrap = document.getElementById("csvFlipWrap");
const csvWithdrawalCol = document.getElementById("csvWithdrawalCol");
const csvDepositCol = document.getElementById("csvDepositCol");
const csvWithdrawalWrap = document.getElementById("csvWithdrawalWrap");
const csvDepositWrap = document.getElementById("csvDepositWrap");
const csvImportBtn = document.getElementById("csvImportBtn");

let csvRows = [];
let csvHeaders = [];

if (csvFileInput) {
  csvFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        csvRows = results.data;
        csvHeaders = results.meta.fields || [];
        populateCsvMapping();
      },
      error: (err) => showStatus(`Couldn't read CSV: ${err.message}`, 6000),
    });
  });
}

function populateCsvMapping() {
  const dateGuess = guessColumn(csvHeaders, ["date", "transactiondate", "postingdate"]);
  const descGuess = guessColumn(csvHeaders, ["description", "name", "merchant", "payee"]);
  const amountGuess = guessColumn(csvHeaders, ["amount", "debit", "total"]);
  const withdrawalGuess = guessColumn(csvHeaders, ["withdrawal", "withdrawals", "debit", "debitamount"]);
  const depositGuess = guessColumn(csvHeaders, ["deposit", "deposits", "credit", "creditamount"]);

  const opts = (selected) =>
    `<option value="">-- none --</option>` +
    csvHeaders
      .map((h) => `<option value="${escapeAttr(h)}" ${h === selected ? "selected" : ""}>${escapeAttr(h)}</option>`)
      .join("");

  csvDateCol.innerHTML = opts(dateGuess);
  csvDescCol.innerHTML = opts(descGuess);
  csvAmountCol.innerHTML = opts(amountGuess);
  csvWithdrawalCol.innerHTML = opts(withdrawalGuess);
  csvDepositCol.innerHTML = opts(depositGuess);
  csvAccountSelect.innerHTML = accounts
    .map((a) => `<option value="${a.id}">${a.name}${a.mask ? ` (...${a.mask})` : ""}</option>`)
    .join("");

  csvAmountMode.value = withdrawalGuess && depositGuess ? "split" : "single";
  updateCsvAmountModeUI();
  csvMappingArea.hidden = false;
}

function updateCsvAmountModeUI() {
  const isSplit = csvAmountMode.value === "split";
  csvAmountSingleWrap.hidden = isSplit;
  csvFlipWrap.hidden = isSplit;
  csvWithdrawalWrap.hidden = !isSplit;
  csvDepositWrap.hidden = !isSplit;
}

if (csvAmountMode) {
  csvAmountMode.addEventListener("change", updateCsvAmountModeUI);
}

function parseAmountCell(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return 0;
  return parseFloat(String(raw).replace(/[^0-9.-]/g, "")) || 0;
}

if (csvImportBtn) {
  csvImportBtn.addEventListener("click", async () => {
    const dateCol = csvDateCol.value;
    const descCol = csvDescCol.value;
    const accountId = csvAccountSelect.value;
    const isSplit = csvAmountMode.value === "split";

    if (!dateCol || !descCol) {
      showStatus("Please map date and description columns", 5000);
      return;
    }
    if (!accountId) {
      showStatus("Please choose an account first", 5000);
      return;
    }
    if (isSplit && !csvWithdrawalCol.value && !csvDepositCol.value) {
      showStatus("Please map at least one of withdrawal or deposit column", 5000);
      return;
    }
    if (!isSplit && !csvAmountCol.value) {
      showStatus("Please map the amount column", 5000);
      return;
    }

    const rows = csvRows
      .map((row) => {
        const d = new Date(row[dateCol]);
        if (isNaN(d)) return null;
        const date = d.toISOString().slice(0, 10);

        let amount;
        if (isSplit) {
          const withdrawal = csvWithdrawalCol.value ? parseAmountCell(row[csvWithdrawalCol.value]) : 0;
          const deposit = csvDepositCol.value ? parseAmountCell(row[csvDepositCol.value]) : 0;
          amount = withdrawal !== 0 ? Math.abs(withdrawal) : -Math.abs(deposit);
        } else {
          amount = parseAmountCell(row[csvAmountCol.value]);
          if (csvFlipSign.checked) amount = -amount;
        }

        if (amount === 0) return null;
        return { date, name: row[descCol], amount };
      })
      .filter(Boolean);

    if (!rows.length) {
      showStatus("No valid rows found with that column mapping", 5000);
      return;
    }

    showStatus(`Importing ${rows.length} transactions...`, 20000);
    const res = await fetch("/api/import-csv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: accountId, rows }),
    });
    const data = await res.json();
    if (!res.ok) {
      showStatus(`Import failed: ${data.error}`, 6000);
      return;
    }
    showStatus(
      data.skipped
        ? `Imported ${data.imported} - skipped ${data.skipped} already covered by bank sync`
        : `Imported ${data.imported} transactions`,
      8000
    );
    csvMappingArea.hidden = true;
    csvFileInput.value = "";
    refresh();
  });
}
