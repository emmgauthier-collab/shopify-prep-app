// api/delai-public.js — Endpoint PUBLIC (pas de mot de passe) consomme par le
// theme Shopify en fetch cote client. Remplace la logique qui vivait avant
// dans les snippets Liquid rx-business-days / rx-jours-avant-fermeture / rx-en-fermeture.
const { calculerDelais, formatDateLocale } = require('../lib/delaiCalc.js');
const { getDelaiConfig } = require('../lib/shopifyAdmin.js');

const ALLOWED_ORIGINS = [
  'https://rxwear.fr',
  'https://www.rxwear.fr',
  'https://rxwear.eu',
  'https://www.rxwear.eu',
  'https://rxwear.be',
  'https://therxshop.myshopify.com',
  'https://rxwearshop.myshopify.com',
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const locale = (req.query.locale || 'fr').toLowerCase();
    const config = await getDelaiConfig(false);

    const r = calculerDelais({
      fromDate: new Date(),
      delaiNormal: config.delaiProduction,
      delaiRush: config.delaiRush,
      plancher: config.delaiPlancher,
      periodes: config.periodes,
      rushConfigured: !!config.rushProductId,
    });

    // Cache CDN 2 minutes, avec revalidation en arriere-plan jusqu'a 5 minutes.
    // Protege l'Admin API Shopify du trafic storefront.
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

    res.status(200).json({
      joursNormal: r.joursNormalAffiche,
      joursRush: r.joursRush,
      dateNormaleISO: r.dateNormaleISO,
      dateRushISO: r.dateRushISO,
      dateNormaleLabel: formatDateLocale(r.dateNormaleISO, locale),
      dateRushLabel: formatDateLocale(r.dateRushISO, locale),
      rushIndisponible: r.rushIndisponible,
      enFermetureAujourdhui: r.enFermetureAujourdhui,
      rush: config.rushProductId ? {
        variantId: config.rushVariantId,
        price: config.rushPrice,
        title: config.rushTitle,
        image: config.rushImage,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
