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

// Talks to the Anthropic API for AI-assisted categorization.
export async function anthropic(env, systemPrompt, userPrompt, maxTokens = 2000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API failed: ${JSON.stringify(data)}`);
  }
  return data.content.map((b) => b.text || "").join("");
}

// Very small, deliberately dumb keyword categorizer.
// Checks the transaction's merchant/name against saved keyword rules.
export function suggestCategory(rules, txn) {
  const haystack = `${txn.merchant_name || ""} ${txn.name || ""}`.toLowerCase();
  const hit = rules.find((r) => haystack.includes(r.keyword.toLowerCase()));
  return hit ? hit.category_id : null;
}

// Records a snapshot of "what changed" for one of the three undoable bulk
// actions (AI categorize run, category deletion, category propagation to
// similar transactions). Undo just replays this snapshot in reverse.
export async function logAction(env, action_type, description, snapshot) {
  await sb(env, "action_log", {
    method: "POST",
    body: { action_type, description, snapshot },
  });
}
