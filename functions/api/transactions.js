import { json, sb, logAction } from "../_utils.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  const categoryId = url.searchParams.get("category_id");
  const accountId = url.searchParams.get("account_id");
  const search = url.searchParams.get("search");

  let path =
    "transactions?select=*,categories(name),accounts(name,type,subtype)&order=date.desc&limit=500";

  if (search) {
    // search spans all time, ignores month/date-range on purpose
  } else if (dateFrom || dateTo) {
    if (dateFrom) path += `&date=gte.${dateFrom}`;
    if (dateTo) path += `&date=lte.${dateTo}`;
  } else if (month) {
    path += `&date=gte.${month}-01&date=lt.${nextMonth(month)}-01`;
  }

  if (categoryId === "unassigned") {
    path += `&category_id=is.null`;
  } else if (categoryId) {
    path += `&category_id=eq.${categoryId}`;
  }
  if (accountId) {
    path += `&account_id=eq.${accountId}`;
  }
  if (search && search.trim()) {
    const pattern = `*${encodeURIComponent(search.trim())}*`;
    path += `&or=(merchant_name.ilike.${pattern},name.ilike.${pattern},custom_name.ilike.${pattern})`;
  }

  const rows = await sb(env, path);
  return json(rows);
}

// Three kinds of request come through here:
// - custom_name present: just renaming the transaction for display
// - category_id + preview:true: dry run - reports how many OTHER
//   transactions would be affected, without changing anything, so the
//   frontend can show a confirmation dialog with a real count
// - category_id (+ apply_to_all): the actual category change. Always
//   updates the one transaction; only propagates to similar transactions
//   if apply_to_all is true.
export async function onRequestPatch({ request, env }) {
  const { id, category_id, custom_name, preview, apply_to_all } = await request.json();
  if (!id) return json({ error: "id required" }, 400);

  if (custom_name !== undefined) {
    await sb(env, `transactions?id=eq.${id}`, {
      method: "PATCH",
      body: { custom_name: custom_name || null },
    });
    return json({ ok: true });
  }

  const [txn] = await sb(
    env,
    `transactions?id=eq.${id}&select=merchant_name,name,custom_name,category_id,category_source`
  );
  if (!txn) return json({ error: "transaction not found" }, 404);

  // Prefer matching on the item-level custom_name (e.g. from an Amazon
  // import) over the generic merchant name - "USB Cable" is specific;
  // "Amazon" matches everything you've ever bought there. This is the fix
  // for the Amazon-wide mis-categorization incident.
  const matchField = txn.custom_name ? "custom_name" : txn.merchant_name ? "merchant_name" : "name";
  const keyword = (txn[matchField] || "").trim();

  let matches = [];
  if (category_id && keyword.length >= 3) {
    const pattern = `*${encodeURIComponent(keyword)}*`;
    matches = await sb(
      env,
      `transactions?id=neq.${id}&category_source=neq.manual&select=id,category_id,category_source&${matchField}=ilike.${pattern}`
    );
  }

  if (preview) {
    return json({ match_count: matches.length, match_field: matchField, keyword });
  }

  await sb(env, `transactions?id=eq.${id}`, {
    method: "PATCH",
    body: { category_id, category_source: "manual" },
  });

  let propagated = 0;

  if (category_id && apply_to_all && matches.length > 0) {
    // Only save a keyword rule when matching on the real merchant name -
    // custom_name isn't visible to the sync pipeline for brand-new
    // transactions, so a rule keyed on it would never actually fire.
    if (matchField !== "custom_name") {
      const existingRule = await sb(
        env,
        `category_rules?keyword=eq.${encodeURIComponent(keyword)}`
      );
      if (existingRule.length) {
        await sb(env, `category_rules?id=eq.${existingRule[0].id}`, {
          method: "PATCH",
          body: { category_id },
        });
      } else {
        await sb(env, "category_rules", {
          method: "POST",
          body: { keyword, category_id },
        });
      }
    }

    const pattern = `*${encodeURIComponent(keyword)}*`;
    const updated = await sb(
      env,
      `transactions?id=neq.${id}&category_source=neq.manual&${matchField}=ilike.${pattern}`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: { category_id, category_source: "rule" },
      }
    );
    propagated = updated ? updated.length : 0;

    const loggedTxns = [
      { id, prior_category_id: txn.category_id, prior_category_source: txn.category_source },
      ...matches.map((m) => ({
        id: m.id,
        prior_category_id: m.category_id,
        prior_category_source: m.category_source,
      })),
    ];
    await logAction(
      env,
      "propagate_category",
      `Categorized "${keyword}" and ${propagated} similar transaction${propagated === 1 ? "" : "s"}`,
      { transactions: loggedTxns }
    );
  }

  return json({ ok: true, propagated });
}

function nextMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
