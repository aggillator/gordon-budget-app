const monthLabel = document.getElementById("monthLabel");
const monthPicker = document.getElementById("monthPicker");
const categoryFilter = document.getElementById("categoryFilter");
const summaryList = document.getElementById("summaryList");
const txnList = document.getElementById("txnList");
const statusBar = document.getElementById("statusBar");
const categoryManageList = document.getElementById("categoryManageList");

let categories = [];

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function fmt(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
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
    const row = document.createElement("div");
    row.className = "cat-row";
    row.innerHTML = `
      <div class="cat-name">${c.name} ${c.is_fixed ? '<span class="badge">FIXED</span>' : ""}</div>
      <div class="cat-figures">
        <span class="${over ? "over" : "under"}">${fmt(c.actual)}</span> / ${fmt(c.budget)}
      </div>
      <div class="bar-track"><div class="bar-fill ${over ? "over" : "under"}" style="width:${pct}%"></div></div>
    `;
    summaryList.appendChild(row);
  }
}

function populateCategoryFilter() {
  const current = categoryFilter.value;
  categoryFilter.innerHTML =
    `<option value="">All categories</option><option value="unassigned">Unassigned</option>` +
    categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  categoryFilter.value = current || "";
}

function renderCategoryManage() {
  categoryManageList.innerHTML = categories
    .map(
      (c) => `
    <div class="manage-row">
      <span>${c.name} ${c.is_fixed ? '<span class="badge">FIXED</span>' : ""}</span>
      <input type="number" step="0.01" min="0" value="${c.monthly_budget}" data-id="${c.id}" class="budget-input" />
    </div>`
    )
    .join("");

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
}

async function loadCategories() {
  const res = await fetch("/api/categories");
  categories = await res.json();
  populateCategoryFilter();
  renderCategoryManage();
}

async function loadTransactions(month) {
  let url = `/api/transactions?month=${month}`;
  if (categoryFilter.value) url += `&category_id=${categoryFilter.value}`;

  const res = await fetch(url);
  const rows = await res.json();
  txnList.innerHTML = "";

  if (!rows.length) {
    txnList.innerHTML = `<p class="empty">No transactions match this view yet.</p>`;
    return;
  }

  for (const t of rows) {
    const row = document.createElement("div");
    row.className = "txn-row";
    const options = categories
      .map(
        (c) =>
          `<option value="${c.id}" ${c.id === t.category_id ? "selected" : ""}>${c.name}</option>`
      )
      .join("");
    const sourceName = t.accounts?.name || "Unknown account";
    row.innerHTML = `
      <div class="txn-date">${t.date}</div>
      <div>
        <div>${t.merchant_name || t.name}</div>
        <div class="txn-source">${sourceName}</div>
      </div>
      <div class="txn-amount">${fmt(t.amount)}</div>
      <select data-id="${t.id}">
        <option value="">- uncategorized -</option>
        ${options}
      </select>
    `;
    row.querySelector("select").addEventListener("change", async (e) => {
      const res = await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: t.id, category_id: e.target.value || null }),
      });
      const data = await res.json();
      showStatus(
        data.propagated
          ? `Category updated - applied to ${data.propagated} similar transaction${data.propagated === 1 ? "" : "s"}`
          : "Category updated"
      );
      refresh();
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
categoryFilter.addEventListener("change", () => loadTransactions(monthPicker.value));

document.getElementById("addCategoryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("newCatName").value.trim();
  const monthly_budget = parseFloat(document.getElementById("newCatBudget").value) || 0;
  if (!name) return;
  await fetch("/api/categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, monthly_budget }),
  });
  document.getElementById("newCatName").value = "";
  document.getElementById("newCatBudget").value = "";
  await loadCategories();
  loadSummary(monthPicker.value);
  showStatus(`Added category "${name}"`);
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
    rounds = 0;

  while (hasMore && rounds < 15) {
    rounds++;
    showStatus(`AI categorizing... (${totalCategorized} done)`, 60000);
    const res = await fetch("/api/categorize-ai", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "AI categorization failed");
    totalCategorized += data.categorized;
    hasMore = data.hasMore;
  }
  return totalCategorized;
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
    const total = await runAiCategorize();
    showStatus(`AI categorized ${total} transaction${total === 1 ? "" : "s"}`);
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
