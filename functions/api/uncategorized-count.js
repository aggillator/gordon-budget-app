import { json } from "../_utils.js";

// Just a count, using Postgres' exact count header instead of fetching rows
// - cheap regardless of how many uncategorized transactions actually exist.
export async function onRequestGet({ env }) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/transactions?select=id&category_id=is.null`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    }
  );
  const range = res.headers.get("content-range"); // e.g. "0-0/132"
  const count = range ? parseInt(range.split("/")[1], 10) || 0 : 0;
  return json({ count });
}
