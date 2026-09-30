// api/order-delai-webhook.js — Webhook Shopify (topic ORDERS_CREATE).
// Calcule la date limite de traitement pour CETTE commande (reference = date
// de creation de la commande, pas "maintenant") et l'ecrit en metafield
// custom.date_limite_traitement sur la commande, visible ensuite dans le
// back-office Vercel (onglet Delais & FOMO / commandes).
//
// Body brut requis pour la verification HMAC -> bodyParser desactive.
export const config = { api: { bodyParser: false } };

const { calculerDelais } = require('../lib/delaiCalc.js');
const { getDelaiConfig, adminGql } = require('../lib/shopifyAdmin.js');
const { readVerifiedWebhook } = require('../lib/webhookAuth.js');

function extractNumericId(gid) {
  if (!gid) return null;
  const parts = String(gid).split('/');
  return parts[parts.length - 1];
}

export default async function handler(req, res) {
  const order = await readVerifiedWebhook(req, res);
  if (!order) return;

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
  } catch (err) {
    console.error('order-delai-webhook error:', err.message);
  }

  res.status(200).json({ ok: true });
}
