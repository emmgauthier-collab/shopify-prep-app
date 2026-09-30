// api/fulfillment-webhook.js — Webhook Shopify (topic FULFILLMENTS_CREATE).
// Quand une expedition est creee (Sendcloud) et qu'il ne reste plus aucun
// article physique a expedier, on marque aussi comme traitees les lignes non
// physiques restantes (produit RUSH, frais annexes : requiresShipping = false),
// sans notifier le client. La commande passe ainsi en "Traitee" et non "Partielle".
//
// Idempotent : notre propre fulfillment redeclenche ce webhook, mais il ne
// reste alors plus rien a traiter -> aucune action.
export const config = { api: { bodyParser: false } };

const { readVerifiedWebhook } = require('../lib/webhookAuth.js');
const { getDelaiConfig, adminGql } = require('../lib/shopifyAdmin.js');

const ORDER_QUERY =
  'query($id:ID!){ order(id:$id){ name cancelledAt' +
  '  lineItems(first:250){ nodes{ id title requiresShipping isGiftCard currentQuantity unfulfilledQuantity product{ id } } }' +
  '  fulfillmentOrders(first:20){ nodes{ id status lineItems(first:250){ nodes{ id remainingQuantity lineItem{ id } } } } } } }';
const FULFILL_MUTATION =
  'mutation($f:FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ fulfillment{ id status } userErrors{ field message } } }';

async function completeNonPhysical(orderGid, rushProductId) {
  const d = await adminGql(ORDER_QUERY, { id: orderGid });
  const order = d.order;
  if (!order || order.cancelledAt) return;

  const isNonPhysical = function (li) {
    if (li.isGiftCard) return false;
    return li.requiresShipping === false || (rushProductId && li.product && li.product.id === rushProductId);
  };
  const lines = order.lineItems.nodes.filter(function (li) { return li.currentQuantity > 0; });

  // Encore des articles physiques a expedier -> on attend la derniere expedition.
  if (lines.some(function (li) { return !isNonPhysical(li) && li.unfulfilledQuantity > 0; })) return;

  const targets = {};
  lines.forEach(function (li) { if (isNonPhysical(li) && li.unfulfilledQuantity > 0) targets[li.id] = li.title; });
  if (!Object.keys(targets).length) return; // rien a completer

  const byFo = [];
  order.fulfillmentOrders.nodes.forEach(function (fo) {
    if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS') return;
    const items = fo.lineItems.nodes
      .filter(function (n) { return n.remainingQuantity > 0 && targets[n.lineItem.id]; })
      .map(function (n) { return { id: n.id, quantity: n.remainingQuantity }; });
    if (items.length) byFo.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: items });
  });
  if (!byFo.length) { console.warn('auto-fulfill: aucun fulfillment order ouvert', order.name); return; }

  const r = await adminGql(FULFILL_MUTATION, { f: { lineItemsByFulfillmentOrder: byFo, notifyCustomer: false } });
  const errs = r.fulfillmentCreate.userErrors;
  if (errs && errs.length) console.error('auto-fulfill userErrors:', order.name, errs);
  else console.log('auto-fulfill OK:', order.name, Object.values(targets).join(', '));
}

export default async function handler(req, res) {
  const fulfillment = await readVerifiedWebhook(req, res);
  if (!fulfillment) return;

  // Jamais d'echec HTTP (sinon Shopify retente en boucle) : on log et on repond 200.
  try {
    const config = await getDelaiConfig(true);
    await completeNonPhysical('gid://shopify/Order/' + fulfillment.order_id, config.rushProductId || null);
  } catch (err) {
    console.error('fulfillment-webhook error:', err.message);
  }
  res.status(200).json({ ok: true });
}
