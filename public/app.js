const monthLabel = document.getElementById("monthLabel");
const monthPicker = document.getElementById("monthPicker");
const summaryList = document.getElementById("summaryList");
const txnList = document.getElementById("txnList");
const statusBar = document.getElementById("statusBar");

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

async function loadCategories() {
  const res = await fetch("/api/categories");
  categories = await res.json();
}

async function loadTransactions(month) {
  const res = await fetch(`/api/transactions?month=${month}`);
  const rows = await res.json();
  txnList.innerHTML = "";

  if (!rows.length) {
    txnList.innerHTML = `<p class="empty">No transactions for this month yet. Connect a bank and hit Sync.</p>`;
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
    row.innerHTML = `
      <div class="txn-date">${t.date}</div>
      <div>${t.merchant_name || t.name}</div>
      <div class="txn-amount">${fmt(t.amount)}</div>
      <select data-id="${t.id}">
        <option value="">- uncategorized -</option>
        ${options}
      </select>
    `;
    row.querySelector("select").addEventListener("change", async (e) => {
      await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: t.id, category_id: e.target.value || null }),
      });
      loadSummary(monthPicker.value);
      showStatus("Category updated");
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

document.getElementById("syncBtn").addEventListener("click", async () => {
  try {
    const { totalAdded, totalModified } = await runFullSync();
    showStatus(`Synced - ${totalAdded} new, ${totalModified} updated`);
    refresh();
  } catch (err) {
    showStatus(`Sync failed: ${err.message}`, 6000);
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
