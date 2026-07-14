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
const chartDetails = document.getElementById("chartDetails");

let categories = [];
let accounts = [];
let spendingChartInstance = null;
const NEW_CATEGORY_VALUE = "__new__";

const CHART_PALETTE = [
  "#1B2A4A", "#2F6B4F", "#B3492D", "#8A7B4F", "#5B6B85",
  "#6B8F71", "#C97B4A", "#4A6FA5", "#A0785A", "#3E7C7C",
  "#7A5C8E", "#9A8B4F",
];

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
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function populateMonthPicker() {
  const now = new Date();
  monthPicker.innerHTML = "";
  for (let i = 0; i < 6; i++) {
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
      .map((a) => `<option value="${a.id}">${a.name}${a.mask ? ` (...${a.mask})` : ""}</option>`)
      .join("");
  filterAccount.value = current || "";
}

async function loadSummary(month) {
  const res = await fetch(`/api/summary?month=${month}`);
  const { summary } = await res.json();
  summaryList.innerHTML = "";

  if (!summary.length) {
    summaryList.innerHTML = `<p class="empty">No categories yet - run schema.sql in Supabase.</p>`;
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
      <div class="cat-name">${c.name} ${c.is_fixed ? '<span class="badge">FIXED</span>' : ""}</div>
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

  if (chartDetails.open) renderSpendingChart(summary);
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
  categoryManageList.innerHTML = sortedCategoriesAlpha()
    .map(
      (c) => `
    <div class="manage-row">
      <input type="text" value="${escapeAttr(c.name)}" data-id="${c.id}" class="name-input" />
      <label class="checkbox-label manage-checkbox">
        <input type="checkbox" data-id="${c.id}" class="exclude-input" ${c.exclude_from_budget ? "checked" : ""} />
        Not in budget
      </label>
      <input type="number" step="0.01" min="0" value="${c.monthly_budget}" data-id="${c.id}" class="budget-input" ${c.exclude_from_budget ? "disabled" : ""} />
      ${c.is_fixed ? '<span class="badge">FIXED</span>' : "<span></span>"}
      <button type="button" class="delete-cat-btn" data-id="${c.id}" data-name="${escapeAttr(c.name)}" title="Delete category">×</button>
    </div>`
    )
    .join("");

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
  const res = await fetch("/api/transactions", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: txnId, category_id: categoryId || null }),
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
  } else {
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

async function loadTransactions(month) {
  const rows = await fetchFilteredTransactions(month);
  txnList.innerHTML = "";

  if (!rows.length) {
    const search = searchBox.value.trim();
    txnList.innerHTML = search
      ? `<p class="empty">No transactions match "${search}".</p>`
      : `<p class="empty">No transactions match the current filters.</p>`;
    return;
  }

  for (const t of rows) {
    const row = document.createElement("div");
    row.className = "txn-row";
    const sourceName = t.accounts?.name || "Unknown account";
    const displayName = t.custom_name || t.merchant_name || t.name;
    row.innerHTML = `
      <div class="txn-date">${t.date}</div>
      <div>
        <input type="text" class="txn-name-input" value="${escapeAttr(displayName)}" data-id="${t.id}" />
        <div class="txn-source">${sourceName}</div>
      </div>
      <div class="txn-amount">${fmtTxnAmount(t.amount)}</div>
      <select data-id="${t.id}">
        <option value="">- uncategorized -</option>
        ${categoryOptionsHtml(t.category_id)}
        <option value="${NEW_CATEGORY_VALUE}">+ New category...</option>
      </select>
    `;

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
}

async function refresh() {
  const month = monthPicker.value;
  monthLabel.textContent = monthName(month);
  await loadCategories();
  await loadAccounts();
  await loadConnectedAccounts();
  await loadSummary(month);
  await loadTransactions(month);
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

chartDetails.addEventListener("toggle", () => {
  if (chartDetails.open) loadSummary(monthPicker.value);
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

  while (hasMore && rounds < 15) {
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

document.getElementById("syncBtn").addEventListener("click", async () => {
  try {
    const { totalAdded, totalModified } = await runFullSync();
    showStatus(`Synced - ${totalAdded} new, ${totalModified} updated`);
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
      showStatus(`Connected - pulled ${totalAdded} transactions`);
      refresh();
    },
  });
  handler.open();
});

populateMonthPicker();
refresh();

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
  // any other filter applied to the transaction list below)
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

  // Transaction list - respects every active filter (search, category,
  // date range, account, type, amount range)
  const txns = await fetchFilteredTransactions(month);

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 10,
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
