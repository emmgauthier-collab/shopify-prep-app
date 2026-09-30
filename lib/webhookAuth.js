// lib/webhookAuth.js
// Lecture du body brut + verification HMAC des webhooks Shopify, partagees
// par tous les endpoints webhook (order-delai-webhook, fulfillment-webhook).
const crypto = require('crypto');

function readRawBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function verifyHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(hmacHeader, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Lit, verifie et parse. Renvoie l'objet JSON, ou null apres avoir repondu l'erreur.
async function readVerifiedWebhook(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return null; }
  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch (e) { res.status(400).json({ error: 'Body read failed' }); return null; }
  if (!verifyHmac(rawBody, req.headers['x-shopify-hmac-sha256'])) {
    res.status(401).json({ error: 'Invalid HMAC' }); return null;
  }
  try { return JSON.parse(rawBody.toString('utf8')); }
  catch (e) { res.status(400).json({ error: 'Invalid JSON' }); return null; }
}

module.exports = { readRawBody, verifyHmac, readVerifiedWebhook };
