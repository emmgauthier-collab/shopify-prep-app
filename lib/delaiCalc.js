// lib/delaiCalc.js
// Source unique de verite pour le calcul des delais (jours ouvres + fermetures).
// Reproduit exactement l'algorithme qui vivait auparavant dans les snippets Liquid :
//   rx-business-days.liquid, rx-jours-avant-fermeture.liquid, rx-en-fermeture.liquid
// Utilise a la fois par /api/delai-public.js (affichage site, reference = maintenant)
// et /api/order-delai-webhook.js (reference = date de creation de la commande).

const SHOP_TZ = 'Europe/Paris';

// Retourne la date (YYYY-MM-DD) d'un objet Date, dans le fuseau de la boutique.
function toShopDateString(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date); // en-CA => YYYY-MM-DD
}

// Jour de la semaine (1=lundi ... 7=dimanche), dans le fuseau de la boutique.
function shopDayOfWeek(date) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TZ, weekday: 'short' });
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[fmt.format(date)];
}

function isWeekend(date) {
  const dow = shopDayOfWeek(date);
  return dow === 6 || dow === 7;
}

// periodes: [{ debut: 'YYYY-MM-DD', fin: 'YYYY-MM-DD' }]
function isInClosure(dateStr, periodes) {
  if (!periodes || !periodes.length) return false;
  return periodes.some(function (p) { return dateStr >= p.debut && dateStr <= p.fin; });
}

// Equivalent de rx-en-fermeture.liquid
function estEnFermeture(fromDate, periodes) {
  const today = toShopDateString(fromDate);
  return isInClosure(today, periodes);
}

// Equivalent de rx-jours-avant-fermeture.liquid
// Retourne le nombre de jours ouvres (lun-ven) avant le DEBUT de la prochaine
// fermeture a venir, ou null s'il n'y en a pas. Ne tient pas compte des autres
// fermetures plus lointaines (comme l'original).
function joursAvantProchaineFermeture(fromDate, periodes) {
  const today = toShopDateString(fromDate);
  let nextDebut = null;
  (periodes || []).forEach(function (p) {
    if (p.debut > today) {
      if (nextDebut === null || p.debut < nextDebut) nextDebut = p.debut;
    }
  });
  if (nextDebut === null) return null;

  let compte = 0;
  let cursor = new Date(fromDate.getTime());
  for (let i = 0; i < 120; i++) {
    cursor = new Date(cursor.getTime() + 86400000);
    const dateStr = toShopDateString(cursor);
    if (dateStr === nextDebut) break;
    if (!isWeekend(cursor)) compte += 1;
  }
  return compte;
}

// Equivalent de rx-business-days.liquid
// Ajoute `joursRequis` jours ouvres (lun-ven, hors fermetures) a partir de fromDate.
// Retourne une date au format YYYY-MM-DD.
function addBusinessDays(fromDate, joursRequis, periodes) {
  let compte = 0;
  let cursor = new Date(fromDate.getTime());
  let result = toShopDateString(fromDate);
  for (let i = 0; i < 120; i++) {
    if (compte >= joursRequis) break;
    cursor = new Date(cursor.getTime() + 86400000);
    const dateStr = toShopDateString(cursor);
    let ferme = isWeekend(cursor);
    if (!ferme) ferme = isInClosure(dateStr, periodes);
    if (!ferme) compte += 1;
    result = dateStr;
  }
  return result;
}

const MOIS_FR = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

// Formate une date ISO en francais uniquement (coherent avec le choix d'un
// seul texte pour tous les visiteurs, comme pour les labels de l'interface).
function formatDateLocale(isoDate) {
  const parts = isoDate.split('-');
  const y = parts[0], m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
  return d + ' ' + MOIS_FR[m - 1] + ' ' + y;
}

// Trouve la periode de fermeture "pertinente" pour expliquer un ecart entre
// le nombre de jours ouvres annonce et le delai calendaire reel : soit la
// fermeture en cours, soit la premiere fermeture qui tombe entre fromDate et
// la date calculee (donc silencieusement "avalee" par le calcul de business days).
function periodeConcernee(fromDate, dateResultatISO, periodes) {
  if (!periodes || !periodes.length) return null;
  const today = toShopDateString(fromDate);
  const enCours = periodes.find(function (p) { return today >= p.debut && today <= p.fin; });
  if (enCours) return enCours;
  const traversee = periodes
    .filter(function (p) { return p.debut > today && p.debut <= dateResultatISO; })
    .sort(function (a, b) { return a.debut < b.debut ? -1 : 1; });
  return traversee.length ? traversee[0] : null;
}

// Orchestration complete — equivalent du bloc de logique partage entre
// rxwear-delais.liquid et rx-delai-rush-block.liquid.
//
// options:
//   fromDate       Date  - reference ("maintenant" pour le site, order.created_at pour une commande)
//   delaiNormal    Number
//   delaiRush      Number
//   plancher       Number
//   periodes       [{debut, fin}]
//   rushConfigured Boolean - un rush_product est-il renseigne ?
function calculerDelais(options) {
  const fromDate = options.fromDate;
  const periodes = options.periodes || [];
  let joursNormal = options.delaiNormal;
  const plancher = options.plancher;

  const avantFermeture = joursAvantProchaineFermeture(fromDate, periodes);
  if (avantFermeture !== null && avantFermeture >= plancher && avantFermeture < joursNormal) {
    joursNormal = avantFermeture;
  }

  const enFermetureAujourdhui = estEnFermeture(fromDate, periodes);
  const rushIndisponible = !options.rushConfigured || enFermetureAujourdhui;

  const dateNormaleISO = addBusinessDays(fromDate, joursNormal, periodes);
  const dateRushISO = addBusinessDays(fromDate, options.delaiRush, periodes);

  const fermetureConcernee = periodeConcernee(fromDate, dateNormaleISO, periodes);

  return {
    joursNormalAffiche: joursNormal,
    joursRush: options.delaiRush,
    dateNormaleISO: dateNormaleISO,
    dateRushISO: dateRushISO,
    rushIndisponible: rushIndisponible,
    enFermetureAujourdhui: enFermetureAujourdhui,
    fermetureConcernee: fermetureConcernee,
  };
}

module.exports = {
  toShopDateString: toShopDateString,
  shopDayOfWeek: shopDayOfWeek,
  isWeekend: isWeekend,
  isInClosure: isInClosure,
  estEnFermeture: estEnFermeture,
  joursAvantProchaineFermeture: joursAvantProchaineFermeture,
  addBusinessDays: addBusinessDays,
  formatDateLocale: formatDateLocale,
  periodeConcernee: periodeConcernee,
  calculerDelais: calculerDelais,
};
