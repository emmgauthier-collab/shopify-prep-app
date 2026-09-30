// api/order-delai-webhook.js — Webhook Shopify (topic ORDERS_CREATE).
// Calcule la date limite de traitement pour CETTE commande (reference = date
// de creation de la commande, pas "maintenant") et l'ecrit en metafield
// custom.date_limite_traitement sur la commande, visible ensuite dans le
// back-office Vercel (onglet Delais & FOMO / commandes).
// Marque aussi comme traitees les lignes non physiques (RUSH / frais), cf. autoFulfillNonPhysical.
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

// ── Auto-fulfill des lignes non physiques (RUSH, frais annexes) ──────────────
// Ces lignes (requires_shipping = false) n'ont rien a expedier. On les marque
// traitees des la creation, sans notifier le client, pour qu'a l'expedition
// Sendcloud la commande passe bien en "Traitee" (FULFILLED) et non "Partielle".
// On ne touche pas aux commandes 100% non physiques (ex. frais seuls) pour ne
// pas les faire disparaitre de la liste de preparation.
const FO_QUERY =
  'query($id:ID!){ order(id:$id){ fulfillmentOrders(first:10){ nodes{ id status' +
  '  lineItems(first:100){ nodes{ id remainingQuantity lineItem{ id } } } } } } }';
const FULFILL_MUTATION =
  'mutation($f:FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ fulfillment{ id status } userErrors{ field message } } }';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function autoFulfillNonPhysical(order, rushProductNumericId) {
  const lineItems = order.line_items || [];
  const isTarget = function (li) {
    if (li.gift_card) return false;
    const isRush = rushProductNumericId && String(li.product_id) === rushProductNumericId;
    return isRush || li.requires_shipping === false;
  };
  const targets = lineItems.filter(isTarget);
  if (!targets.length) return;
  if (!lineItems.some(function (li) { return !isTarget(li); })) return; // aucune ligne physique

  const targetGids = {};
  targets.forEach(function (li) { targetGids['gid://shopify/LineItem/' + li.id] = true; });

  // Les fulfillment orders sont crees en asynchrone : on retente brievement.
  let fos = [];
  for (let i = 0; i < 3; i++) {
    const d = await adminGql(FO_QUERY, { id: order.admin_graphql_api_id });
    fos = (d.order && d.order.fulfillmentOrders.nodes) || [];
    if (fos.length) break;
    await sleep(700);
  }

  const byFo = [];
  fos.forEach(function (fo) {
    if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS') return;
    const items = fo.lineItems.nodes
      .filter(function (n) { return n.remainingQuantity > 0 && targetGids[n.lineItem.id]; })
      .map(function (n) { return { id: n.id, quantity: n.remainingQuantity }; });
    if (items.length) byFo.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: items });
  });
  if (!byFo.length) return; // deja traitees (webhook rejoue) ou FO pas dispo

  const r = await adminGql(FULFILL_MUTATION, { f: { lineItemsByFulfillmentOrder: byFo, notifyCustomer: false } });
  const errs = r.fulfillmentCreate.userErrors;
  if (errs && errs.length) console.error('auto-fulfill userErrors:', order.name, errs);
  else console.log('auto-fulfill OK:', order.name, targets.map(function (li) { return li.title; }).join(', '));
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
      rushConfigured: !!config.rushProductId && !!config.rushActif,
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

    // Try/catch separe : un echec d'auto-fulfill ne doit pas impacter le reste.
    try {
      await autoFulfillNonPhysical(order, rushProductNumericId);
    } catch (e) {
      console.error('auto-fulfill error:', order.name, e.message);
    }
  } catch (err) {
    console.error('order-delai-webhook error:', err.message);
  }

  res.status(200).json({ ok: true });
}
