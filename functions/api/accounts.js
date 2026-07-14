import { json, sb } from "../_utils.js";

export async function onRequestGet({ env }) {
  const rows = await sb(env, "accounts?select=id,name,mask,type&order=name.asc");
  return json(rows);
}
