// Shared helpers used by every /functions/api/*.js route.
// Not a route itself (filenames starting with _ are ignored by Pages routing).

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Talks to Supabase's built-in REST API (PostgREST) using the service role key.
// Docs: https://supabase.com/docs/guides/api
export async function sb(env, path, { method = "GET", body, prefer } = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json",
  };
  if (prefer) headers["Prefer"] = prefer;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Talks to Plaid. env.PLAID_ENV should be "sandbox" or "production"
// (Trial-plan production credentials still use the production host).
export async function plaid(env, endpoint, body) {
  const host =
    env.PLAID_ENV === "production"
      ? "https://production.plaid.com"
      : "https://sandbox.plaid.com";

  const res = await fetch(`${host}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Plaid ${endpoint} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// Very small, deliberately dumb keyword categorizer.
// Checks the transaction's merchant/name against saved keyword rules.
export function suggestCategory(rules, txn) {
  const haystack = `${txn.merchant_name || ""} ${txn.name || ""}`.toLowerCase();
  const hit = rules.find((r) => haystack.includes(r.keyword.toLowerCase()));
  return hit ? hit.category_id : null;
}
