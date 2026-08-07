// api/create-draft-order.js — Endpoint PUBLIC (pas de mot de passe), consommé par la
// section "Commande groupée" de la landing box du thème Shopify (bouton "Demander un devis").
// Crée un Draft Order via l'Admin API. Le devis est ensuite traité manuellement dans
// Shopify Admin > Commandes > Brouillons (pas de back-office custom, décision assumée) :
// on ne renvoie donc jamais l'invoiceUrl au client, pour garder une revue humaine avant paiement.
//
// Les logos (front/dos) arrivent en data URL base64 depuis le front. On ne les stocke JAMAIS
// tels quels dans les customAttributes du draft order : Shopify plafonne la somme de toutes
// les customAttributes à 64 Ko, et un SVG un peu chargé dépasse vite cette limite une fois
// encodé en base64. On les uploade donc vers les Fichiers Shopify (Admin > Contenu > Fichiers)
// et on ne garde que l'URL courte du fichier en attribut.
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

// Taille brute max acceptée par logo, avant même de tenter l'upload (garde-fou indépendant
// de la limite des customAttributes — ici pour éviter d'envoyer un fichier énorme à Shopify).
const MAX_LOGO_BYTES = 8 * 1024 * 1024; // 8 Mo

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

const STAGED_UPLOADS_CREATE =
  'mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {' +
  '  stagedUploadsCreate(input: $input) {' +
  '    stagedTargets { url resourceUrl parameters { name value } }' +
  '    userErrors { field message }' +
  '  }' +
  '}';

const FILE_CREATE =
  'mutation fileCreate($files: [FileCreateInput!]!) {' +
  '  fileCreate(files: $files) {' +
  '    files {' +
  '      id' +
  '      fileStatus' +
  '      ... on GenericFile { url }' +
  '      ... on MediaImage { image { url } }' +
  '    }' +
  '    userErrors { field message }' +
  '  }' +
  '}';

const GET_FILE =
  'query getFile($id: ID!) {' +
  '  node(id: $id) {' +
  '    ... on GenericFile { url fileStatus }' +
  '    ... on MediaImage { fileStatus image { url } }' +
  '  }' +
  '}';

function parseDataUrl(dataUrl) {
  var match = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl || '');
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function extractFileUrl(file) {
  if (!file) return null;
  return file.url || (file.image && file.image.url) || null;
}

// Uploade un logo (data URL) vers les Fichiers Shopify et renvoie son URL publique.
// Renvoie null si aucun logo fourni. Lève une erreur explicite si l'upload échoue,
// mais n'attend jamais indéfiniment le traitement final du fichier (quelques relances
// courtes seulement, sinon on renvoie le lien vers la fiche fichier même si l'URL
// n'est pas encore disponible).
async function uploadLogoToFiles(dataUrl, filename) {
  if (!dataUrl) return null;
  var parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error('logo : format de données invalide (data URL attendue)');
  if (parsed.buffer.length > MAX_LOGO_BYTES) {
    throw new Error('logo "' + filename + '" trop volumineux (max ' + (MAX_LOGO_BYTES / 1024 / 1024) + ' Mo)');
  }

  var staged = await adminGql(STAGED_UPLOADS_CREATE, {
    input: [{ resource: 'FILE', filename: filename, mimeType: parsed.mimeType, httpMethod: 'POST' }],
  });
  var stagedErrs = staged.stagedUploadsCreate.userErrors;
  if (stagedErrs && stagedErrs.length) {
    throw new Error('stagedUploadsCreate: ' + stagedErrs.map(function (e) { return e.message; }).join(', '));
  }
  var target = staged.stagedUploadsCreate.stagedTargets[0];

  var form = new FormData();
  target.parameters.forEach(function (p) { form.append(p.name, p.value); });
  form.append('file', new Blob([parsed.buffer], { type: parsed.mimeType }), filename);

  var uploadRes = await fetch(target.url, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    throw new Error('upload du logo échoué (' + uploadRes.status + ')');
  }

  var created = await adminGql(FILE_CREATE, {
    files: [{
      originalSource: target.resourceUrl,
      filename: filename,
      contentType: 'FILE',
      duplicateResolutionMode: 'APPEND_UUID',
    }],
  });
  var createErrs = created.fileCreate.userErrors;
  if (createErrs && createErrs.length) {
    throw new Error('fileCreate: ' + createErrs.map(function (e) { return e.message; }).join(', '));
  }
  var file = created.fileCreate.files[0];

  var url = extractFileUrl(file);
  var attempts = 0;
  while (!url && attempts < 4) {
    await sleep(700);
    var nodeData = await adminGql(GET_FILE, { id: file.id });
    url = extractFileUrl(nodeData.node);
    attempts++;
  }
  // Si le traitement Shopify n'est toujours pas terminé après les relances, on renvoie
  // quand même une référence utile (le fichier existe, il finira par avoir son URL —
  // consultable dans Admin > Contenu > Fichiers) plutôt que d'échouer toute la demande.
  return url || ('Fichier en cours de traitement (id: ' + file.id + ') — voir Admin > Contenu > Fichiers');
}

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

    // Upload des logos AVANT de créer le draft order, pour n'y stocker que des URLs courtes.
    let logoFrontUrl = null;
    let logoBackUrl = null;
    try {
      const boxSlug = (boxName || 'box').toString().slice(0, 40).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      if (logoFront) logoFrontUrl = await uploadLogoToFiles(logoFront, 'logo-avant-' + boxSlug + '.svg');
      if (logoBack) logoBackUrl = await uploadLogoToFiles(logoBack, 'logo-dos-' + boxSlug + '.svg');
    } catch (uploadErr) {
      res.status(400).json({ error: 'Échec de l\'envoi du logo : ' + uploadErr.message });
      return;
    }

    const customAttributes = [];
    if (boxName) customAttributes.push({ key: 'Nom de la box', value: String(boxName).slice(0, 255) });
    if (contactName) customAttributes.push({ key: 'Contact', value: String(contactName).slice(0, 255) });
    if (deliveryDate) customAttributes.push({ key: 'Date de livraison souhaitée', value: String(deliveryDate).slice(0, 255) });
    if (phone) customAttributes.push({ key: 'Téléphone', value: String(phone).slice(0, 50) });
    if (logoFrontUrl) customAttributes.push({ key: 'Logo avant', value: String(logoFrontUrl).slice(0, 500) });
    if (logoBackUrl) customAttributes.push({ key: 'Logo dos', value: String(logoBackUrl).slice(0, 500) });

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
