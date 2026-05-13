// api/shopify.js — Proxy Vercel sécurisé
const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD;
const GAS_URL = process.env.GAS_URL;       // URL du Google Apps Script déployé
const GAS_SECRET = process.env.GAS_SECRET; // Secret partagé avec le GAS

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 300000) return cachedToken;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const password = req.headers['x-app-password'];
  if (!APP_PASSWORD || !password || password !== APP_PASSWORD) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body || {};
    const { query, variables, action } = body;

    console.log('action:', action, 'GAS_URL:', !!GAS_URL, 'GAS_SECRET:', !!GAS_SECRET);

    // ── Action spéciale : déléguer au GAS pour générer le ZIP ──
    if (action === 'generateZip') {
      if (!GAS_URL || !GAS_SECRET) {
        res.status(500).json({ error: `GAS_URL ou GAS_SECRET non configuré — GAS_URL:${!!GAS_URL} GAS_SECRET:${!!GAS_SECRET}` });
        return;
      }
      console.log('Calling GAS:', GAS_URL.substring(0, 50));
      const gasRes = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: GAS_SECRET, orders: body.orders }),
      });
      console.log('GAS response status:', gasRes.status);
      if (!gasRes.ok) {
        const txt = await gasRes.text();
        console.log('GAS error body:', txt.substring(0, 300));
        res.status(500).json({ error: `GAS error ${gasRes.status}: ${txt.substring(0, 200)}` });
        return;
      }
      const gasData = await gasRes.json();
      res.status(200).json(gasData);
      return;
    }

    // ── Requête GraphQL standard ──
    const token = await getToken();
    const shopifyRes = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const data = await shopifyRes.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
