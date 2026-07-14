const monthLabel = document.getElementById("monthLabel");
const monthPicker = document.getElementById("monthPicker");
const categoryFilter = document.getElementById("categoryFilter");
const clearFilterBtn = document.getElementById("clearFilterBtn");
const searchBox = document.getElementById("searchBox");
const summaryList = document.getElementById("summaryList");
const txnList = document.getElementById("txnList");
const statusBar = document.getElementById("statusBar");
const categoryManageList = document.getElementById("categoryManageList");

let categories = [];
const NEW_CATEGORY_VALUE = "__new__";

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function fmt(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
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

function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

async function loadTransactions(month) {
  const params = new URLSearchParams();
  const search = searchBox.value.trim();
  if (search) {
    params.set("search", search);
  } else {
    params.set("month", month);
  }
  if (categoryFilter.value) params.set("category_id", categoryFilter.value);

  const res = await fetch(`/api/transactions?${params.toString()}`);
  const rows = await res.json();
  txnList.innerHTML = "";

  if (!rows.length) {
    txnList.innerHTML = search
      ? `<p class="empty">No transactions match "${search}".</p>`
      : `<p class="empty">No transactions match this view yet.</p>`;
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
  if (search) subtitle = `Search: "${search}" (all months)`;
  else if (filterCat) subtitle += ` - ${filterCat.name} only`;
  doc.text(subtitle, 14, 25);

  // Budget vs. actual (always reflects the selected month, regardless of
  // any search/category filter applied to the transaction list below)
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

  // Transaction list - respects whatever filter/search is currently active
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  else params.set("month", month);
  if (categoryFilter.value) params.set("category_id", categoryFilter.value);

  const txnRes = await fetch(`/api/transactions?${params.toString()}`);
  const txns = await txnRes.json();

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
