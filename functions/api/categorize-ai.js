import { json, sb, anthropic, logAction } from "../_utils.js";

// Processes a bounded batch of unassigned transactions per call (frontend
// loops until caught up), using Claude Haiku to pick the best-fitting
// existing category for each transaction - or propose a brand-new one if
// nothing fits. Never touches transactions that already have a category.
const BATCH_SIZE = 15;
const MAX_NEW_CATEGORIES_PER_RUN = 10; // safety cap against a bad response spawning junk

// Salvages whatever complete "id": "category" entries exist in a JSON object
// that got cut off mid-string, instead of discarding the whole batch.
function repairTruncatedMapping(raw) {
  let text = raw.replace(/```json|```/g, "").trim();
  const start = text.indexOf("{");
  if (start === -1) return null;
  text = text.slice(start);

  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ",") {
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
    // Prefer custom_name (e.g. an actual item title from the Amazon import)
    // over the generic merchant name when available - "USB Cable" gives the
    // model far more to work with than "Amazon". plaid_category is the
    // bank's own merchant-categorization engine (e.g. "FOOD_AND_DRINK_FAST_
    // FOOD") when Plaid provided one at sync time - a strong extra hint for
    // well-known chains the model might not otherwise recognize.
    const txnList = unassigned
      .map((t) => {
        const desc = t.custom_name || t.merchant_name || t.name;
        const hint = t.plaid_category ? `|bank category hint: ${t.plaid_category}` : "";
        return `${t.id}|${desc}|$${t.amount}${hint}`;
      })
      .join("\n");

    const prompt = `Existing categories (prefer these, use the EXACT string if you use one): ${categoryList}

For each transaction below (format: id|merchant or description|amount|optional bank category hint), pick the best-fitting category.
- If an existing category fits reasonably well, use it - copy its name exactly as written above.
- The bank category hint (when present) is the bank's own categorization for that merchant - a strong signal, especially for well-known chains. Use it to inform your choice, but still map it to the closest fitting category from the list above rather than copying its wording.
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
    const loggedTxns = [];
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
      // Every transaction in `unassigned` was fetched with category_source
      // = 'unassigned' and category_id = null, so that's always the prior
      // state to restore on undo.
      loggedTxns.push({ id: t.id, prior_category_id: null, prior_category_source: "unassigned" });
      categorized++;
    }

    if (rows.length) {
      await sb(env, "transactions?on_conflict=plaid_transaction_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: rows,
      });
      await logAction(
        env,
        "ai_categorize",
        `AI categorized ${rows.length} transaction${rows.length === 1 ? "" : "s"}`,
        { transactions: loggedTxns }
      );

      // If a merchant now has 2+ CONSISTENT AI categorizations (same
      // category every time), promote that to a keyword rule so future
      // syncs of the same merchant are instantly auto-categorized instead
      // of piling up as unassigned until the next AI run. Only promotes
      // when consistent - a merchant AI has categorized differently across
      // runs is left alone rather than locking in a guess.
      const distinctMerchants = [...new Set(rows.map((r) => r.merchant_name).filter(Boolean))];
      for (const merchant of distinctMerchants) {
        const priorAi = await sb(
          env,
          `transactions?merchant_name=eq.${encodeURIComponent(merchant)}&category_source=eq.ai&select=category_id`
        );
        const catIds = new Set(priorAi.map((t) => t.category_id));
        if (catIds.size === 1 && priorAi.length >= 2) {
          const category_id = [...catIds][0];
          const existingRule = await sb(
            env,
            `category_rules?keyword=eq.${encodeURIComponent(merchant)}`
          );
          if (existingRule.length) {
            await sb(env, `category_rules?id=eq.${existingRule[0].id}`, {
              method: "PATCH",
              body: { category_id },
            });
          } else {
            await sb(env, "category_rules", {
              method: "POST",
              body: { keyword: merchant, category_id },
            });
          }
        }
      }
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
