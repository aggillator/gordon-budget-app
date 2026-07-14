import { json, sb } from "../_utils.js";

// Just the earliest transaction date on file, so the frontend can build a
// month picker that spans your actual history instead of a fixed count.
export async function onRequestGet({ env }) {
  const rows = await sb(env, "transactions?select=date&order=date.asc&limit=1");
  return json({ earliest: rows[0]?.date || null });
}
