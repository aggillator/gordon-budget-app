import { json, sb } from "../_utils.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get("month"); // e.g. "2026-07"
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

// Two different kinds of edit come through here:
// - category_id present: the category-change flow (marks manual, saves a
//   rule, propagates to similar transactions - see below)
// - custom_name present: just renaming the transaction for display, no
//   propagation, doesn't touch category at all
export async function onRequestPatch({ request, env }) {
  const { id, category_id, custom_name } = await request.json();
  if (!id) return json({ error: "id required" }, 400);

  if (custom_name !== undefined) {
    await sb(env, `transactions?id=eq.${id}`, {
      method: "PATCH",
      body: { custom_name: custom_name || null },
    });
    return json({ ok: true });
  }

  const [txn] = await sb(env, `transactions?id=eq.${id}&select=merchant_name,name`);

  await sb(env, `transactions?id=eq.${id}`, {
    method: "PATCH",
    body: { category_id, category_source: "manual" },
  });

  let propagated = 0;

  if (category_id && txn) {
    const keyword = (txn.merchant_name || txn.name || "").trim();

    if (keyword.length >= 3) {
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

      const field = txn.merchant_name ? "merchant_name" : "name";
      const pattern = `*${encodeURIComponent(keyword)}*`;
      const updated = await sb(
        env,
        `transactions?id=neq.${id}&category_source=neq.manual&${field}=ilike.${pattern}`,
        {
          method: "PATCH",
          prefer: "return=representation",
          body: { category_id, category_source: "rule" },
        }
      );
      propagated = updated ? updated.length : 0;
    }
  }

  return json({ ok: true, propagated });
}

function nextMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
