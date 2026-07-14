import { json, sb, anthropic } from "../_utils.js";

// Processes a bounded batch of unassigned transactions per call (frontend
// loops until caught up), using Claude Haiku to pick the best-fitting
// existing category for each. Never invents new categories, never touches
// transactions that already have a category (manual or otherwise).
const BATCH_SIZE = 60;

export async function onRequestPost({ env }) {
  try {
    const categories = await sb(env, "categories?select=id,name&order=sort_order.asc");
    const unassigned = await sb(
      env,
      `transactions?category_source=eq.unassigned&select=*&order=date.desc&limit=${BATCH_SIZE}`
    );

    if (!unassigned.length) {
      return json({ categorized: 0, hasMore: false });
    }

    const categoryList = categories.map((c) => c.name).join(", ");
    const txnList = unassigned
      .map((t) => `${t.id}|${t.merchant_name || t.name}|$${t.amount}`)
      .join("\n");

    const prompt = `Categories available: ${categoryList}

For each transaction below (format: id|merchant or description|amount), pick the single best-fitting category name from the list above. If genuinely nothing fits, use "Uncategorized".

Transactions:
${txnList}

Respond with ONLY a JSON object mapping transaction id to category name, no other text, no markdown fences. Example: {"abc-123": "Groceries", "def-456": "Gas"}`;

    const raw = await anthropic(
      env,
      "You are a precise personal-finance transaction categorizer. Respond with strict JSON only.",
      prompt,
      2000
    );

    const cleaned = raw.replace(/```json|```/g, "").trim();
    const mapping = JSON.parse(cleaned);

    const nameToId = Object.fromEntries(categories.map((c) => [c.name, c.id]));

    const rows = [];
    let categorized = 0;
    for (const t of unassigned) {
      const catName = mapping[t.id];
      const category_id = catName && nameToId[catName] ? nameToId[catName] : null;
      if (!category_id) continue; // leave genuinely unclear ones alone rather than guess
      rows.push({
        plaid_transaction_id: t.plaid_transaction_id,
        account_id: t.account_id,
        date: t.date,
        name: t.name,
        merchant_name: t.merchant_name,
        amount: t.amount,
        pending: t.pending,
        category_id,
        category_source: "ai",
      });
      categorized++;
    }

    if (rows.length) {
      await sb(env, "transactions?on_conflict=plaid_transaction_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: rows,
      });
    }

    return json({ categorized, hasMore: unassigned.length === BATCH_SIZE });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
