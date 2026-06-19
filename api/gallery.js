// api/gallery.js — Proxy Vercel pour la galerie inspirationnelle RX WEAR
const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD;

const NAMESPACE = 'rxwear_gallery';
const KEY = 'items';

// Clés possibles pour l'image teeinblue dans les customAttributes
const IMAGE_KEYS = ['_customization_image', 'customization-image', 'customization_image', 'Customization Image'];
const CUSTID_KEYS = ['_customization_id', 'customization-id', 'customization_id'];

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

async function shopifyGql(query, variables = {}) {
  const token = await getToken();
  const res = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

function extractImage(customAttributes) {
  return customAttributes?.find(a => IMAGE_KEYS.includes(a.key))?.value || null;
}

function extractCustId(customAttributes) {
  return customAttributes?.find(a => CUSTID_KEYS.includes(a.key))?.value || null;
}

// Déduire la niche depuis les tags du produit
function detectNiche(productTags) {
  if (!productTags) return null;
  const tags = Array.isArray(productTags) ? productTags : [productTags];
  const tagsLower = tags.map(t => t.toLowerCase());
  if (tagsLower.includes('customrunning')) return 'running';
  if (tagsLower.includes('custom')) return 'cf';
  return null;
}

async function getGalleryItems() {
  const data = await shopifyGql(`{
    shop {
      metafield(namespace: "${NAMESPACE}", key: "${KEY}") { id value }
    }
  }`);
  const raw = data?.data?.shop?.metafield?.value;
  if (!raw) return { items: [], metafieldId: null };
  try {
    return { items: JSON.parse(raw), metafieldId: data.data.shop.metafield.id };
  } catch {
    return { items: [], metafieldId: null };
  }
}

async function saveGalleryItems(items) {
  const shopData = await shopifyGql(`{ shop { id } }`);
  const shopId = shopData?.data?.shop?.id;
  if (!shopId) throw new Error('Shop ID introuvable');

  const data = await shopifyGql(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId: shopId,
      namespace: NAMESPACE,
      key: KEY,
      type: 'json',
      value: JSON.stringify(items),
    }]
  });

  const errors = data?.data?.metafieldsSet?.userErrors;
  if (errors?.length) throw new Error(errors.map(e => e.message).join(', '));
  return data?.data?.metafieldsSet?.metafields?.[0];
}

// Récupérer commandes avec images — filtre tag:custom OR tag:customrunning
async function fetchOrdersWithImages(cursor = null) {
  const data = await shopifyGql(`
    query($first: Int!, $after: String) {
      orders(first: $first, after: $after, query: "tag:custom", sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id name createdAt
            lineItems(first: 50) {
              edges {
                node {
                  id title quantity
                  customAttributes { key value }
                  variant {
                    id title
                    product { id handle title tags }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { first: 250, after: cursor || null });

  const orders = data?.data?.orders?.edges?.map(e => e.node) || [];

  const filtered = orders
    .map(order => ({
      ...order,
      lineItems: {
        edges: order.lineItems.edges
          .filter(({ node: li }) => extractImage(li.customAttributes))
          .map(({ node: li }) => ({
            node: {
              ...li,
              _imageUrl: extractImage(li.customAttributes),
              _customizationId: extractCustId(li.customAttributes),
              _niche: detectNiche(li.variant?.product?.tags),
              _variantId: li.variant?.id ? li.variant.id.replace('gid://shopify/ProductVariant/', '') : null,
              _variantTitle: li.variant?.title || null,
            }
          }))
      }
    }))
    .filter(o => o.lineItems.edges.length > 0);

  console.log(`fetchOrders: ${orders.length} commandes scannées, ${filtered.length} avec images`);

  return {
    orders: filtered,
    pageInfo: data?.data?.orders?.pageInfo,
    debug: {
      totalOrders: orders.length,
      ordersWithImages: filtered.length,
      sampleAttrs: orders[0]?.lineItems?.edges?.[0]?.node?.customAttributes || [],
    }
  };
}

// Version sans filtre — debug
async function fetchAllOrdersWithImages(cursor = null) {
  const data = await shopifyGql(`
    query($first: Int!, $after: String) {
      orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id name createdAt
            lineItems(first: 20) {
              edges {
                node {
                  id title quantity
                  customAttributes { key value }
                  variant {
                    id title
                    product { id handle title tags }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { first: 30, after: cursor || null });

  const orders = data?.data?.orders?.edges?.map(e => e.node) || [];

  const filtered = orders
    .map(order => ({
      ...order,
      lineItems: {
        edges: order.lineItems.edges
          .filter(({ node: li }) => extractImage(li.customAttributes))
          .map(({ node: li }) => ({
            node: {
              ...li,
              _imageUrl: extractImage(li.customAttributes),
              _customizationId: extractCustId(li.customAttributes),
              _niche: detectNiche(li.variant?.product?.tags),
              _variantId: li.variant?.id ? li.variant.id.replace('gid://shopify/ProductVariant/', '') : null,
              _variantTitle: li.variant?.title || null,
            }
          }))
      }
    }))
    .filter(o => o.lineItems.edges.length > 0);

  const allAttrs = orders.flatMap(o => o.lineItems.edges.flatMap(e => e.node.customAttributes || []));
  const uniqueKeys = [...new Set(allAttrs.map(a => a.key))];

  return {
    orders: filtered,
    pageInfo: data?.data?.orders?.pageInfo,
    debug: {
      totalOrders: orders.length,
      ordersWithImages: filtered.length,
      allUniqueAttrKeys: uniqueKeys,
      sampleAttrs: orders[0]?.lineItems?.edges?.[0]?.node?.customAttributes || [],
    }
  };
}


const ICONS_KEY = 'tag_icons';

// Récupérer les icônes de tags depuis le metafield shop
async function getTagIcons() {
  const data = await shopifyGql(`{
    shop {
      metafield(namespace: "${NAMESPACE}", key: "${ICONS_KEY}") { id value }
    }
  }`);
  const raw = data?.data?.shop?.metafield?.value;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Sauvegarder les icônes de tags
async function saveTagIcons(icons) {
  const shopData = await shopifyGql(`{ shop { id } }`);
  const shopId = shopData?.data?.shop?.id;
  if (!shopId) throw new Error('Shop ID introuvable');

  const data = await shopifyGql(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId: shopId,
      namespace: NAMESPACE,
      key: ICONS_KEY,
      type: 'json',
      value: JSON.stringify(icons),
    }]
  });

  const errors = data?.data?.metafieldsSet?.userErrors;
  if (errors?.length) throw new Error(errors.map(e => e.message).join(', '));
  return data?.data?.metafieldsSet?.metafields?.[0];
}

// Upload d'un fichier image vers Shopify Files (base64 -> staged upload -> fileCreate)
async function uploadIconFile(base64Data, filename, mimeType) {
  // 1. Décoder le base64 et obtenir la taille
  const buffer = Buffer.from(base64Data, 'base64');
  const fileSize = buffer.length.toString();

  // 2. Créer l'upload staged
  const stagedData = await shopifyGql(`
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `, {
    input: [{
      filename: filename,
      mimeType: mimeType,
      fileSize: fileSize,
      httpMethod: 'POST',
      resource: 'IMAGE',
    }]
  });

  const stagedErrors = stagedData?.data?.stagedUploadsCreate?.userErrors;
  if (stagedErrors?.length) throw new Error(stagedErrors.map(e => e.message).join(', '));

  const target = stagedData?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error('Pas de cible de staged upload');

  // 3. Construire le FormData et uploader le fichier vers le staged URL
  const formData = new FormData();
  target.parameters.forEach(p => formData.append(p.name, p.value));
  formData.append('file', new Blob([buffer], { type: mimeType }), filename);

  const uploadRes = await fetch(target.url, { method: 'POST', body: formData });
  if (!uploadRes.ok) throw new Error(`Upload staged échoué: ${uploadRes.status}`);

  // 4. Enregistrer le fichier dans Shopify avec fileCreate
  const fileData = await shopifyGql(`
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image { url }
          }
        }
        userErrors { field message }
      }
    }
  `, {
    files: [{
      originalSource: target.resourceUrl,
      contentType: 'IMAGE',
    }]
  });

  const fileErrors = fileData?.data?.fileCreate?.userErrors;
  if (fileErrors?.length) throw new Error(fileErrors.map(e => e.message).join(', '));

  const file = fileData?.data?.fileCreate?.files?.[0];
  if (!file) throw new Error('Création de fichier échouée');

  // Le fichier peut être en cours de traitement (UPLOADED -> READY), on poll un peu
  let imageUrl = file.image?.url || null;
  if (!imageUrl && file.id) {
    for (let i = 0; i < 5 && !imageUrl; i++) {
      await new Promise(r => setTimeout(r, 800));
      const checkData = await shopifyGql(`
        query($id: ID!) {
          node(id: $id) {
            ... on MediaImage { image { url } fileStatus }
          }
        }
      `, { id: file.id });
      imageUrl = checkData?.data?.node?.image?.url || null;
    }
  }

  if (!imageUrl) throw new Error('Image pas encore prête, réessaie dans quelques secondes');
  return imageUrl;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const password = req.headers['x-app-password'];
  if (!APP_PASSWORD || !password || password !== APP_PASSWORD) {
    res.status(401).json({ error: 'Unauthorized' }); return;
  }

  try {
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const { action, items, cursor } = body;

    if (req.method === 'GET' || action === 'get') {
      res.status(200).json(await getGalleryItems()); return;
    }
    if (action === 'save') {
      if (!Array.isArray(items)) { res.status(400).json({ error: 'items doit être un tableau' }); return; }
      res.status(200).json({ ok: true, metafield: await saveGalleryItems(items) }); return;
    }
    if (action === 'fetchOrders') {
      res.status(200).json(await fetchOrdersWithImages(cursor || null)); return;
    }
    if (action === 'fetchOrdersAll') {
      res.status(200).json(await fetchAllOrdersWithImages(cursor || null)); return;
    }

    if (action === 'getTagIcons') {
      res.status(200).json({ icons: await getTagIcons() }); return;
    }

    if (action === 'saveTagIcon') {
      const { tag, imageUrl } = body;
      if (!tag || !imageUrl) { res.status(400).json({ error: 'tag et imageUrl requis' }); return; }
      const icons = await getTagIcons();
      icons[tag] = imageUrl;
      await saveTagIcons(icons);
      res.status(200).json({ ok: true, icons }); return;
    }

    if (action === 'removeTagIcon') {
      const { tag } = body;
      if (!tag) { res.status(400).json({ error: 'tag requis' }); return; }
      const icons = await getTagIcons();
      delete icons[tag];
      await saveTagIcons(icons);
      res.status(200).json({ ok: true, icons }); return;
    }

    if (action === 'uploadIcon') {
      const { tag, base64Data, filename, mimeType } = body;
      if (!tag || !base64Data || !filename) { res.status(400).json({ error: 'tag, base64Data et filename requis' }); return; }
      const imageUrl = await uploadIconFile(base64Data, filename, mimeType || 'image/png');
      const icons = await getTagIcons();
      icons[tag] = imageUrl;
      await saveTagIcons(icons);
      res.status(200).json({ ok: true, imageUrl, icons }); return;
    }

    res.status(400).json({ error: `Action inconnue: ${action}` });
  } catch (err) {
    console.error('Gallery API error:', err);
    res.status(500).json({ error: err.message });
  }
}
