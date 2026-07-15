import { json, sb } from "../_utils.js";

// Finds pass-through internal transfers: the same real expense showing up
// as two separate transactions because money moved through two connected
// accounts (e.g. PayPal funded by Amex, then PayPal pays the merchant).
// Matches same amount + different account + within 2 days, then decides
// which side to keep:
// - if one side literally says "Add Money"/"Amex Send" (pure funding, no
//   recipient info), that side is excluded and the other is kept
// - otherwise, a "Payment to X" (PayPal-style) name is excluded in favor
//   of the side with a real merchant name
// Ambiguous pairs (neither rule applies) are left alone rather than guessed.
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

    const txns = await sb(
      env,
      `transactions?select=id,account_id,date,amount,name&amount=gt.0&category_id=neq.${categoryId}&order=date.asc&limit=5000`
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

          const aFunding = /add money|amex send/i.test(a.name);
          const bFunding = /add money|amex send/i.test(b.name);
          let excludeId = null;
          if (aFunding) excludeId = a.id;
          else if (bFunding) excludeId = b.id;
          else {
            const aPaypalStyle = /^payment to /i.test(a.name);
            const bPaypalStyle = /^payment to /i.test(b.name);
            if (aPaypalStyle && !bPaypalStyle) excludeId = a.id;
            else if (bPaypalStyle && !aPaypalStyle) excludeId = b.id;
          }

          if (excludeId) {
            toExclude.push(excludeId);
            used.add(a.id);
            used.add(b.id);
            break;
          }
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
