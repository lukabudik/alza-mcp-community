import type { Product } from "./types.js";

/**
 * Sale detection from Alza listing cards (live-verified 2026-10-06 on alza.cz,
 * 2026-10-13 on alza.sk).
 *
 * There is no "Akce" facet (see docs/gap-analysis.md) and the sale landing
 * pages (/vyprodej -> /mega-slevy/y842.htm, /zbozi-z-druhe-ruky) are
 * marketing hubs with no product grid. Discounts are visible on ordinary
 * category listing cards (`/{categoryId}.htm`) and on promotion listings such
 * as Alza dni (`/…/alza-dni/{id}-e39.htm`) in the price box:
 *
 *  - `.ads-pb__price-value` — the shelf price ("12 490,-", "72,60 €").
 *  - `.ads-pb__original-price--strike` — the crossed-out older price
 *    (e.g. "15 390,-" next to the current "12 490,-"; header "Zlevněno -18 %").
 *  - `.ads-pb__original-price` without `--strike` — a savings amount
 *    ("Ušetříte 100,-", alza.sk "Ušetríte 7,90 €"), so original = current + savings.
 *  - `.ads-pb__header` — the badge ("Super cena", "Zľavnené -6 %", "Cenová bomba").
 *  - `.ads-pb__footer` — the instalment teaser ("Od 2,79 € mesačne").
 *  - `.coupon-block--discountcode` — a promo code ("Kúpiť s kódom ALZADNI15")
 *    whose `.coupon-block__price` is the price after the code; the code's
 *    trailing number is its percent off the shelf price.
 *  - `.coupon-block--applus` — the AlzaPlus+ member price ("Pridať AlzaPlus+ a
 *    kúpiť hneď lacnejšie 269 €"); the shelf price is then the non-member price.
 *
 * The discount % is always computed from these observed prices; the header
 * badge is reported but never trusted for the arithmetic.
 */
export interface RawDealCard {
  priceText: string | null;
  originalPriceText: string | null;
  originalIsStrike: boolean;
  /** `.coupon-block--discountcode .coupon-block__label--code`, e.g. "ALZADNI15". */
  couponCode?: string | null;
  /** `.coupon-block--discountcode .coupon-block__price`: the price with the code. */
  couponPriceText?: string | null;
  /** `.coupon-block--applus .coupon-block__price`: the AlzaPlus+ member price. */
  alzaPlusPriceText?: string | null;
  /** Text of a "-10 % s AlzaPlus+ 134,91 € Bez členstva: 149,90 €" box, when the card has one. */
  memberText?: string | null;
  badgeText?: string | null;
  monthlyText?: string | null;
  /** `.avlVal` stock line; "Rozbalené - na sklade 2 ks" marks an opened-box item. */
  availabilityText?: string | null;
}

export type Condition = "opened" | "used";

/**
 * Previously sold goods (alza.sk 2026-10-14): the stock line starts with
 * "Rozbalené" (opened box) or "Zánovné"/"Použité" (used), and the price box shows
 * "Nový 165 €" (the price new) instead of a crossed-out price or savings. That
 * figure is a reference to a different, new item, not a discount.
 */
export function conditionOf(card: Pick<RawDealCard, "availabilityText" | "originalPriceText">): Condition | undefined {
  const stock = card.availabilityText ?? "";
  if (/^\s*Rozbalen/i.test(stock)) return "opened";
  if (/^\s*(Zánovn|Použit)/i.test(stock)) return "used";
  if (/^\s*Nov[ýy]\s/i.test(card.originalPriceText ?? "")) return "used";
  return undefined;
}

/** Price fields of one deal. Amounts are in the storefront currency. */
export interface DealPricing {
  /** Shelf price (`.ads-pb__price-value`), the same as `priceList`. */
  price: number;
  /** Older reference price: the crossed-out price, or `price + savings` for an "Ušetríte" box. */
  originalPrice?: number;
  /** Shelf savings: parsed "Ušetríte"/"Ušetříte" amount, or `priceOriginal - priceList`. */
  savings?: number;
  /** Discount of `priceNow` against the highest reference price (`originalPrice`, else `priceList`). */
  discountPercent: number;
  /** Lowest price anyone can pay: the promo-code price when there is a code, else the shelf price. */
  priceNow: number;
  priceList: number;
  /** The crossed-out older price, when the card shows one. */
  priceOriginal: number | null;
  promoCode: string | null;
  promoPercent: number | null;
  /** Upper-cased badge text, e.g. "SUPER CENA", "ZĽAVNENÉ -6 %". */
  badge: string | null;
  monthlyFrom: number | null;
  alzaPlusPrice: number | null;
  nonMemberPrice: number | null;
  /** "opened" / "used" for previously sold goods, else null. Such deals are not comparable with new goods. */
  condition: Condition | null;
  /** Price of the same product new, for `condition` goods; else null. */
  newPrice: number | null;
  /**
   * `priceNow ≈ priceList × (1 − promoPercent/100)`, checked when a promo code
   * and its percent are known; `ok: false` flags a card whose numbers do not add up.
   */
  priceCheck: { expected: number; ok: boolean } | null;
}

export type Deal = Omit<Product, "price" | "originalPrice" | "priceNow" | "promoCode" | "promoPercent" | "alzaPlusPrice" | "condition" | "newPrice"> & DealPricing & { reviewCount?: number };

/** Leaf categories scanned when no `category_id` is given (ids are shared by alza.cz and alza.sk; verified 2026-10-06 / 2026-10-13). */
export const DEFAULT_DEAL_CATEGORIES: ReadonlyArray<{ id: number; name: string }> = [
  { id: 18843445, name: "Mobilní telefony" },
  { id: 18842920, name: "Notebooky" },
  { id: 18842948, name: "Monitory" },
  { id: 18849604, name: "Televize" },
  { id: 18843602, name: "Sluchátka" },
];

export function parseCzPrice(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/ /g, " ").match(/(\d[\d\s]*?)\s*,-/);
  if (!m) return undefined;
  const n = Number((m[1] ?? "").replace(/\s+/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * First money amount in Alza price text, CZ or SK format: "12 490,-",
 * "1 656 Kč", "1 234,50 €", "88,32 €", "112 €". Thousands are separated by a
 * space, a no-break space or a narrow no-break space; decimals by a comma.
 * Text without a currency marker ("Zľavnené -6 %") yields undefined.
 */
export function parseMoney(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/(\d{1,3}(?:[   ]\d{3})+|\d+)(?:,(\d{1,2}))?[   ]*(?:,-|€|Kč|EUR|CZK)/);
  if (!m) return undefined;
  const n = Number((m[1] ?? "").replace(/[   ]/g, "") + (m[2] ? `.${m[2]}` : ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Resolve current/original price from observed card text; undefined when the card is not discounted. */
export function computeDeal(card: RawDealCard): { price: number; originalPrice: number; savings: number; discountPercent: number } | undefined {
  const price = parseMoney(card.priceText);
  if (price === undefined || !card.originalPriceText) return undefined;
  const orig = parseMoney(card.originalPriceText);
  if (orig === undefined) return undefined;
  const originalPrice = card.originalIsStrike ? orig : round2(price + orig);
  if (originalPrice <= price) return undefined;
  const savings = round2(originalPrice - price);
  const discountPercent = Math.round((savings / originalPrice) * 1000) / 10;
  return { price, originalPrice, savings, discountPercent };
}

/** Percent of a promo code: its trailing number ("ALZADNI15" -> 15). */
export function promoPercentOf(code: string): number | null {
  const m = code.match(/(\d{1,2})$/);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n < 100 ? n : null;
}

/** Amounts in a "-10 % s AlzaPlus+ 134,91 € Bez členstva: 149,90 €" box (SK "členstva", CZ "členství"). */
export function parseMemberText(raw: string | null | undefined): { alzaPlusPrice: number; nonMemberPrice?: number } | undefined {
  if (!raw || !/AlzaPlus\+/.test(raw)) return undefined;
  const [member, nonMember] = raw.split(/Bez člen\S*/);
  const alzaPlusPrice = parseMoney(member?.replace(/-?\d+\s*%/, ""));
  if (alzaPlusPrice === undefined) return undefined;
  const nonMemberPrice = parseMoney(nonMember);
  return { alzaPlusPrice, ...(nonMemberPrice !== undefined ? { nonMemberPrice } : {}) };
}

/**
 * All price fields of one listing card, or undefined when the card shows no
 * discount of any kind (no promo code, no older price, no savings, no
 * AlzaPlus+ price). `currency` sets the sanity-check tolerance: 0.02 for
 * EUR/GBP cents, 1 for whole-crown CZK/HUF prices.
 */
export function parseDealCard(card: RawDealCard, currency: string): DealPricing | undefined {
  const priceList = parseMoney(card.priceText);
  if (priceList === undefined) return undefined;
  const condition = conditionOf(card) ?? null;
  // "Nový 165 €" is the price of a new item, not a crossed-out price or savings.
  const newPrice = condition ? (parseMoney(card.originalPriceText) ?? null) : null;
  const shelf = condition ? undefined : computeDeal(card);
  const priceOriginal = card.originalIsStrike && shelf ? shelf.originalPrice : null;

  const promoCode = card.couponCode?.trim() || null;
  const couponPrice = promoCode ? parseMoney(card.couponPriceText) : undefined;
  const promoPercent = promoCode ? promoPercentOf(promoCode) : null;
  const priceNow = couponPrice !== undefined && couponPrice < priceList ? couponPrice : priceList;

  const member = parseMemberText(card.memberText);
  const alzaPlusPrice = parseMoney(card.alzaPlusPriceText) ?? member?.alzaPlusPrice ?? null;
  const nonMemberPrice = alzaPlusPrice === null ? null : (member?.nonMemberPrice ?? priceList);

  const reference = shelf?.originalPrice ?? newPrice ?? priceList;
  const discountPercent = Math.round(((reference - priceNow) / reference) * 1000) / 10;
  if (discountPercent <= 0 && (alzaPlusPrice === null || alzaPlusPrice >= priceList)) return undefined;

  let priceCheck: DealPricing["priceCheck"] = null;
  if (couponPrice !== undefined && promoPercent !== null) {
    const expected = round2(priceList * (1 - promoPercent / 100));
    const tolerance = currency === "EUR" || currency === "GBP" ? 0.02 : 1;
    priceCheck = { expected, ok: Math.abs(expected - couponPrice) <= tolerance };
  }

  const badge = card.badgeText?.replace(/\s+/g, " ").trim().toUpperCase() || null;
  const monthlyFrom = parseMoney(card.monthlyText) ?? null;

  return {
    price: priceList,
    ...(shelf ? { originalPrice: shelf.originalPrice, savings: shelf.savings } : {}),
    discountPercent: Math.max(0, discountPercent),
    priceNow,
    priceList,
    priceOriginal,
    promoCode,
    promoPercent,
    badge,
    monthlyFrom,
    alzaPlusPrice,
    nonMemberPrice,
    condition,
    newPrice,
    priceCheck,
  };
}

/**
 * Promo-code and AlzaPlus+ prices of a listing card, for every tool that lists
 * cards (search, deals), so the lowest price a buyer can pay is never hidden.
 * Only fields the card actually shows are set; an unreadable or non-lower code
 * price is ignored.
 */
export function payablePrices(card: RawDealCard): { priceNow?: number; promoCode?: string; promoPercent?: number; alzaPlusPrice?: number; condition?: Condition; newPrice?: number } {
  const list = parseMoney(card.priceText);
  const out: { priceNow?: number; promoCode?: string; promoPercent?: number; alzaPlusPrice?: number; condition?: Condition; newPrice?: number } = {};
  const condition = conditionOf(card);
  if (condition) {
    out.condition = condition;
    const nw = parseMoney(card.originalPriceText);
    if (nw !== undefined) out.newPrice = nw;
  }
  const code = card.couponCode?.trim();
  const codePrice = code ? parseMoney(card.couponPriceText) : undefined;
  if (code && codePrice !== undefined && list !== undefined && codePrice < list) {
    out.priceNow = codePrice;
    out.promoCode = code;
    const pct = promoPercentOf(code);
    if (pct !== null) out.promoPercent = pct;
  }
  const plus = parseMoney(card.alzaPlusPriceText) ?? parseMemberText(card.memberText)?.alzaPlusPrice;
  if (plus !== undefined) out.alzaPlusPrice = plus;
  return out;
}

export function compareDeals(a: Deal, b: Deal): number {
  return b.discountPercent - a.discountPercent || (b.savings ?? 0) - (a.savings ?? 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
