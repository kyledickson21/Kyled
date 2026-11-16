// ─── Google Sheets read-only client (server-side only) ────────────────────────
//
// A minimal service-account OAuth2 flow using only Node's built-in `crypto` and `fetch` — no
// googleapis/google-auth-library dependency, matching this project's existing preference for a
// small dependency footprint (see api/_resimpli-client.mjs's own plain-fetch approach).
//
// Standard OAuth2 "JWT Bearer" grant for a service account (RFC 7523 / Google's own
// documented flow): sign a short-lived JWT with the service account's private key, exchange it
// at Google's token endpoint for an access token, then call the Sheets API with that token as
// a Bearer credential. Read-only scope only — this client has no function that writes to a
// Sheet.
//
// Reads GOOGLE_SERVICE_ACCOUNT_JSON (the full service-account JSON key Kyle downloads from
// Google Cloud Console — not just the private key) — never a VITE_-prefixed var, never
// imported by client code.

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON"); }
  if (!parsed.client_email || !parsed.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email/private_key");
  return parsed;
}

async function getAccessToken(scope = "https://www.googleapis.com/auth/spreadsheets.readonly") {
  const { client_email, private_key } = serviceAccount();
  const { createSign } = await import("crypto");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: client_email, scope, aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now,
  }));
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(private_key).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`Google token exchange failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

// Reads one range as a 2D array of cell values (rows of strings), same shape the Sheets API
// itself returns — row 0 is whatever is actually in row 1 of the range (a header row, if the
// range includes one; caller's job to skip it).
export async function fetchSheetValues(spreadsheetId, range) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets API returned ${res.status}: ${JSON.stringify(json)}`);
  return json.values || [];
}
