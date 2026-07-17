import { json, sb } from "../_utils.js";

// Finds pass-through internal transfers: the same real expense (or its
// refund) showing up as two separate transactions because money moved
// through two connected accounts (e.g. PayPal funded by Amex, then PayPal
// pays the merchant - or the reverse on a refund). Matches same amount
// (any sign - charges AND refunds) + different account + within 5 days.
//
// Default: whichever side belongs to a PayPal-type account is excluded,
// since the other side usually carries the real merchant name. Exception:
// if the OTHER (non-PayPal) side's name is generic funding language ("Add
// Money", "Amex Send", "Mobile Payment") with no recipient info, that side
// is excluded instead and PayPal's is kept.
//
// Confident matches (2 days or less apart, exactly one PayPal side, no
// competing candidate) apply automatically. Anything less certain gets
// queued in suggested_matches for review instead of guessed. Pairs where
// neither side is a known PayPal account are skipped entirely - there's no
// reliable signal at all for those.
const FUNDING_PATTERN = /add money|amex send|mobile payment/i;
const AUTO_APPLY_DAYS = 2;
const SUGGEST_MAX_DAYS = 5;

export async function onRequestPost({ env }) {
  try {
    let transferCat = await sb(env, `categories?name=eq.Internal Transfer&select=id`);
    let categoryId;
    if (transferCat.length) {
      categoryId = transferCat[0].id;
    } else {
      const [created] = await sb(env, "categories", {
        method: "POST",
        prefer: "return=representation",
        body: {
          name: "Internal Transfer",
          monthly_budget: 0,
          is_fixed: false,
          exclude_from_budget: true,
          sort_order: 40,
        },
      });
      categoryId = created.id;
    }

    // Only the actual PayPal wallet (type=depository) is a structural
    // pass-through - a purchase paid from wallet balance necessarily shows
    // up twice (the funding pull + PayPal's own record). PayPal Cashback
    // Mastercard and PayPal Credit share subtype=paypal but are real credit
    // lines - a purchase there is a single, self-contained transaction, so
    // they must NOT be treated as the "excluded by default" side here.
    const paypalAccounts = await sb(env, `accounts?subtype=eq.paypal&type=eq.depository&select=id`);
    const paypalAccountIds = new Set(paypalAccounts.map((a) => a.id));

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
      `transactions?select=id,account_id,date,amount,name&category_id=neq.${categoryId}&order=date.asc&limit=5000`
    );

    const byAmount = {};
    for (const t of txns) {
      if (alreadyPending.has(t.id)) continue;
      (byAmount[t.amount] ||= []).push(t);
    }

    const used = new Set();
    const toExclude = [];
    const suggestions = [];

    for (const group of Object.values(byAmount)) {
      if (group.length < 2) continue;

      const candidatePairs = [];
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (a.account_id === b.account_id) continue;
          const aIsPaypal = paypalAccountIds.has(a.account_id);
          const bIsPaypal = paypalAccountIds.has(b.account_id);
          if (!aIsPaypal && !bIsPaypal) continue; // no reliable signal, skip entirely
          const diffDays = Math.abs(new Date(a.date) - new Date(b.date)) / 86400000;
          if (diffDays > SUGGEST_MAX_DAYS) continue;
          candidatePairs.push({ a, b, diffDays, aIsPaypal, bIsPaypal });
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

        const paypalSide = pair.aIsPaypal ? pair.a : pair.b;
        const otherSide = pair.aIsPaypal ? pair.b : pair.a;
        const excludeId = FUNDING_PATTERN.test(otherSide.name) ? otherSide.id : paypalSide.id;

        if (pair.diffDays <= AUTO_APPLY_DAYS && !tie) {
          toExclude.push(excludeId);
        } else {
          const keepId = excludeId === pair.a.id ? pair.b.id : pair.a.id;
          suggestions.push({
            match_type: "transfer",
            transaction_id_a: excludeId, // the one that would be excluded if accepted
            transaction_id_b: keepId, // the one that stays as the real spend record
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

    return json({ marked: toExclude.length, suggested: suggestions.length });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
