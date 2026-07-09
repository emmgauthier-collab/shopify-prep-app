// api/order-delai-webhook.js — Webhook Shopify (topic ORDERS_CREATE).
// Calcule la date limite de traitement pour CETTE commande (reference = date
// de creation de la commande, pas "maintenant") et l'ecrit en metafield
// custom.date_limite_traitement sur la commande, visible ensuite dans le
// back-office Vercel (onglet Delais & FOMO / commandes).
//
// Body brut requis pour la verification HMAC -> bodyParser desactive.
export const config = { api: { bodyParser: false } };

const crypto = require('crypto');
const { calculerDelais } = require('../lib/delaiCalc.js');
const { getDelaiConfig, adminGql } = require('../lib/shopifyAdmin.js');

const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

async function readRawBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function verifyHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', CLIENT_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(hmacHeader, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractNumericId(gid) {
  if (!gid) return null;
  const parts = String(gid).split('/');
  return parts[parts.length - 1];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    res.status(400).json({ error: 'Body read failed' });
    return;
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!verifyHmac(rawBody, hmacHeader)) {
    res.status(401).json({ error: 'Invalid HMAC' });
    return;
  }

  let order;
  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  // On repond vite a Shopify (< 5s), le calcul est rapide donc pas besoin
  // de differer le traitement — mais on log/avale les erreurs sans jamais
  // faire echouer la reponse HTTP (sinon Shopify retente indefiniment).
  try {
    const config = await getDelaiConfig(true); // fresh, pas de cache pour une ecriture
    const rushProductNumericId = extractNumericId(config.rushProductId);

    const lineItems = order.line_items || [];
    const estRush = rushProductNumericId
      ? lineItems.some(function (li) { return String(li.product_id) === rushProductNumericId; })
      : false;

    const fromDate = new Date(order.created_at);

    const r = calculerDelais({
      fromDate: fromDate,
      delaiNormal: config.delaiProduction,
      delaiRush: config.delaiRush,
      plancher: config.delaiPlancher,
      periodes: config.periodes,
      rushConfigured: !!config.rushProductId,
    });

    const dateLimite = estRush ? r.dateRushISO : r.dateNormaleISO;
    const orderGid = order.admin_graphql_api_id;

    const mutation =
      'mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ metafields{ id } userErrors{ field message } } }';
    const data = await adminGql(mutation, {
      mf: [
        { ownerId: orderGid, namespace: 'custom', key: 'date_limite_traitement', value: dateLimite, type: 'date' },
        { ownerId: orderGid, namespace: 'custom', key: 'est_rush', value: String(estRush), type: 'boolean' },
      ],
    });
    const errs = data.metafieldsSet.userErrors;
    if (errs && errs.length) {
      console.error('metafieldsSet userErrors:', errs);
    }
  } catch (err) {
    console.error('order-delai-webhook error:', err.message);
  }

  res.status(200).json({ ok: true });
}
