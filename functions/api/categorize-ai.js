import { json, sb, anthropic } from "../_utils.js";

// Processes a bounded batch of unassigned transactions per call (frontend
// loops until caught up), using Claude Haiku to pick the best-fitting
// existing category for each transaction - or propose a brand-new one if
// nothing fits. Never touches transactions that already have a category.
const BATCH_SIZE = 15;
const MAX_NEW_CATEGORIES_PER_RUN = 5; // safety cap against a bad response spawning junk

// Salvages whatever complete "id": "category" entries exist in a JSON object
// that got cut off mid-string, instead of discarding the whole batch.
function repairTruncatedMapping(raw) {
  let text = raw.replace(/```json|```/g, "").trim();
  const start = text.indexOf("{");
  if (start === -1) return null;
  text = text.slice(start);

  // Walk backwards to the last comma that sits between two complete entries
  // (i.e. followed by a quote, meaning what came before it was a full pair).
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === "," ) {
      const candidate = text.slice(0, i) + "}";
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function onRequestPost({ env }) {
  try {
    let categories = await sb(env, "categories?select=id,name&order=sort_order.asc");
    const unassigned = await sb(
      env,
      `transactions?category_source=eq.unassigned&select=*&order=date.desc&limit=${BATCH_SIZE}`
    );

    if (!unassigned.length) {
      return json({ categorized: 0, hasMore: false, newCategories: [] });
    }

    const categoryList = categories.map((c) => c.name).join(", ");
    const txnList = unassigned
      .map((t) => `${t.id}|${t.merchant_name || t.name}|$${t.amount}`)
      .join("\n");

    const prompt = `Existing categories (prefer these, use the EXACT string if you use one): ${categoryList}

For each transaction below (format: id|merchant or description|amount), pick the best-fitting category.
- If an existing category fits reasonably well, use it - copy its name exactly as written above.
- Categories describe a TYPE of spending, never a specific brand, app, or merchant. "Eating Out" not "Dunkin", "Food Delivery" not "Uber Eats", "Insurance" not "Life Insurance", "Rideshare" not "Uber". Ask: would this category still make sense if the transaction were from a totally different company doing the same kind of thing? If not, it's too specific.
- If NONE of the existing categories fit, propose ONE short, general new category name for it (2-3 words, a broad spending type per the rule above). Only propose a new category when you're confident it represents a recurring type of spending, not a one-off. Reuse the same new category name for similar transactions in this batch rather than inventing near-duplicates.
- If truly nothing sensible fits, use "Uncategorized".

Transactions:
${txnList}

Respond with ONLY a single-line, compact JSON object mapping transaction id to category name - no pretty-printing, no line breaks, no extra whitespace, no markdown fences, no other text. Example: {"abc-123":"Groceries","def-456":"Pet Supplies"}`;

    const raw = await anthropic(
      env,
      "You are a precise personal-finance transaction categorizer. Respond with strict, compact, single-line JSON only - this saves output space, which matters.",
      prompt,
      2048
    );

    let mapping;
    let wasTruncated = false;
    try {
      mapping = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          mapping = JSON.parse(match[0]);
        } catch {
          mapping = null;
        }
      }
      if (!mapping) {
        mapping = repairTruncatedMapping(raw);
        wasTruncated = true;
      }
      if (!mapping) {
        throw new Error(
          `Could not parse or repair AI response (${raw.length} chars received): ${raw.slice(-200)}`
        );
      }
    }

    const normalize = (s) => (s || "").trim().toLowerCase();
    const nameToId = new Map(categories.map((c) => [normalize(c.name), c.id]));
    const newCategoryNames = new Set();

    const rows = [];
    let categorized = 0;

    for (const t of unassigned) {
      const catNameRaw = (mapping[t.id] || "").trim();
      if (!catNameRaw) continue;
      const key = normalize(catNameRaw);

      let category_id = nameToId.get(key);

      if (!category_id && catNameRaw !== "Uncategorized") {
        if (newCategoryNames.size >= MAX_NEW_CATEGORIES_PER_RUN) continue; // hit safety cap, skip

        const [created] = await sb(env, "categories", {
          method: "POST",
          prefer: "return=representation",
          body: { name: catNameRaw, monthly_budget: 0, is_fixed: false, sort_order: 60 },
        });
        category_id = created.id;
        nameToId.set(key, category_id);
        newCategoryNames.add(catNameRaw);
      }

      if (!category_id) continue; // "Uncategorized" or nothing usable

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

    // Always retry if the batch was full - either there's genuinely more
    // work, or this batch got truncated and needs reprocessing anyway.
    const hasMore = unassigned.length === BATCH_SIZE && (categorized > 0 || wasTruncated);

    return json({
      categorized,
      hasMore,
      newCategories: [...newCategoryNames],
      wasTruncated,
    });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
