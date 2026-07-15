import { json, sb } from "../_utils.js";

// Matches a charge to its own refund on the SAME account (opposite sign,
// same amount, within 14 days) and excludes both from the budget - a
// refunded purchase shouldn't count as spend just because the charge and
// its reversal are two separate rows.
//
// Confident matches (3 days or less apart, no competing candidate) apply
// automatically. Anything less certain - further apart, or tied with
// another equally-good candidate - gets queued in suggested_matches
// instead of guessed, for review in the Pending Matches panel.
const AUTO_APPLY_DAYS = 3;
const SUGGEST_MAX_DAYS = 14;

export async function onRequestPost({ env }) {
  try {
    let cat = await sb(env, `categories?name=eq.Refunded Purchase&select=id`);
    let categoryId;
    if (cat.length) {
      categoryId = cat[0].id;
    } else {
      const [created] = await sb(env, "categories", {
        method: "POST",
        prefer: "return=representation",
        body: {
          name: "Refunded Purchase",
          monthly_budget: 0,
          is_fixed: false,
          exclude_from_budget: true,
          sort_order: 41,
        },
      });
      categoryId = created.id;
    }

    // Don't re-suggest transactions already waiting on a decision
    const pending = await sb(
      env,
      `suggested_matches?resolved=eq.false&select=transaction_id_a,transaction_id_b`
    );
    const alreadyPending = new Set();
    pending.forEach((p) => {
      alreadyPending.add(p.transaction_id_a);
      alreadyPending.add(p.transaction_id_b);
    });

    const txns = await sb(
      env,
      `transactions?select=id,account_id,date,amount&category_id=neq.${categoryId}&order=date.asc&limit=5000`
    );

    const byKey = {};
    for (const t of txns) {
      if (alreadyPending.has(t.id)) continue;
      const key = `${t.account_id}|${Math.abs(t.amount)}`;
      (byKey[key] ||= []).push(t);
    }

    const used = new Set();
    const toExclude = [];
    const suggestions = [];

    for (const group of Object.values(byKey)) {
      if (group.length < 2) continue;

      const candidatePairs = [];
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (Math.sign(a.amount) === Math.sign(b.amount)) continue;
          const diffDays = Math.abs(new Date(a.date) - new Date(b.date)) / 86400000;
          if (diffDays > SUGGEST_MAX_DAYS) continue;
          candidatePairs.push({ a, b, diffDays });
        }
      }
      candidatePairs.sort((x, y) => x.diffDays - y.diffDays);

      for (const pair of candidatePairs) {
        if (used.has(pair.a.id) || used.has(pair.b.id)) continue;

        const tie = candidatePairs.some(
          (p) =>
            p !== pair &&
            !used.has(p.a.id) &&
            !used.has(p.b.id) &&
            (p.a.id === pair.a.id || p.a.id === pair.b.id || p.b.id === pair.a.id || p.b.id === pair.b.id) &&
            p.diffDays === pair.diffDays
        );

        if (pair.diffDays <= AUTO_APPLY_DAYS && !tie) {
          toExclude.push(pair.a.id, pair.b.id);
        } else {
          suggestions.push({
            match_type: "refund",
            transaction_id_a: pair.a.id,
            transaction_id_b: pair.b.id,
            category_id: categoryId,
            reason: tie ? "multiple possible matches" : `${Math.round(pair.diffDays)} days apart`,
          });
        }
        used.add(pair.a.id);
        used.add(pair.b.id);
      }
    }

    if (toExclude.length) {
      await sb(env, `transactions?id=in.(${toExclude.join(",")})`, {
        method: "PATCH",
        body: { category_id: categoryId, category_source: "manual" },
      });
    }
    if (suggestions.length) {
      await sb(env, "suggested_matches", { method: "POST", body: suggestions });
    }

    return json({ marked: toExclude.length / 2, suggested: suggestions.length });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
