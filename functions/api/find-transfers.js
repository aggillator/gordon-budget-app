import { json, sb } from "../_utils.js";

// Finds pass-through internal transfers: the same real expense (or its
// refund) showing up as two separate transactions because money moved
// through two connected accounts (e.g. PayPal funded by Amex, then PayPal
// pays the merchant - or the reverse on a refund). Matches same amount
// (any sign - charges AND refunds) + different account + within 2 days.
//
// Default: whichever side belongs to a PayPal-type account is excluded,
// since the other side usually carries the real merchant name. Exception:
// if the OTHER (non-PayPal) side's name is generic funding language ("Add
// Money", "Amex Send", "Mobile Payment") with no recipient info, that side
// is excluded instead and PayPal's is kept - this matters for person-to-
// person transfers, where only PayPal's "Payment to <name>" / "Refund from
// <name>" identifies who the money actually went to or came from.
// Pairs where neither side is a known PayPal-type account are skipped
// rather than guessed - there's no reliable signal for which side to drop.
const FUNDING_PATTERN = /add money|amex send|mobile payment/i;

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

    const paypalAccounts = await sb(env, `accounts?subtype=eq.paypal&select=id`);
    const paypalAccountIds = new Set(paypalAccounts.map((a) => a.id));

    const txns = await sb(
      env,
      `transactions?select=id,account_id,date,amount,name&category_id=neq.${categoryId}&order=date.asc&limit=5000`
    );

    const byAmount = {};
    for (const t of txns) {
      (byAmount[t.amount] ||= []).push(t);
    }

    const used = new Set();
    const toExclude = [];

    for (const group of Object.values(byAmount)) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        const a = group[i];
        if (used.has(a.id)) continue;
        for (let j = i + 1; j < group.length; j++) {
          const b = group[j];
          if (used.has(b.id) || a.account_id === b.account_id) continue;
          const diffDays = Math.abs(new Date(a.date) - new Date(b.date)) / 86400000;
          if (diffDays > 2) continue;

          const aIsPaypal = paypalAccountIds.has(a.account_id);
          const bIsPaypal = paypalAccountIds.has(b.account_id);
          if (!aIsPaypal && !bIsPaypal) continue; // no reliable signal, skip

          const paypalSide = aIsPaypal ? a : b;
          const otherSide = aIsPaypal ? b : a;
          const excludeId = FUNDING_PATTERN.test(otherSide.name) ? otherSide.id : paypalSide.id;

          toExclude.push(excludeId);
          used.add(a.id);
          used.add(b.id);
          break;
        }
      }
    }

    if (toExclude.length) {
      await sb(env, `transactions?id=in.(${toExclude.join(",")})`, {
        method: "PATCH",
        body: { category_id: categoryId, category_source: "manual" },
      });
    }

    return json({ marked: toExclude.length });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
