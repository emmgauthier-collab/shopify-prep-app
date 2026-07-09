// lib/shopifyAdmin.js
// Acces Shopify Admin API partage entre les endpoints publics/webhook.
const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 300000) return cachedToken;
  const res = await fetch('https://' + SHOP + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error('OAuth failed: ' + res.status);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function adminGql(query, variables) {
  const token = await getToken();
  const r = await fetch('https://' + SHOP + '/admin/api/2025-01/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: query, variables: variables }),
  });
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

const CONFIG_QUERY =
  'query {' +
  '  shop {' +
  '    id' +
  '    currencyCode' +
  '    delaiProduction: metafield(namespace: "custom", key: "delai_production") { value }' +
  '    delaiRush: metafield(namespace: "custom", key: "delai_rush") { value }' +
  '    delaiPlancher: metafield(namespace: "custom", key: "delai_plancher_fermeture") { value }' +
  '    rushProduct: metafield(namespace: "custom", key: "rush_product") { value }' +
  '    vacances: metafield(namespace: "custom", key: "vacances") { value }' +
  '  }' +
  '}';

// Cache court (60s) en memoire du process pour eviter de spammer l'Admin API
// sur du traffic storefront. Les instances serverless sont ephemeres donc ce
// cache n'est qu'un bonus, la vraie protection est le Cache-Control HTTP.
let cachedConfig = null;
let cachedConfigAt = 0;

async function getDelaiConfig(forceFresh) {
  if (!forceFresh && cachedConfig && Date.now() - cachedConfigAt < 60000) return cachedConfig;

  const data = await adminGql(CONFIG_QUERY, {});
  const s = data.shop;

  let periodes = [];
  let vacancesGids = [];
  if (s.vacances && s.vacances.value) {
    try { vacancesGids = JSON.parse(s.vacances.value); } catch (e) { vacancesGids = []; }
    if (vacancesGids.length) {
      const ndata = await adminGql(
        'query($ids:[ID!]!){ nodes(ids:$ids){ ... on Metaobject { id fields { key value } } } }',
        { ids: vacancesGids }
      );
      periodes = (ndata.nodes || []).filter(Boolean).map(function (n) {
        const f = {};
        (n.fields || []).forEach(function (fld) { f[fld.key] = fld.value; });
        return { debut: f.debut, fin: f.fin };
      });
    }
  }

  let rushProductId = null;
  let rushVariantId = null;
  let rushPrice = null;
  let rushCurrency = null;
  let rushTitle = null;
  let rushImage = null;
  if (s.rushProduct && s.rushProduct.value) {
    rushProductId = s.rushProduct.value;
    try {
      const pdata = await adminGql(
        'query($id:ID!){ product(id:$id){ title featuredImage{url} variants(first:1){edges{node{id price}}} } }',
        { id: rushProductId }
      );
      if (pdata.product) {
        rushTitle = pdata.product.title;
        rushImage = pdata.product.featuredImage ? pdata.product.featuredImage.url : null;
        const v = pdata.product.variants.edges[0];
        if (v) { rushVariantId = v.node.id; rushPrice = v.node.price; }
      }
    } catch (e) { /* produit rush introuvable, on ignore */ }
  }

  cachedConfig = {
    shopGid: s.id,
    currencyCode: s.currencyCode || 'EUR',
    delaiProduction: parseInt(s.delaiProduction ? s.delaiProduction.value : '10', 10),
    delaiRush: parseInt(s.delaiRush ? s.delaiRush.value : '3', 10),
    delaiPlancher: parseInt(s.delaiPlancher ? s.delaiPlancher.value : '3', 10),
    periodes: periodes,
    rushProductId: rushProductId,
    rushVariantId: rushVariantId,
    rushPrice: rushPrice,
    rushTitle: rushTitle,
    rushImage: rushImage,
  };
  cachedConfigAt = Date.now();
  return cachedConfig;
}

module.exports = { getToken: getToken, adminGql: adminGql, getDelaiConfig: getDelaiConfig };
