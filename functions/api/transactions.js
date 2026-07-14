import { json, sb } from "../_utils.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get("month"); // e.g. "2026-07"
  const categoryId = url.searchParams.get("category_id");
  const search = url.searchParams.get("search");

  let path =
    "transactions?select=*,categories(name),accounts(name,type,subtype)&order=date.desc&limit=500";

  if (month && !search) {
    path += `&date=gte.${month}-01&date=lt.${nextMonth(month)}-01`;
  }
  if (categoryId === "unassigned") {
    path += `&category_id=is.null`;
  } else if (categoryId) {
    path += `&category_id=eq.${categoryId}`;
  }
  if (search && search.trim()) {
    const pattern = `*${encodeURIComponent(search.trim())}*`;
    path += `&or=(merchant_name.ilike.${pattern},name.ilike.${pattern})`;
  }

  const rows = await sb(env, path);
  return json(rows);
}

// Setting a category by hand does three things:
// 1. Updates this transaction (marked "manual" so nothing else overwrites it)
// 2. Saves/updates a keyword rule so future syncs auto-categorize the same merchant
// 3. Immediately applies the category to every other transaction from that
//    merchant that isn't already manually categorized
export async function onRequestPatch({ request, env }) {
  const { id, category_id } = await request.json();
  if (!id) return json({ error: "id required" }, 400);

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
