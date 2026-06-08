// api/gallery.js — Proxy Vercel pour la galerie inspirationnelle RX WEAR
const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD;

const NAMESPACE = 'rxwear_gallery';
const KEY = 'items';

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

// Lire les items de galerie depuis le metafield shop
async function getGalleryItems() {
  const data = await shopifyGql(`{
    shop {
      metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
        id
        value
      }
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

// Sauvegarder les items dans le metafield shop
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

// Récupérer les commandes avec des images teeinblue
// L'image est dans customAttributes._customization_image (ligne de commande)
// Le customization_id est dans customAttributes._customization_id
async function fetchOrdersWithImages(cursor = null) {
  // Pas de filtre status:any — on prend toutes les commandes (ouvertes + fermées)
  // On utilise la query vide pour tout récupérer, ou on filtre par tag teeinblue si dispo
  const data = await shopifyGql(`
    query($first: Int!, $after: String) {
      orders(first: $first, after: $after, query: "tag:custom", sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  quantity
                  customAttributes { key value }
                  variant {
                    id
                    title
                    product { id handle title }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, {
    first: 50,
    after: cursor || null,
  });

  const orders = data?.data?.orders?.edges?.map(e => e.node) || [];

  // Filtrer les line items avec image teeinblue
  const filtered = orders
    .map(order => ({
      ...order,
      lineItems: {
        edges: order.lineItems.edges.filter(({ node: li }) => {
          const imgAttr = li.customAttributes?.find(
            a => a.key === '_customization_image' || a.key === 'customization-image'
          );
          return imgAttr?.value;
        })
      }
    }))
    .filter(o => o.lineItems.edges.length > 0);

  // Debug : log le nombre total et filtré
  console.log(`fetchOrders: ${orders.length} commandes total, ${filtered.length} avec images teeinblue`);
  if (orders.length > 0 && filtered.length === 0) {
    // Log les clés custom attributes pour debug
    const sample = orders[0]?.lineItems?.edges?.[0]?.node;
    if (sample) {
      console.log('Sample line item customAttributes:', JSON.stringify(sample.customAttributes));
    }
  }

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


// Version sans filtre tag — pour debug et découverte des vraies clés
async function fetchAllOrdersWithImages(cursor = null) {
  const data = await shopifyGql(`
    query($first: Int!, $after: String) {
      orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            lineItems(first: 20) {
              edges {
                node {
                  id
                  title
                  quantity
                  customAttributes { key value }
                  variant {
                    id
                    title
                    product { id handle title }
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

  // Chercher les images avec toutes les variantes de clé possibles
  const IMAGE_KEYS = ['_customization_image', 'customization-image', 'Customization Image', 'customization_image'];
  const CUSTID_KEYS = ['_customization_id', 'customization-id', 'customization_id'];

  const filtered = orders
    .map(order => ({
      ...order,
      lineItems: {
        edges: order.lineItems.edges.filter(({ node: li }) => {
          return li.customAttributes?.some(a => IMAGE_KEYS.includes(a.key) && a.value);
        })
      }
    }))
    .filter(o => o.lineItems.edges.length > 0);

  const allAttrs = orders.flatMap(o => o.lineItems.edges.flatMap(e => e.node.customAttributes || []));
  const uniqueKeys = [...new Set(allAttrs.map(a => a.key))];

  console.log(`fetchAllOrders: ${orders.length} commandes, ${filtered.length} avec images, clés uniques:`, uniqueKeys);

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const password = req.headers['x-app-password'];
  if (!APP_PASSWORD || !password || password !== APP_PASSWORD) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const { action, items, cursor } = body;

    if (req.method === 'GET' || action === 'get') {
      const result = await getGalleryItems();
      res.status(200).json(result);
      return;
    }

    if (action === 'save') {
      if (!Array.isArray(items)) {
        res.status(400).json({ error: 'items doit être un tableau' });
        return;
      }
      const result = await saveGalleryItems(items);
      res.status(200).json({ ok: true, metafield: result });
      return;
    }

    if (action === 'fetchOrders') {
      const result = await fetchOrdersWithImages(cursor || null);
      res.status(200).json(result);
      return;
    }

    if (action === 'fetchOrdersAll') {
      const result = await fetchAllOrdersWithImages(cursor || null);
      res.status(200).json(result);
      return;
    }

    res.status(400).json({ error: `Action inconnue: ${action}` });
  } catch (err) {
    console.error('Gallery API error:', err);
    res.status(500).json({ error: err.message });
  }
}
