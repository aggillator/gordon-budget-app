import { json, sb, plaid } from "../_utils.js";

// Lists connected institutions with their accounts and a transaction count,
// so you can see what you'd be removing before you remove it.
export async function onRequestGet({ env }) {
  const items = await sb(
    env,
    "plaid_items?select=id,institution_name,created_at&order=created_at.asc"
  );
  const accounts = await sb(env, "accounts?select=id,plaid_item_id,name,mask,sync_disabled");
  const txns = await sb(env, "transactions?select=account_id");

  const accountsByItem = {};
  for (const a of accounts) {
    (accountsByItem[a.plaid_item_id] ||= []).push(a);
  }
  const countByAccount = {};
  for (const t of txns) {
    countByAccount[t.account_id] = (countByAccount[t.account_id] || 0) + 1;
  }

  const result = items.map((it) => {
    const accs = accountsByItem[it.id] || [];
    const txn_count = accs.reduce((sum, a) => sum + (countByAccount[a.id] || 0), 0);
    return {
      id: it.id,
      institution_name: it.institution_name,
      created_at: it.created_at,
      accounts: accs.map((a) => ({ name: a.name, mask: a.mask, sync_disabled: a.sync_disabled })),
      txn_count,
    };
  });

  return json(result);
}

// Disconnects an institution: revokes the Plaid access token (stops billing
// and future syncing on Plaid's side), then deletes the local record, which
// cascades to its accounts and every one of their transactions.
// Note: this does NOT free up a Trial-plan Item slot - Plaid counts every
// Item ever created, removed or not.
export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id required" }, 400);

  const [item] = await sb(
    env,
    `plaid_items?id=eq.${id}&select=access_token,institution_name`
  );
  if (!item) return json({ error: "not found" }, 404);

  try {
    await plaid(env, "/item/remove", { access_token: item.access_token });
  } catch (err) {
    // Proceed with local cleanup even if the Plaid-side call fails (e.g.
    // token already invalid) - don't leave the user stuck either way.
  }

  await sb(env, `plaid_items?id=eq.${id}`, { method: "DELETE" });

  return json({ ok: true, institution_name: item.institution_name });
}
