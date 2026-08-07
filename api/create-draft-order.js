// api/create-draft-order.js — Endpoint PUBLIC (pas de mot de passe), consommé par la
// section "Commande groupée" de la landing box du thème Shopify (bouton "Demander un devis").
// Crée un Draft Order via l'Admin API. Le devis est ensuite traité manuellement dans
// Shopify Admin > Commandes > Brouillons (pas de back-office custom, décision assumée) :
// on ne renvoie donc jamais l'invoiceUrl au client, pour garder une revue humaine avant paiement.
const { adminGql } = require('../lib/shopifyAdmin.js');

const ALLOWED_ORIGINS = [
  'https://rxwear.fr',
  'https://www.rxwear.fr',
  'https://rxwear.eu',
  'https://www.rxwear.eu',
  'https://rxwear.be',
  'https://therxshop.myshopify.com',
  'https://rxwearshop.myshopify.com',
];

const DRAFT_ORDER_CREATE =
  'mutation draftOrderCreate($input: DraftOrderInput!) {' +
  '  draftOrderCreate(input: $input) {' +
  '    draftOrder {' +
  '      id' +
  '      name' +
  '      totalPriceSet { shopMoney { amount currencyCode } }' +
  '    }' +
  '    userErrors { field message }' +
  '  }' +
  '}';

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const boxName = body.boxName;
    const contactName = body.contactName;
    const email = body.email;
    const phone = body.phone;
    const deliveryDate = body.deliveryDate;
    const message = body.message;
    const items = body.items;
    const logoFront = body.logoFront;
    const logoBack = body.logoBack;

    if (!email) { res.status(400).json({ error: 'email requis' }); return; }
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: 'items requis' }); return; }

    const lineItems = items
      .filter(function (it) { return it && it.variantId && it.quantity > 0; })
      .map(function (it) {
        const gid = String(it.variantId).indexOf('gid://') === 0
          ? it.variantId
          : 'gid://shopify/ProductVariant/' + it.variantId;
        return { variantId: gid, quantity: it.quantity };
      });

    if (lineItems.length === 0) { res.status(400).json({ error: 'aucune ligne valide' }); return; }
    if (lineItems.length > 250) { res.status(400).json({ error: 'trop de lignes (max 250)' }); return; }

    const customAttributes = [];
    if (boxName) customAttributes.push({ key: 'Nom de la box', value: String(boxName).slice(0, 255) });
    if (contactName) customAttributes.push({ key: 'Contact', value: String(contactName).slice(0, 255) });
    if (deliveryDate) customAttributes.push({ key: 'Date de livraison souhaitée', value: String(deliveryDate).slice(0, 255) });
    if (logoFront) customAttributes.push({ key: '_Logo avant (SVG)', value: String(logoFront) });
    if (logoBack) customAttributes.push({ key: '_Logo dos (SVG)', value: String(logoBack) });

    const noteParts = [];
    if (boxName) noteParts.push('Box : ' + boxName);
    if (contactName) noteParts.push('Contact : ' + contactName);
    if (phone) noteParts.push('Téléphone : ' + phone);
    if (deliveryDate) noteParts.push('Livraison souhaitée : ' + deliveryDate);
    if (message) noteParts.push('Message : ' + message);
    noteParts.push('— Demande de devis via la landing "Collection Box"');

    const input = {
      lineItems: lineItems,
      email: email,
      note: noteParts.join('\n'),
      customAttributes: customAttributes,
      tags: ['devis-box', 'landing-collection-box'],
      acceptAutomaticDiscounts: true,
    };
    if (phone) input.phone = phone;

    const data = await adminGql(DRAFT_ORDER_CREATE, { input: input });
    const payload = data.draftOrderCreate;

    if (payload.userErrors && payload.userErrors.length > 0) {
      res.status(400).json({ error: payload.userErrors.map(function (e) { return e.message; }).join(', ') });
      return;
    }

    res.status(200).json({
      success: true,
      draftOrderName: payload.draftOrder.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
