// lib/designPageSync.js — Synchronisation "design signature -> page Shopify".
//
// Logique déclenchée à la demande (bouton "Synchroniser les pages designs" dans
// le back-office), PAS à chaque sauvegarde d'un design. Pour chaque item de la
// galerie (metafield shop.rxwear_gallery.items) avec createPage !== false :
//   - on résout son produit principal + ses "campaignProducts" (les produits sur
//     lesquels ce MEME design est aussi personnalisable — source de vérité déjà
//     saisie manuellement par item, PAS la liste générique par niche) ;
//   - on écrit tout le contenu affiché sur la page dans des metafields de PAGE
//     (namespace rxwear_design) : la page elle-même ne contient aucun HTML en
//     dur, tout vient de sections/rx-design-page.liquid + ces metafields ;
//   - on crée/actualise la Page Shopify (templateSuffix: "rx-design-page") ;
//   - on retro-écrit pageId/pageHandle sur l'item pour rester idempotent.
// Les items avec createPage === false et qui ont déjà une page sont DÉPUBLIÉS
// (jamais supprimés).
const fs = require('fs');
const path = require('path');

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'rxwear.eu';

const GALLERY_NAMESPACE = 'rxwear_gallery';
const GALLERY_KEY = 'items';
const DESIGN_NAMESPACE = 'rxwear_design';
const TEMPLATE_SUFFIX = 'rx-design-page';

// ---------------------------------------------------------------------------
// Client Admin API (même pattern que api/gallery.js / lib/shopifyAdmin.js)
// ---------------------------------------------------------------------------
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
  const data = await res.json();
  if (data.errors) throw new Error('GraphQL: ' + JSON.stringify(data.errors));
  return data;
}

function handleize(str) {
  return (str || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // enlève les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

// ---------------------------------------------------------------------------
// Galerie (lecture/écriture du metafield shop.rxwear_gallery.items)
// ---------------------------------------------------------------------------
async function getGalleryItems() {
  const data = await shopifyGql(`{
    shop { metafield(namespace: "${GALLERY_NAMESPACE}", key: "${GALLERY_KEY}") { id value } }
  }`);
  const raw = data?.data?.shop?.metafield?.value;
  if (!raw) return { items: [], metafieldId: null };
  try { return { items: JSON.parse(raw), metafieldId: data.data.shop.metafield.id }; }
  catch { return { items: [], metafieldId: null }; }
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
      namespace: GALLERY_NAMESPACE,
      key: GALLERY_KEY,
      type: 'json',
      value: JSON.stringify(items),
    }]
  });
  const errors = data?.data?.metafieldsSet?.userErrors;
  if (errors?.length) throw new Error(errors.map(e => e.message).join(', '));
}

// ---------------------------------------------------------------------------
// Definitions des metafields de PAGE (namespace rxwear_design) — bootstrap
// idempotent, à appeler avant toute écriture.
// ---------------------------------------------------------------------------
const DESIGN_FIELD_DEFS = [
  { key: 'eyebrow', name: 'RX Design — Eyebrow', type: 'single_line_text_field' },
  { key: 'description', name: 'RX Design — Description', type: 'multi_line_text_field' },
  { key: 'price_label', name: 'RX Design — Prix affiché', type: 'single_line_text_field' },
  { key: 'image_url', name: 'RX Design — Image', type: 'url' },
  { key: 'cta_url', name: 'RX Design — Lien de personnalisation', type: 'url' },
  { key: 'reviews_url', name: 'RX Design — Lien avis produit', type: 'url' },
  { key: 'alt_products', name: 'RX Design — Produits alternatifs', type: 'json' },
];

async function ensureDesignFieldDefinitions() {
  for (const def of DESIGN_FIELD_DEFS) {
    const data = await shopifyGql(`
      mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { field message code }
        }
      }
    `, {
      definition: {
        name: def.name,
        namespace: DESIGN_NAMESPACE,
        key: def.key,
        type: def.type,
        ownerType: 'PAGE',
      }
    });
    const errors = data?.data?.metafieldDefinitionCreate?.userErrors;
    if (errors?.length) {
      const alreadyExists = errors.every(e => e.code === 'TAKEN' || /already exists|déjà/i.test(e.message));
      if (!alreadyExists) throw new Error(`Définition ${def.key}: ` + errors.map(e => e.message).join(', '));
    }
  }
}

// ---------------------------------------------------------------------------
// Résolution produits (titre, image, prix) par handle — un seul aller-retour
// pour tous les handles nécessaires à ce run.
// ---------------------------------------------------------------------------
async function resolveProductsByHandles(handles) {
  const unique = [...new Set(handles.filter(Boolean))];
  const map = {};
  if (!unique.length) return map;

  // L'API limite la taille des requêtes `query:` — on découpe par lots de 25.
  const chunkSize = 25;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const q = chunk.map(h => `handle:'${h}'`).join(' OR ');
    const data = await shopifyGql(`
      query($q: String!) {
        products(first: 50, query: $q) {
          edges {
            node {
              id title handle
              featuredImage { url }
              variants(first: 50) { edges { node { id price } } }
            }
          }
        }
      }
    `, { q });
    (data?.data?.products?.edges || []).forEach(({ node }) => { map[node.handle] = node; });
  }
  return map;
}

function variantPrice(product, variantId) {
  if (!product) return null;
  const edges = product.variants?.edges || [];
  if (variantId) {
    const numeric = String(variantId).replace('gid://shopify/ProductVariant/', '');
    const match = edges.find(({ node: v }) => v.id.endsWith(`/${numeric}`));
    if (match) return match.node.price;
  }
  return edges[0]?.node?.price || null;
}

function formatPrice(price) {
  if (!price) return null;
  const n = Number(price);
  if (Number.isNaN(n)) return null;
  return `${n.toFixed(2).replace('.', ',')} €`;
}

function deepLink(productHandle, variantId, customizationId) {
  const params = new URLSearchParams();
  if (variantId) params.set('variant', String(variantId).replace('gid://shopify/ProductVariant/', ''));
  if (customizationId) params.set('customization-id', customizationId);
  const qs = params.toString();
  return `https://${STORE_DOMAIN}/products/${productHandle}${qs ? '?' + qs : ''}`;
}

function reviewsUrl(productHandle) {
  return `https://${STORE_DOMAIN}/products/${productHandle}#judgeme_product_reviews`;
}

const NICHE_EYEBROWS = {
  running: 'Design running',
  cf: 'Design CrossFit / Hyrox',
};

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Construit le PageCreateInput/PageUpdateInput pour un item de galerie donné.
// ---------------------------------------------------------------------------
function buildPageFields(item, productsByHandle) {
  const mainProduct = productsByHandle[item.productHandle];
  const priceLabel = formatPrice(variantPrice(mainProduct, item.variantId));

  const altProducts = (item.campaignProducts || [])
    .filter(cp => cp.productHandle && !(cp.productHandle === item.productHandle && String(cp.variantId) === String(item.variantId)))
    .map(cp => {
      const p = productsByHandle[cp.productHandle];
      if (!p) return null;
      return {
        title: p.title,
        imageUrl: p.featuredImage?.url || null,
        url: deepLink(cp.productHandle, cp.variantId, cp.customizationId || item.customizationId),
      };
    })
    .filter(Boolean);

  const description = (item.pageDescription || '').trim();
  const seoDescription = description
    ? stripHtml(description).slice(0, 155)
    : `Découvrez le design "${item.title}" et personnalisez-le vous-même sur RX WEAR — impression à la demande, livraison en France et Belgique.`;

  const metafields = [
    { namespace: DESIGN_NAMESPACE, key: 'eyebrow', type: 'single_line_text_field', value: NICHE_EYEBROWS[item.niche] || 'Design signature' },
    { namespace: DESIGN_NAMESPACE, key: 'description', type: 'multi_line_text_field', value: description },
    { namespace: DESIGN_NAMESPACE, key: 'price_label', type: 'single_line_text_field', value: priceLabel || '' },
    { namespace: DESIGN_NAMESPACE, key: 'image_url', type: 'url', value: item.imageUrl || '' },
    { namespace: DESIGN_NAMESPACE, key: 'cta_url', type: 'url', value: deepLink(item.productHandle, item.variantId, item.customizationId) },
    { namespace: DESIGN_NAMESPACE, key: 'reviews_url', type: 'url', value: item.productHandle ? reviewsUrl(item.productHandle) : '' },
    { namespace: DESIGN_NAMESPACE, key: 'alt_products', type: 'json', value: JSON.stringify(altProducts) },
    { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: `${item.title} — Design personnalisable | RX WEAR` },
    { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: seoDescription },
  // Les metafields avec une valeur vide sont filtrés (Shopify refuse url:"" pour un champ de type url).
  ].filter(m => m.value !== '' && m.value != null);

  return { metafields, priceLabel, altProductsCount: altProducts.length };
}

// ---------------------------------------------------------------------------
// Synchro principale
// ---------------------------------------------------------------------------
async function syncDesignPages() {
  // La création des DÉFINITIONS de metafields est un confort (champs typés/nommés
  // dans l'admin) mais PAS strictement nécessaire pour écrire les valeurs : chaque
  // metafield est envoyé avec son `type` explicite via pageCreate/pageUpdate, qui
  // fonctionne même sans définition préalable. Certaines apps custom n'ont pas le
  // droit d'appeler metafieldDefinitionCreate (ACCESS_DENIED) sans que ça empêche
  // pour autant l'écriture des pages elle-même — on ne bloque donc pas la synchro
  // là-dessus, on remonte juste un avertissement.
  let definitionsWarning = null;
  try {
    await ensureDesignFieldDefinitions();
  } catch (err) {
    definitionsWarning = err.message;
  }

  const { items } = await getGalleryItems();
  if (!items.length) return { created: 0, updated: 0, unpublished: 0, skipped: 0, errors: [], definitionsWarning };

  const handles = new Set();
  items.forEach(item => {
    if (item.createPage === false) return;
    if (item.productHandle) handles.add(item.productHandle);
    (item.campaignProducts || []).forEach(cp => { if (cp.productHandle) handles.add(cp.productHandle); });
  });
  const productsByHandle = await resolveProductsByHandles([...handles]);

  const report = { created: 0, updated: 0, unpublished: 0, skipped: 0, errors: [], definitionsWarning };
  let dirty = false;

  for (const item of items) {
    try {
      if (item.createPage === false) {
        if (item.pageId) {
          await shopifyGql(`
            mutation pageUpdate($id: ID!, $page: PageUpdateInput!) {
              pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } }
            }
          `, { id: item.pageId, page: { isPublished: false } });
          report.unpublished++;
        } else {
          report.skipped++;
        }
        continue;
      }

      if (!item.title || !item.productHandle) { report.skipped++; continue; }

      const { metafields, priceLabel, altProductsCount } = buildPageFields(item, productsByHandle);

      if (item.pageId) {
        const data = await shopifyGql(`
          mutation pageUpdate($id: ID!, $page: PageUpdateInput!) {
            pageUpdate(id: $id, page: $page) {
              page { id handle }
              userErrors { field message }
            }
          }
        `, {
          id: item.pageId,
          page: { title: item.title, templateSuffix: TEMPLATE_SUFFIX, isPublished: true, metafields },
        });
        const errors = data?.data?.pageUpdate?.userErrors;
        if (errors?.length) throw new Error(errors.map(e => e.message).join(', '));
        report.updated++;
      } else {
        const handle = `design-${handleize(item.title)}` || undefined;
        const data = await shopifyGql(`
          mutation pageCreate($page: PageCreateInput!) {
            pageCreate(page: $page) {
              page { id handle }
              userErrors { field message }
            }
          }
        `, {
          page: { title: item.title, handle, templateSuffix: TEMPLATE_SUFFIX, isPublished: true, metafields },
        });
        const errors = data?.data?.pageCreate?.userErrors;
        if (errors?.length) throw new Error(errors.map(e => e.message).join(', '));
        const page = data?.data?.pageCreate?.page;
        item.pageId = page.id;
        item.pageHandle = page.handle;
        item.pageUrl = `https://${STORE_DOMAIN}/pages/${page.handle}`;
        dirty = true;
        report.created++;
      }

      if (!item.pageUrl && item.pageHandle) item.pageUrl = `https://${STORE_DOMAIN}/pages/${item.pageHandle}`;
      item._lastSync = { priceLabel, altProductsCount };
    } catch (err) {
      report.errors.push({ title: item.title || item.customizationId, message: err.message });
    }
  }

  if (dirty) await saveGalleryItems(items);

  return report;
}

// ---------------------------------------------------------------------------
// Installation du template natif (section + JSON) sur le thème LIVE.
// Lit les fichiers du repo (déployés avec la fonction Vercel) et les pousse
// via themeFilesUpsert — idempotent, peut être relancé sans risque.
// ---------------------------------------------------------------------------
async function installDesignTemplate() {
  const sectionPath = path.join(process.cwd(), 'sections', 'rx-design-page.liquid');
  const templatePath = path.join(process.cwd(), 'templates', 'page.rx-design-page.json');

  const sectionBody = fs.readFileSync(sectionPath, 'utf8');
  const templateBody = fs.readFileSync(templatePath, 'utf8');

  const themeData = await shopifyGql(`{
    themes(first: 1, roles: [MAIN]) { edges { node { id name } } }
  }`);
  const theme = themeData?.data?.themes?.edges?.[0]?.node;
  if (!theme) throw new Error('Thème principal introuvable');

  const data = await shopifyGql(`
    mutation themeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
      themeFilesUpsert(themeId: $themeId, files: $files) {
        upsertedThemeFiles { filename }
        userErrors { field message }
      }
    }
  `, {
    themeId: theme.id,
    files: [
      { filename: 'sections/rx-design-page.liquid', body: { type: 'TEXT', value: sectionBody } },
      { filename: 'templates/page.rx-design-page.json', body: { type: 'TEXT', value: templateBody } },
    ],
  });
  const errors = data?.data?.themeFilesUpsert?.userErrors;
  if (errors?.length) throw new Error(errors.map(e => e.message).join(', '));

  return { themeId: theme.id, themeName: theme.name, files: data.data.themeFilesUpsert.upsertedThemeFiles };
}

module.exports = { syncDesignPages, installDesignTemplate, ensureDesignFieldDefinitions };
