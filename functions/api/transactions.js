import { json, sb } from "../_utils.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get("month"); // e.g. "2026-07"
  let path =
    "transactions?select=*,categories(name)&order=date.desc&limit=500";
  if (month) {
    path += `&date=gte.${month}-01&date=lt.${nextMonth(month)}-01`;
  }
  const rows = await sb(env, path);
  return json(rows);
}

export async function onRequestPatch({ request, env }) {
  const { id, category_id } = await request.json();
  if (!id) return json({ error: "id required" }, 400);
  await sb(env, `transactions?id=eq.${id}`, {
    method: "PATCH",
    body: { category_id, category_source: "manual" },
  });
  return json({ ok: true });
}

function nextMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo, 1)); // mo is 1-indexed input -> rolls to next month
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
