import type { Page } from "playwright";
import { assertNotChallenged, assertPageOk, type AlzaBrowser } from "../infra/browser.js";
import { TtlCache } from "../infra/cache.js";
import { NotFoundError, UserError } from "../infra/errors.js";
import { extractJsonLd, findProduct as findJsonLdProduct } from "../infra/jsonld.js";
import { raceDeadline, TOOL_BUDGET_MS } from "../infra/deadline.js";
import { log } from "../infra/logger.js";
import type { AppliedRange, Category, CategoryFilters, FacetGroup, FacetValue, Product, ProductParam, SearchResult } from "./types.js";
import { compareDeals, DEFAULT_DEAL_CATEGORIES, jsonLdPriceText, parseDealCard, payablePrices, type Deal } from "./deals.js";
import { availabilityFields, normalizeAvailability } from "./availability.js";
import { commodityIdFromUrl } from "./reviews.js";

export type SortOrder = "relevance" | "price-asc" | "price-desc" | "rating" | "newest";

export interface SearchOptions {
  query: string;
  limit?: number;
  page?: number;
  sort?: SortOrder;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  categoryId?: number;
  minScreenInches?: number;
  maxScreenInches?: number;
  /** Alza producer/brand ids (from `list_category_filters`'s `brands`). Requires `categoryId`. */
  producerIds?: number[];
  /** Checkbox-type attribute facet selections (from `list_category_filters`, `filterable: true` groups only). Requires `categoryId`. */
  filters?: Array<{ paramId: number; valueId: number }>;
  /**
   * Browse the category's own listing page (`/{categoryId}.htm`, Alza's
   * default "top sellers" order) instead of `/search.htm` — `query` is then
   * ignored. Requires `categoryId`. Internal (PC builder candidate sourcing):
   * `/search.htm?idc=` does not restrict to the category (live-verified
   * 2026-10-06: "psu" in the PSU category returned dog food).
   */
  browse?: boolean;
  /**
   * Slider-type (range) facet selections: `min`/`max` in the facet's own
   * `values[].value` units (from `list_category_filters`). Requires `categoryId`.
   */
  ranges?: RangeFilter[];
}

export interface RangeFilter {
  paramId: number;
  min?: number;
  max?: number;
}

/** A range snapped to a slider facet's real steps (`from`/`to` are step values). */
export interface ResolvedRange {
  paramId: number;
  name: string;
  from: number;
  to: number;
  fromScreenInches?: boolean;
}

interface RawCard {
  code: string | null;
  id: string | null;
  sponsored: boolean;
  name: string | null;
  url: string | null;
  image: string | null;
  priceText: string | null;
  /** `.ads-pb__original-price` text: crossed-out price or "Ušetříte N,-" (see deals.ts). */
  originalPriceText: string | null;
  originalIsStrike: boolean;
  ratingText: string | null;
  reviewCountText: string | null;
  /**
   * Purchasable right now, per the card's CTA (verified 2026-09-12):
   * true = "Do košíku" / "Vybrat variantu" button, false = "Hlídat" (watch)
   * button, null = no CTA found (undetermined). Alza search cards carry no
   * explicit stock attribute.
   */
  inStock: boolean | null;
  /** Deal fields (see deals.ts `RawDealCard`; live-mapped on alza.sk 2026-10-13). */
  couponCode: string | null;
  couponPriceText: string | null;
  alzaPlusPriceText: string | null;
  memberText: string | null;
  badgeText: string | null;
  monthlyText: string | null;
  /** `.avlVal` stock line, e.g. "Na sklade > 5 ks". */
  availabilityText: string | null;
}

/**
 * Card extractor as a function source taking a query root, so it runs both
 * against the live page (`document`) and against the `Boxes` HTML returned
 * by the category page's own `EShopService.svc/Filter` call (parsed with
 * DOMParser — see `Catalog.fetchRangePage`).
 */
export const CARD_EXTRACTOR_FN = `function(root) {
  return Array.from(root.querySelectorAll('.browsingitem')).map(function(card) {
    function txt(sel) {
      var el = card.querySelector(sel);
      return el ? el.textContent.trim().replace(/\\s+/g, ' ') : null;
    }
    function attr(sel, a) {
      var el = card.querySelector(sel);
      return el ? el.getAttribute(a) : null;
    }
    var sample = (card.textContent || '').trim().replace(/\\s+/g, ' ');
    // Rating: the star block's aria-label ("Hodnocení: 4,8 z 5 na základě 4923
    // recenzí" / alza.sk "Hodnotenie: …") is the most reliable source; the
    // card-text fallback must tolerate thousands separators ("4,8 4 923×" —
    // live-verified 2026-10-07: a plain \\d+× missed every product with 1000+
    // reviews).
    var ariaEl = card.querySelector('.star-rating-wrapper[aria-label]');
    var ariaMatch = ariaEl ? (ariaEl.getAttribute('aria-label') || '').match(/(\\d[,.]\\d)\\s*(?:z|\\/)\\s*5/) : null;
    var ratingMatch = sample.match(/(\\d[,.]\\d)\\s*(\\d[\\d\\s\\u00a0]*)×/);
    // Stock signal = the purchase CTA (verified 2026-09-12): "Do košíku" /
    // "Vybrat variantu" = purchasable now, a standalone "Hlídat" button = not
    // purchasable. The "Hlídat dostupnost nebo cenu" watch link appears on
    // every card, so only exact CTA texts are trusted.
    var inStock = null;
    var ctas = Array.from(card.querySelectorAll('a, button')).map(function(e) { return (e.textContent || '').replace(/\\u00a0/g, ' ').trim(); });
    // Slovak equivalents (alza.sk, live-verified 2026-10-07): "Do košíka" /
    // "Vybrať variant" = purchasable, standalone "Strážiť" = watch button.
    if (ctas.some(function(t) { return /Do košíku|Do košíka|Vybrat variantu|Vybrať variant/.test(t); })) inStock = true;
    else if (ctas.some(function(t) { return t === 'Hlídat' || t === 'Strážiť'; })) inStock = false;
    // Coupon blocks (alza.sk 2026-10-13): '--discountcode' carries a promo code
    // and the price with it ("Kúpiť s kódom ALZADNI15 88,32 €"); '--applus'
    // carries the AlzaPlus+ member price with an empty code.
    var couponCode = null, couponPriceText = null, alzaPlusPriceText = null;
    Array.from(card.querySelectorAll('.coupon-block')).forEach(function(b) {
      function bt(sel) {
        var el = b.querySelector(sel);
        var t = el ? el.textContent.trim().replace(/\\s+/g, ' ') : '';
        return t || null;
      }
      if (/coupon-block--applus/.test(b.getAttribute('class') || '')) {
        if (!alzaPlusPriceText) alzaPlusPriceText = bt('.coupon-block__price');
      } else if (!couponCode && bt('.coupon-block__label--code')) {
        couponCode = bt('.coupon-block__label--code');
        couponPriceText = bt('.coupon-block__price');
      }
    });
    // "-10 % s AlzaPlus+ 134,91 € Bez členstva: 149,90 €" box (product-page
    // wording; on listing cards AlzaPlus+ is the '--applus' coupon block).
    var memberEls = Array.from(card.querySelectorAll('div, span')).filter(function(e) {
      var t = e.textContent || '';
      return /AlzaPlus\\+/.test(t) && /Bez člen/.test(t);
    });
    var memberEl = memberEls.length ? memberEls[memberEls.length - 1] : null;
    return {
      code: card.getAttribute('data-code'),
      id: card.getAttribute('data-id'),
      sponsored: !!card.querySelector('.box-recommendation'),
      name: txt('a.name') || txt('.name'),
      url: attr('a.name', 'href') || attr('a[href*=".htm"]', 'href'),
      image: attr('img', 'src') || attr('img', 'data-src'),
      priceText: txt('.ads-pb__price-value') || txt('.price'),
      originalPriceText: txt('.ads-pb__original-price'),
      originalIsStrike: !!card.querySelector('.ads-pb__original-price--strike'),
      ratingText: ariaMatch ? ariaMatch[1] : (ratingMatch ? ratingMatch[1] : null),
      reviewCountText: ratingMatch ? ratingMatch[2].replace(/\\s|\\u00a0/g, '') : null,
      inStock: inStock,
      couponCode: couponCode,
      couponPriceText: couponPriceText,
      alzaPlusPriceText: alzaPlusPriceText,
      memberText: memberEl ? memberEl.textContent.trim().replace(/\\s+/g, ' ') : null,
      badgeText: txt('.ads-pb__header') || null,
      monthlyText: txt('.ads-pb__footer') || null,
      availabilityText: txt('.avlVal') || null
    };
  });
}`;

const CARD_EXTRACTOR = `(${CARD_EXTRACTOR_FN})(document)`;

/**
 * Pagination links for a free-text search. Alza renders page-number anchors
 * that point at category-style pages (e.g. /notebooky/18842920-p2.htm);
 * the `pg=` query parameter on search.htm is IGNORED (verified 2026-09-14:
 * pg=2/3 repeat page 1 exactly, with or without `o=`). We therefore follow
 * the rendered links. Returns {} when the search has no pagination.
 */
const PAGE_URLS_EXTRACTOR = `(function() {
  var anchors = Array.from(document.querySelectorAll('a[href*=".htm"]'));
  var out = {};
  for (var i = 0; i < anchors.length; i++) {
    var text = (anchors[i].textContent || '').replace(/\\s+/g, ' ').trim();
    var href = anchors[i].getAttribute('href') || '';
    var m = href.match(/-p(\\d{1,3})\\.htm$/);
    if (!m) continue;
    var n = parseInt(m[1], 10);
    if (n < 2 || n > 50) continue;
    if (!/^\\d+$/.test(text) || parseInt(text, 10) !== n) continue;
    // Resolve against the page, not the site root: promotion listings live
    // under a path (/monitory-23-a-24/alza-dni/18848792-e39.htm links
    // "18848792-e39-p2.htm", alza.sk 2026-10-13).
    out[String(n)] = new URL(href, location.href).href;
  }
  if (Object.keys(out).length === 0) return out;
  // derive page 1 from the -pN pattern: ".../18842920-p2.htm" -> ".../18842920.htm"
  out["1"] = Object.values(out)[0].replace(/-p\\d+\\.htm$/, '.htm');
  return out;
})()`;

/**
 * True only on Alza's server-rendered "nothing found" search page: no result
 * cards AND the "we didn't find it" sentence (CZ "nenašel", SK "nenašiel").
 * A page whose grid simply has not rendered yet has no such sentence, so the
 * render-race retries below still apply to it.
 */
export const NO_RESULTS_PROBE = `(function() {
  if (document.querySelector('.browsingitem')) return false;
  var text = (document.body && document.body.innerText) || '';
  return /nena(š|s)(el|iel)\\b/i.test(text);
})()`;

/**
 * Page cap for `get_deals` on one category/URL. Pages are followed until one
 * adds no new products; an Alza dni listing of 44 items is 2 pages (alza.sk,
 * 2026-10-13), a category page holds ~24 cards.
 */
const DEAL_MAX_PAGES = 4;

/** Public `get_product` cap on spec rows (unchanged contract). */
const PRODUCT_PARAMS_CAP = 30;
/**
 * Rows scraped per product page. Higher than the public cap so spec-driven
 * consumers (PC builder) still see rows past the 30th — live-verified
 * 2026-10-06: a GPU's "TDP" was row 29 of 30, so the old cap was a cliff edge.
 */
const PRODUCT_PARAMS_SCRAPE_CAP = 80;

export const PRODUCT_PAGE_EXTRACTOR = `(function() {
  var lds = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(function(s) {
    try { return JSON.parse(s.textContent || '{}'); } catch (e) { return null; }
  }).filter(Boolean);
  function findType(t) {
    for (var i = 0; i < lds.length; i++) {
      var b = lds[i];
      if (!b) continue;
      var bt = b['@type'];
      if (bt === t) return b;
      if (Array.isArray(bt) && bt.indexOf(t) >= 0) return b;
      if (b['@graph']) {
        for (var j = 0; j < b['@graph'].length; j++) {
          var g = b['@graph'][j];
          if (g && (g['@type'] === t || (Array.isArray(g['@type']) && g['@type'].indexOf(t) >= 0))) return g;
        }
      }
    }
    return null;
  }
  return {
    title: document.title,
    url: location.href,
    h1: (document.querySelector('h1') || {}).textContent || null,
    product: findType('Product'),
    breadcrumb: findType('BreadcrumbList'),
    // Visible availability line. JSON-LD can say InStock while the page shows
    // "Na objednávku – termín upřesníme" (live 2026-10-08, YUBIK002a10), so the
    // rendered text is the source of truth.
    availabilityText: (function() {
      // The status itself lives in a button span; the rest of .av-container is
      // delivery promos ("Zjistit přesný termín doručení…"), so prefer the span.
      var el = document.querySelector('[data-testid*="availability-availabilityText"]') || document.querySelector('.av-container.availability') || document.querySelector('.av-container');
      var t = el ? (el.textContent || '').replace(/\\u00a0/g, ' ').trim().replace(/\\s+/g, ' ') : '';
      return t || null;
    })(),
    // Promo-code price block ("Kúpiť s kódom ALZADNI15 88,32 €"; alza.sk 2026-10-14)
    // next to the shelf price box. Server-rendered on the product page.
    promoCode: (function() { var e = document.querySelector('.promo-action-prices__discount-code'); return e ? (e.textContent || '').trim() || null : null; })(),
    promoPriceText: (function() { var e = document.querySelector('.promo-action-prices__price'); return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() || null : null; })(),
    shelfPriceText: (function() { var e = document.querySelector('.js-price-box__primary-price__value'); return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() || null : null; })(),
    params: Array.from(document.querySelectorAll('.paramTbl tr, table.paramTbl tr, .productSpecBox tr')).slice(0, ${PRODUCT_PARAMS_SCRAPE_CAP}).map(function(tr) {
      var th = tr.querySelector('th'), td = tr.querySelector('td');
      return { name: th ? th.textContent.trim().replace(/\\s+/g,' ') : '', value: td ? td.textContent.trim().replace(/\\s+/g,' ') : '' };
    }).filter(function(p) { return p.name && p.value; })
  };
})()`;

/** Highest result page `search_products` accepts (the page-link extractor only trusts anchors up to -p50). */
export const MAX_SEARCH_PAGE = 50;

export class Catalog {
  private readonly searchCache = new TtlCache<string, SearchResult>(60 * 1000);
  /** Products with the full (up to PRODUCT_PARAMS_SCRAPE_CAP) spec list. */
  private readonly productCache = new TtlCache<string, Product>(15 * 60 * 1000);
  private readonly productUrlCache = new TtlCache<string, string>(60 * 60 * 1000);
  private readonly categoryCache = new TtlCache<number, Category[]>(24 * 60 * 60 * 1000);

  private readonly dealsCache = new TtlCache<string, { scanned: number; pages: number; partial?: boolean; deals: Deal[]; usedOffers: Deal[] }>(5 * 60 * 1000);
  /** Listing pages already read by `get_deals`, so a retry after a time-budget cut-off only loads what is missing. */
  private readonly dealPageCache = new TtlCache<string, { cards: RawCard[]; pageUrls: Record<string, string> }>(5 * 60 * 1000);

  constructor(private readonly browser: AlzaBrowser) {}

  async searchProducts(opts: SearchOptions): Promise<SearchResult> {
    const hasAttrFilters = (opts.producerIds && opts.producerIds.length > 0) || (opts.filters && opts.filters.length > 0);
    if ((hasAttrFilters || opts.browse || (opts.ranges && opts.ranges.length > 0)) && !opts.categoryId) {
      throw new Error("producer_ids/filters require category_id (attribute facets are category-scoped in Alza's system) — get category_id from list_categories, then call list_category_filters to discover valid filter values");
    }
    const limit = clamp(opts.limit ?? 20, 1, 50);
    const page = Math.max(1, opts.page ?? 1);
    if (opts.minPrice !== undefined && opts.maxPrice !== undefined && opts.minPrice > opts.maxPrice) {
      throw new Error(`min_price (${opts.minPrice}) is greater than max_price (${opts.maxPrice}) — no product can match an inverted price range`);
    }
    // Facet and range searches go through the category-browse path, which ignores the query,
    // so only a plain keyword search needs one.
    if (!opts.browse && !hasAttrFilters && !(opts.ranges && opts.ranges.length > 0) && !opts.query.trim()) {
      throw new Error("query must not be blank — pass search keywords (or use browse with a category)");
    }
    if (page > MAX_SEARCH_PAGE) {
      throw new Error(`page must be at most ${MAX_SEARCH_PAGE} (got ${page}) — Alza renders no more result pages than that`);
    }
    if (opts.producerIds && opts.producerIds.length > 1) {
      throw new Error(
        "producer_ids accepts exactly one brand id per call: Alza has no multi-brand category URL (combined -v{id}-v{id} URLs return a 404 page). Call once per brand and merge the results."
      );
    }
    const cacheKey = JSON.stringify({ ...opts, limit, page });

    // Slider (range) filters, including screen size backed by the category's
    // own diagonal slider when a category is given (live-verified 2026-10-06).
    const rangePlan = await this.planRanges(opts);
    if (rangePlan) {
      return this.searchCache.memoize(cacheKey, () => this.searchWithRanges(opts, rangePlan, limit, page));
    }

    // Keyword search silently ignores an unknown `idc=` (unrelated results);
    // the category-browse and range paths 404 on their own and report it.
    if (opts.categoryId && !hasAttrFilters && !opts.browse) await this.assertCategoryExists(opts.categoryId);

    // Alza's search page ignores server-side sort (verified 2026-09-12) and
    // cards carry no explicit stock attribute, so for price/rating orders we
    // gather candidates from up to sortSweepPages(limit) pages and sort
    // client-side (compareForSort); `in_stock` is enforced from each card's
    // purchase CTA (see RawCard.inStock). An explicit page > 1 keeps the
    // single-page behaviour.
    const sweeping = shouldSweep(opts, page);
    const maxPages = sweeping ? sortSweepPages(limit) : 1;

    return this.searchCache.memoize(cacheKey, async () => {
      const candidates: Product[] = [];
      const seen = new Set<string>();
      let pagesFetched = 0;
      let pageCapacity = 0;
      let lastPage = page;
      // Pagination links resolved from the rendered page-number anchors (see
      // PAGE_URLS_EXTRACTOR); search.htm?pg=N is ignored by Alza.
      let pageLinks: Record<string, string> = {};
      for (let n = page; n < page + maxPages; n++) {
        // Filtered category pages render pagination anchors that drop the
        // -par segments (live-verified 2026-10-03), but `{filteredUrl}-pN.htm`
        // keeps them — so build those URLs instead of following the anchors.
        let target = (hasAttrFilters || opts.browse) && n > 1 ? this.buildSearchUrl(opts, 1).replace(/\.htm$/, `-p${n}.htm`) : pageLinks[String(n)];
        if (!target && n > 1) {
          // Resolve links via the first page (one navigation), then continue.
          const first = await this.fetchSearchPage(opts);
          pagesFetched++;
          pageLinks = { ...pageLinks, ...first.pageUrls };
          target = pageLinks[String(n)];
          if (!target) break; // Alza rendered no such page — be honest, don't guess
        }
        const { cards, pageUrls } = await this.fetchSearchPage(opts, target);
        pagesFetched++;
        pageLinks = { ...pageLinks, ...pageUrls };
        const organic = cards
          .filter((c) => !c.sponsored)
          .map((c) => this.normalizeCard(c))
          .filter((p): p is Product => p !== null);
        pageCapacity = Math.max(pageCapacity, organic.length);
        lastPage = n;
        for (const p of organic) {
          if (seen.has(p.code)) continue;
          seen.add(p.code);
          candidates.push(p);
          this.productUrlCache.set(p.code, p.url);
        }
        // Ran past the end of the results (empty/short page) — no point more.
        if (!sweeping || organic.length === 0) break;
      }

      const products = candidates
        .filter((p) => filterByPrice(p, opts))
        .filter((p) => passesInStock(p, opts.inStock))
        .filter((p) => filterByScreenSize(p, opts))
        .sort((a, b) => compareForSort(a, b, opts.sort))
        .slice(0, limit);

      log.debug("catalog.searchProducts", {
        query: opts.query,
        pages: pagesFetched,
        candidates: candidates.length,
        returned: products.length,
      });

      return {
        query: opts.query,
        total: products.length,
        page,
        pageSize: pageCapacity,
        candidatesScanned: candidates.length,
        hasMore: pageLinks[String(lastPage + 1)] !== undefined,
        ...(pageLinks[String(lastPage + 1)] !== undefined ? { nextPage: lastPage + 1 } : {}),
        products,
      };
    });
  }

  /**
   * Resolve explicit range filters (and, when a category is given, the
   * `min/max_screen_inches` request) against the category's live facet
   * definitions, snapping each bound to a real slider step. Returns null
   * when no server-side range applies (screen size then falls back to the
   * product-name heuristic).
   */
  private async planRanges(opts: SearchOptions): Promise<RangePlan | null> {
    const explicit = opts.ranges ?? [];
    const wantsScreen =
      opts.categoryId !== undefined && (opts.minScreenInches !== undefined || opts.maxScreenInches !== undefined);
    if (explicit.length === 0 && !wantsScreen) return null;
    const categoryId = opts.categoryId as number;
    for (const r of explicit) {
      if (r.min === undefined && r.max === undefined) {
        throw new Error(`range filter for param_id ${r.paramId} needs min and/or max`);
      }
      if (r.min !== undefined && r.max !== undefined && r.min > r.max) {
        throw new Error(`range filter for param_id ${r.paramId}: min (${r.min}) is greater than max (${r.max})`);
      }
    }
    if (
      opts.minScreenInches !== undefined &&
      opts.maxScreenInches !== undefined &&
      opts.minScreenInches > opts.maxScreenInches
    ) {
      throw new Error("min_screen_inches is greater than max_screen_inches");
    }

    let facets: FacetGroup[];
    try {
      facets = (await this.getCategoryFilters(categoryId)).groups;
    } catch (err) {
      // Screen size alone still has the product-name fallback; explicit
      // range filters have none, so surface the failure for those.
      if (explicit.length > 0) throw err;
      log.warn("catalog.planRanges: facets unavailable, screen size falls back to name parsing", {
        categoryId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    const resolved: ResolvedRange[] = [];
    const empty: AppliedRange[] = [];
    for (const r of explicit) {
      const group = facets.find((g) => g.paramId === r.paramId);
      if (!group) {
        throw new Error(`param_id ${r.paramId} is not a facet of category ${categoryId} — call list_category_filters({category_id: ${categoryId}}) for valid ids`);
      }
      if (group.filterMode !== "range") {
        throw new Error(`param_id ${r.paramId} ("${group.name}") is a ${group.renderType} facet — filter it with {param_id, value_id}, not min/max`);
      }
      const snapped = snapRange(group, r.min, r.max);
      if (snapped) resolved.push(snapped);
      else empty.push({ paramId: group.paramId, name: group.name, empty: true });
    }

    let screenServerSide = false;
    if (wantsScreen) {
      const diag = findScreenDiagonalGroup(facets);
      if (diag && !explicit.some((r) => r.paramId === diag.paramId)) {
        screenServerSide = true;
        const snapped = snapScreenInches(diag, opts.minScreenInches, opts.maxScreenInches);
        if (snapped) resolved.push({ ...snapped, fromScreenInches: true });
        else empty.push({ paramId: diag.paramId, name: diag.name, empty: true, fromScreenInches: true });
      }
    }
    if (resolved.length === 0 && empty.length === 0) return null;
    return { resolved, empty, screenServerSide };
  }

  private async searchWithRanges(
    opts: SearchOptions,
    plan: RangePlan,
    limit: number,
    page: number
  ): Promise<SearchResult> {
    const requested: AppliedRange[] = plan.resolved.map((r) => ({
      paramId: r.paramId,
      name: r.name,
      from: r.from,
      to: r.to,
      ...(r.fromScreenInches ? { fromScreenInches: true } : {}),
    }));
    if (plan.empty.length > 0) {
      // A bound with no slider step inside it can't match any product in
      // this category — answer honestly without a page fetch.
      return {
        query: opts.query,
        total: 0,
        page,
        pageSize: 0,
        candidatesScanned: 0,
        products: [],
        appliedRanges: [...requested, ...plan.empty],
      };
    }

    const sweeping = shouldSweep(opts, page);
    const maxPages = sweeping ? sortSweepPages(limit) : 1;
    const candidates: Product[] = [];
    const seen = new Set<string>();
    let applied: AppliedRange[] | undefined;
    let pageCapacity = 0;
    let hasMore = false;
    let lastPage = page;
    for (let n = page; n < page + maxPages; n++) {
      const res = await this.fetchRangePage(opts, plan.resolved, n);
      applied ??= mergeApplied(requested, res.applied);
      const organic = res.cards
        .filter((c) => !c.sponsored)
        .map((c) => this.normalizeCard(c))
        .filter((p): p is Product => p !== null);
      pageCapacity = Math.max(pageCapacity, organic.length);
      lastPage = n;
      hasMore = res.cards.length > 0 && n < Math.ceil(res.count / res.cards.length);
      for (const p of organic) {
        if (seen.has(p.code)) continue;
        seen.add(p.code);
        candidates.push(p);
        this.productUrlCache.set(p.code, p.url);
      }
      if (!sweeping || organic.length === 0) break;
      if (res.cards.length > 0 && n >= Math.ceil(res.count / res.cards.length)) break;
    }

    const products = candidates
      .filter((p) => filterByPrice(p, opts))
      .filter((p) => passesInStock(p, opts.inStock))
      .filter((p) => plan.screenServerSide || filterByScreenSize(p, opts))
      .sort((a, b) => compareForSort(a, b, opts.sort))
      .slice(0, limit);

    log.debug("catalog.searchWithRanges", {
      categoryId: opts.categoryId,
      ranges: plan.resolved.length,
      candidates: candidates.length,
      returned: products.length,
    });

    return {
      query: opts.query,
      total: products.length,
      page,
      pageSize: pageCapacity,
      candidatesScanned: candidates.length,
      hasMore,
      ...(hasMore ? { nextPage: lastPage + 1 } : {}),
      products,
      appliedRanges: applied ?? requested,
    };
  }

  /**
   * One result page of a category with slider (range) filters applied.
   * Mechanism (live-verified 2026-10-06 via a real Playwright mouse drag on
   * /lcd-monitory/18842948.htm): Alza's category page keeps slider state in
   * the URL hash (`#f&cud=0&pg={page}&prod=&par{paramId}={from}--{to}`) and,
   * on load, its own JS POSTs `/Services/EShopService.svc/Filter`, whose JSON
   * reply carries the result cards as `d.Boxes` HTML plus `d.Count`. We let
   * the page build that request (so producer/checkbox path segments are
   * carried over too), wait for the reply, and extract cards from `Boxes`
   * instead of the DOM (the DOM is not cleared on an empty reply). The
   * request body is read back to confirm the ranges were really applied.
   */
  private async fetchRangePage(
    opts: SearchOptions,
    ranges: ResolvedRange[],
    page: number
  ): Promise<{ cards: RawCard[]; count: number; applied: AppliedRange[] }> {
    const url =
      buildFilteredCategoryUrl(this.browser.locale.baseUrl, opts.categoryId as number, opts.producerIds, opts.filters) +
      buildRangeHash(ranges, page);
    log.debug("catalog.fetchRangePage", { url });
    return this.browser.withPage(async (p) => {
      const responseP = p.waitForResponse(
        (r) => isFilterCallUrl(r.url()) && r.request().method() === "POST",
        { timeout: RANGE_FILTER_TIMEOUT_MS }
      );
      responseP.catch(() => {}); // goto may throw first; avoid an unhandled rejection
      await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
      let resp;
      try {
        resp = await responseP;
      } catch {
        throw new Error(
          `Alza's category page did not issue its range-filter request within ${RANGE_FILTER_TIMEOUT_MS / 1000} s — the slider encoding may have changed (see https://github.com/lukabudik/alza-mcp-community/blob/main/docs/gap-analysis.md, "Search-time attribute/facet filtering")`
        );
      }
      if (!resp.ok()) throw new Error(`Alza range-filter request failed: HTTP ${resp.status()}`);
      // Same redirect guard as the checkbox path: a path segment Alza has no
      // landing page for is dropped by a redirect (the hash survives it).
      await this.assertFiltersApplied(p, opts);
      const applied = parseAppliedRanges(safeJsonParse(resp.request().postData()));
      for (const r of ranges) {
        if (!applied.some((a) => a.paramId === r.paramId)) {
          throw new Error(`Alza's category page did not apply the range filter for param_id ${r.paramId} ("${r.name}")`);
        }
      }
      const json = (await resp.json()) as FilterResponse;
      const boxes = json.d?.Boxes ?? "";
      const cards = boxes
        ? ((await p.evaluate(
            `(function(){ var doc = new DOMParser().parseFromString(${JSON.stringify(boxes)}, 'text/html'); return (${CARD_EXTRACTOR_FN})(doc); })()`
          )) as RawCard[])
        : [];
      return { cards, count: typeof json.d?.Count === "number" ? json.d.Count : cards.length, applied };
    });
  }

  /**
   * Discounted products from listing pages: a category (`/{id}.htm`) or any
   * listing URL on the configured storefront, e.g. an Alza dni promotion
   * (`/monitory-23-a-24/alza-dni/18848792-e39.htm`). Prices, promo codes and
   * AlzaPlus+ prices are parsed from the cards (see deals.ts). alza.cz and
   * alza.sk only. Without a category or URL, scans page 1 of a fixed set of
   * popular leaf categories; with one, follows its page links until a page
   * adds no new products (at most DEAL_MAX_PAGES pages).
   */
  async getDeals(opts: { categoryId?: number; url?: string; minDiscountPercent?: number; limit?: number }): Promise<{
    categoryIds: number[];
    url?: string;
    candidatesScanned: number;
    pagesScanned: number;
    /** True when the time budget ran out before every page was read; a retry reuses the pages already loaded. */
    partial?: boolean;
    deals: Deal[];
    /** Opened-box / used offers: a compromise on condition, so kept out of `deals` and their ranking. */
    usedOffers: Deal[];
  }> {
    const { countryCode, currency } = this.browser.locale;
    if (countryCode !== "CZ" && countryCode !== "SK") {
      throw new Error(`get_deals supports alza.cz and alza.sk price boxes only (this server is set to ${this.browser.locale.baseUrl}).`);
    }
    if (opts.categoryId && opts.url) throw new UserError("Pass either category_id or url, not both.");
    const limit = clamp(opts.limit ?? 20, 1, 50);
    const min = opts.minDiscountPercent ?? 0;
    const url = opts.url ? this.dealListingUrl(opts.url) : undefined;
    const urlCategoryId = url ? Number(new URL(url).pathname.match(/\/(\d+)(?:-[a-z]+\d*)*\.htm$/)?.[1]) : NaN;
    const categoryIds = url
      ? (Number.isFinite(urlCategoryId) ? [urlCategoryId] : [])
      : opts.categoryId ? [opts.categoryId] : DEFAULT_DEAL_CATEGORIES.map((c) => c.id);
    const starts = url ? [url] : categoryIds.map((id) => `/${id}.htm`);
    const maxPages = url || opts.categoryId ? DEAL_MAX_PAGES : 1;
    const cacheKey = JSON.stringify({ starts, maxPages });
    const finished = this.dealsCache.get(cacheKey);
    const all = finished ?? (await this.scanDeals(starts, maxPages, currency));
    if (!finished && !all.partial) this.dealsCache.set(cacheKey, all);
    const deals = all.deals
      .filter((d) => d.discountPercent >= min)
      .sort(compareDeals)
      .slice(0, limit);
    const usedOffers = all.usedOffers.slice().sort((a, b) => a.priceNow - b.priceNow).slice(0, 10);
    return { categoryIds, ...(url ? { url } : {}), candidatesScanned: all.scanned, pagesScanned: all.pages, ...(all.partial ? { partial: true } : {}), deals, usedOffers };
  }

  /**
   * Reads the start page of each listing, then its further pages in parallel
   * (at most DEAL_MAX_PAGES - 1 at once), within TOOL_BUDGET_MS. Pages that
   * miss the budget are skipped and flagged as `partial`; they keep loading in
   * the background and fill `dealPageCache` for the retry.
   */
  private async scanDeals(starts: string[], maxPages: number, currency: string): Promise<{ scanned: number; pages: number; partial?: boolean; deals: Deal[]; usedOffers: Deal[] }> {
    const deadline = Date.now() + TOOL_BUDGET_MS;
    const deals: Deal[] = [];
    const usedOffers: Deal[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let pages = 0;
    let partial = false;
    const page = (target: string) => this.dealPageCache.memoize(target, () => this.fetchSearchPage({ query: "" }, target));
    const ingest = (cards: RawCard[]): void => {
      for (const c of cards) {
        const product = this.normalizeCard(c);
        if (!product) continue;
        // An opened-box item can share its code with the new one: key on both.
        const key = `${product.code}|${product.condition ?? "new"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scanned++;
        const d = parseDealCard(c, currency);
        if (!d) continue;
        const reviewCount = c.reviewCountText ? Number(c.reviewCountText) : undefined;
        const entry = {
          ...product,
          ...(c.availabilityText ? { availabilityText: c.availabilityText } : {}),
          ...(reviewCount !== undefined && Number.isFinite(reviewCount) ? { reviewCount } : {}),
          ...d,
        } as Deal;
        (d.condition ? usedOffers : deals).push(entry);
      }
    };
    for (const start of starts) {
      const first = await raceDeadline(page(start), deadline);
      if ("timedOut" in first) {
        partial = true;
        break;
      }
      pages++;
      ingest(first.value.cards);
      if (first.value.cards.length === 0) continue;
      const more: string[] = [];
      for (let n = 2; n <= maxPages; n++) {
        const href = first.value.pageUrls[String(n)];
        if (href) more.push(href);
      }
      const rest = await Promise.all(more.map((target) => raceDeadline(page(target), deadline)));
      for (const r of rest) {
        if ("timedOut" in r) {
          partial = true;
          continue;
        }
        pages++;
        ingest(r.value.cards);
      }
    }
    return { scanned, pages, ...(partial ? { partial } : {}), deals, usedOffers };
  }

  /** A listing URL on this storefront, reduced to origin + path (no query, no #f&cud=… hash). */
  private dealListingUrl(raw: string): string {
    let u: URL;
    try {
      u = new URL(raw.trim(), this.browser.locale.baseUrl);
    } catch {
      throw new UserError("url must be an Alza listing URL, e.g. https://www.alza.sk/monitory-23-a-24/alza-dni/18848792-e39.htm");
    }
    const base = new URL(this.browser.locale.baseUrl);
    if (u.protocol !== "https:" || u.host !== base.host || u.username || u.password) {
      throw new UserError(`url must be on the configured storefront ${base.origin} (ALZA_BASE_URL); got ${u.protocol}//${u.host}`);
    }
    if (!/\.htm$/.test(u.pathname)) throw new UserError("url must be a listing page ending in .htm, e.g. /monitory-23-a-24/alza-dni/18848792-e39.htm");
    // Page 1 of the listing: "-p2.htm" -> ".htm".
    return `${u.origin}${u.pathname.replace(/-p\d+\.htm$/, ".htm")}`;
  }

  private readonly categoryExistsCache = new TtlCache<number, true>(60 * 60 * 1000);

  /**
   * Throws NotFoundError for a category id Alza has no page for. Alza answers
   * `/{id}.htm` for an unknown id with a 404 error page, while keyword search
   * (`search.htm?idc=`) silently ignores a bogus id and returns unrelated
   * results (live-verified 2026-10-07). Only successes are cached.
   */
  private async assertCategoryExists(categoryId: number): Promise<void> {
    await this.categoryExistsCache.memoize(categoryId, async () => {
      const status = await this.browser.withPage(async (p) => {
        const res = await p.goto(`${this.browser.locale.baseUrl}/${categoryId}.htm`, { waitUntil: "commit", timeout: 30_000 });
        await assertNotChallenged(res, p);
        return res?.status();
      });
      if (status === 404) throw new NotFoundError(`category ${categoryId}`);
      return true as const;
    });
  }

  /**
   * Redirect guard for filtered category URLs. Alza redirects an unsupported
   * `-v{id}` / `-par{p}-{v}` segment to a less-filtered page, so a dropped
   * segment normally means the filter was not applied. One exception
   * (live-verified 2026-10-07): for a major brand Alza redirects page 1 to its
   * curated brand landing page under a different category id (phones +
   * Samsung -> /mobily-samsung/18855066.htm), which IS filtered; page 2+
   * (`-p2`) keeps the `-v{id}` segment. That redirect is accepted when it is
   * the only dropped segment, leaves the requested category id, and the
   * landing page's title/heading names the requested brand.
   */
  private async assertFiltersApplied(p: Page, opts: SearchOptions): Promise<void> {
    const dropped = droppedFilterSegments(p.url(), opts.producerIds, opts.filters);
    if (dropped.length === 0) return;
    if (dropped.length === 1 && dropped[0]?.startsWith("producer ") && opts.producerIds?.length === 1 && opts.categoryId) {
      const landedId = new URL(p.url()).pathname.match(/(\d+)\.htm$/)?.[1];
      if (landedId !== undefined && Number(landedId) !== opts.categoryId) {
        const brand = await this.getCategoryFilters(opts.categoryId)
          .then((f) => f.brands.find((b) => b.valueId === opts.producerIds?.[0])?.description)
          .catch(() => undefined);
        if (brand) {
          const heading = (await p.evaluate(
            "(document.title || '') + ' ' + ((document.querySelector('h1') || {}).textContent || '')"
          )) as string;
          if (normText(heading).includes(normText(brand))) return;
        }
      }
    }
    throw new Error(
      `Alza does not support URL filtering for ${dropped.join(", ")} in category ${opts.categoryId} ` +
        "(it redirected to an unfiltered page). Drop that filter and compare candidates with get_product's params instead."
    );
  }

  private async fetchSearchPage(
    opts: SearchOptions,
    explicitUrl?: string
  ): Promise<{ cards: RawCard[]; pageUrls: Record<string, string> }> {
    const url = explicitUrl ? this.absUrl(explicitUrl) : this.buildSearchUrl(opts, 1);
    log.debug("catalog.fetchSearchPage", { url });
    return this.browser.withPage(async (p) => {
      const res = await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
      await p.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
      // A Cloudflare challenge (403) or an Alza outage (5xx) is an error, not
      // "no results" (reported 2026-10-11: every catalog tool returned empty).
      await assertPageOk(res, p);
      if (res && res.status() >= 400) {
        if (res.status() === 404 && opts.categoryId && (opts.producerIds?.length || opts.filters?.length)) {
          await this.assertCategoryExists(opts.categoryId); // unknown category -> NotFoundError
          // The category exists, so Alza has no page for this
          // brand/attribute combination — say so instead of reporting 0 results.
          throw new Error(
            `Alza has no filtered page for category ${opts.categoryId} with the requested producer_ids/filters (HTTP 404) — check the ids with list_category_filters; combining several brands in one call is not supported.`
          );
        }
        // Some "no results" pages are legit 404 — degrade gracefully.
        return { cards: [] as RawCard[], pageUrls: {} };
      }
      if (opts.categoryId && (opts.producerIds?.length || opts.filters?.length)) {
        await this.assertFiltersApplied(p, opts);
      }
      // Render-race guard (observed 2026-09-12): the first navigation after a
      // cold browser launch can finish "load" with the result grid still
      // unrendered, and the selector wait can expire with zero cards —
      // reporting "No products found" for a query that does have results.
      // Retry the extraction a bounded number of times before accepting an
      // empty grid (a genuinely empty result costs ~30 s extra; a false
      // empty is much worse).
      let cards = [] as RawCard[];
      for (let attempt = 0; ; attempt++) {
        // Alza's own "no results" page ("…jsem nenašel. Jak dál?", alza.sk
        // "…som nenašiel. Ako ďalej?", live-verified 2026-10-07) is
        // server-rendered, so it is a reliable signal: without this check a
        // typo query burned all retries (~35 s) before reporting nothing.
        if ((await p.evaluate(NO_RESULTS_PROBE)) === true) {
          log.debug("catalog.fetchSearchPage.noResults", { url });
          return { cards: [] as RawCard[], pageUrls: {} };
        }
        await p.waitForSelector(".browsingitem", { timeout: 10_000 }).catch(() => null);
        cards = (await p.evaluate(CARD_EXTRACTOR)) as RawCard[];
        log.debug("catalog.fetchSearchPage.cards", {
          url,
          attempt,
          cards: cards.length,
          sponsored: cards.filter((c) => c.sponsored).length,
          incomplete: cards.filter((c) => !c.code || !c.name || !c.url).length,
        });
        if (cards.length > 0 || attempt >= 2) break;
        await p.waitForTimeout(2_000);
      }
      const pageUrls = (await p.evaluate(PAGE_URLS_EXTRACTOR)) as Record<string, string>;
      return { cards, pageUrls };
    });
  }

  async getProduct(code: string): Promise<Product> {
    const full = await this.getProductSpecs(code);
    if (!full.params || full.params.length <= PRODUCT_PARAMS_CAP) return full;
    return { ...full, params: full.params.slice(0, PRODUCT_PARAMS_CAP) };
  }

  /**
   * Same as `getProduct` (one page load, shared cache) but keeps up to
   * PRODUCT_PARAMS_SCRAPE_CAP spec rows instead of the public 30-row cap.
   */
  async getProductSpecs(code: string): Promise<Product> {
    const trimmed = code.trim();
    if (!trimmed) throw new NotFoundError("product code");

    return this.productCache.memoize(trimmed, async () => {
      const url = await this.resolveProductUrl(trimmed);
      log.debug("catalog.getProduct", { code: trimmed, url });

      const data = await this.browser.withPage(async (p) => {
        const res = await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
        await assertPageOk(res, p);
        await p.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
        let first = (await p.evaluate(PRODUCT_PAGE_EXTRACTOR)) as ProductPageData;
        // .av-container is a client-rendered React component: at "load" it is
        // often still empty (live 2026-10-08), and the JSON-LD fallback then
        // reports InStock for on-order items. Give it a moment to render.
        if (first.product && !first.availabilityText) {
          const ok = await p
            .waitForSelector('[data-testid*="availability-availabilityText"]', { timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
          if (ok) first = (await p.evaluate(PRODUCT_PAGE_EXTRACTOR)) as ProductPageData;
        }
        // Render race (live 2026-10-06, PSU AAnagp2a4): the spec table can be
        // missing at "load" and the result would then sit in the cache with no
        // params. When neither spec source has rows, wait briefly for the table
        // and read the page once more. Only pages without specs pay for this.
        if (first.product && first.params.length === 0 && pickAdditionalProperties(first.product.additionalProperty).length === 0) {
          await p.waitForSelector(".paramTbl tr, .productSpecBox tr", { timeout: 4_000 }).catch(() => null);
          return (await p.evaluate(PRODUCT_PAGE_EXTRACTOR)) as ProductPageData;
        }
        return first;
      });

      const ld = data.product;
      if (!ld) throw new NotFoundError(`product ${trimmed}`);

      const name = (ld.name as string) ?? data.h1 ?? trimmed;
      const offers = pickOffer(ld.offers);
      const rating = pickRating(ld.aggregateRating);
      const breadcrumbs = pickBreadcrumbs(data.breadcrumb);
      const images = pickImages(ld.image);

      // Merge both spec sources — some page templates only populate one
      // (live-verified 2026-09-27: the DOM .paramTbl table is sometimes
      // entirely absent while additionalProperty carries the real specs).
      // DOM-table rows win on name collisions; extra additionalProperty
      // rows are appended (getProduct then caps the public list at 30).
      const seenNames = new Set(data.params.map((p) => p.name));
      const extraParams = pickAdditionalProperties(ld.additionalProperty).filter((p) => !seenNames.has(p.name));
      const mergedParams = [...data.params, ...extraParams].slice(0, PRODUCT_PARAMS_SCRAPE_CAP);

      return {
        code: ((ld.sku as string) ?? trimmed).trim(),
        // Numeric commodity id from the `-d<id>.htm` / `?dq=<id>` URL (same
        // value the search cards carry as data-id); 0 only when the page URL
        // carries none.
        id: commodityIdFromUrl(data.url) ?? commodityIdFromUrl(url) ?? 0,
        name: stripHtmlEntities(name),
        url: data.url,
        image: images[0],
        price: offers.price,
        currency: offers.priceCurrency ?? this.browser.locale.currency,
        ...payablePrices({
          availabilityText: data.availabilityText,
          priceText: data.shelfPriceText ?? jsonLdPriceText(offers.price),
          originalPriceText: null,
          originalIsStrike: false,
          couponCode: data.promoCode,
          couponPriceText: data.promoPriceText,
        }),
        ...availabilityFields(data.availabilityText || offers.availability),
        ...jsonLdConflict(data.availabilityText, offers.availability),
        rating: rating.average,
        brand: pickBrand(ld.brand),
        category: breadcrumbs[breadcrumbs.length - 2],
        params: mergedParams.length > 0 ? mergedParams : undefined,
      };
    });
  }

  private readonly facetsCache = new TtlCache<number, CategoryFilters>(60 * 60 * 1000);

  /**
   * Category attribute facets (brand, native contrast, panel type, screen
   * diagonal, …) from the live JSON facets API. Read-only, same-origin
   * fetch from within a loaded page (this endpoint sits behind the same
   * Cloudflare wall as everything else; a real browser page already
   * cleared it). Checkbox groups filter by value id (`buildFilteredCategoryUrl`),
   * Slider groups by range (`buildRangeHash`).
   */
  async getCategoryFilters(categoryId: number): Promise<CategoryFilters> {
    return this.facetsCache.memoize(categoryId, async () => {
      const pageUrl = `${this.browser.locale.baseUrl}/${categoryId}.htm`;
      const apiUrl = `/services/restservice.svc/v3/params/${categoryId}?type=CATEGORY&typeId=0&search=`;
      return this.browser.withPage(async (p) => {
        const res = await p.goto(pageUrl, { waitUntil: "commit", timeout: 30_000 });
        await assertPageOk(res, p);
        if (res?.status() === 404) throw new NotFoundError(`category ${categoryId}`);
        await p.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
        const raw = (await p.evaluate(
          `fetch(${JSON.stringify(apiUrl)}, { headers: { accept: "application/json" } }).then((r) => r.json())`
        )) as FacetsApiResponse;
        return { categoryId, brands: parseProducers(raw), groups: parseFacetsResponse(raw) };
      });
    });
  }

  async listCategories(parentId?: number): Promise<Category[]> {
    return this.categoryCache.memoize(parentId ?? 0, async () => {
      const url = parentId
        ? `${this.browser.locale.baseUrl}/${parentId}.htm`
        : this.browser.locale.baseUrl;

      return this.browser.withPage(async (p) => {
        const res = await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
        await assertPageOk(res, p);
        if (parentId && res?.status() === 404) throw new NotFoundError(`category ${parentId}`);
        await p.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});

        // Top-level: the homepage's MUI category navigation. Sub-level: the
        // category page's tile grid. The global navigation is rendered on
        // category pages too, so it must not be a sub-level fallback — it
        // would return the top-level list for every parent_id.
        const sels = parentId
          ? [
              '.react-category-tiles a[href*=".htm"]',
              '.category-tiles__categories a[href*=".htm"]',
              '.subCategoriesList a[href*=".htm"]',
              '.category-tree a[href*=".htm"]',
              'ul.subCategories a[href*=".htm"]',
            ]
          : ['li[class*="category-naviga"] a[href*=".htm"]'];
        const raw = (await p.evaluate(`(function() {
          var sels = ${JSON.stringify(sels)};
          var seen = new Set();
          var out = [];
          for (var s = 0; s < sels.length; s++) {
            var els = document.querySelectorAll(sels[s]);
            for (var i = 0; i < els.length; i++) {
              var a = els[i];
              var href = a.getAttribute('href') || '';
              var idMatch = href.match(/(\\d{4,})\\.htm/);
              var name = (a.textContent || '').trim().replace(/\\s+/g, ' ');
              if (!idMatch || !name || name.length > 80) continue;
              // Skip promo/seasonal entries that appear at the top of the menu.
              if (/^Alza dny/i.test(name)) continue;
              var id = parseInt(idMatch[1], 10);
              if (seen.has(id)) continue;
              seen.add(id);
              out.push({ id: id, name: name, url: href });
            }
            if (out.length > 0) break;
          }
          return out;
        })()`)) as Array<{ id: number; name: string; url: string }>;

        return raw
          .map((c) => ({
            id: c.id,
            name: stripHtmlEntities(c.name),
            url: this.absUrl(c.url),
            // Sub-level tiles are children of the requested category. The page
            // carries no per-tile child counts and the homepage nav no tree
            // (live-checked 2026-10-07), so `childCount` stays unknown.
            ...(parentId ? { parentId } : {}),
          }))
          .slice(0, 60);
      });
    });
  }

  async resolveProductUrl(code: string): Promise<string> {
    const cached = this.productUrlCache.get(code);
    if (cached) return cached;

    // Search by code, expect first matching card.
    const searchUrl = this.buildSearchUrl({ query: code }, 1);
    const found = await this.browser.withPage(async (p) => {
      const res = await p.goto(searchUrl, { waitUntil: "commit", timeout: 30_000 });
      await assertPageOk(res, p); // a challenged search must not become "product not found"
      await p.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
      await p.waitForSelector(".browsingitem", { timeout: 12_000 }).catch(() => null);
      return (await p.evaluate(`(function() {
        var cards = Array.from(document.querySelectorAll('.browsingitem'));
        for (var i = 0; i < cards.length; i++) {
          var c = cards[i];
          var dc = (c.getAttribute('data-code') || '').toLowerCase();
          if (dc !== ${JSON.stringify(code.toLowerCase())}) continue;
          var a = c.querySelector('a.name') || c.querySelector('a[href*=".htm"]');
          if (a && a.href) return a.href;
        }
        return null;
      })()`)) as string | null;
    });

    if (!found) throw new NotFoundError(`product ${code}`);
    this.productUrlCache.set(code, found);
    return found;
  }

  private buildSearchUrl(opts: SearchOptions, page: number): string {
    const hasAttrFilters = (opts.producerIds && opts.producerIds.length > 0) || (opts.filters && opts.filters.length > 0);
    if ((hasAttrFilters || opts.browse) && opts.categoryId) {
      // Category+attribute-filter browse page (live-verified 2026-09-27):
      // the URL's slug segments are cosmetic (any text, or none, resolves
      // to the canonical page) — only the numeric `{categoryId}[-v{producerId}]
      // [-par{paramId}-{valueId}]...` suffix matters. Real pagination for
      // this path still comes from the rendered page-link anchors (same as
      // /search.htm), not a query parameter.
      return buildFilteredCategoryUrl(this.browser.locale.baseUrl, opts.categoryId, opts.producerIds, opts.filters);
    }
    const url = new URL("/search.htm", this.browser.locale.baseUrl);
    url.searchParams.set("exps", opts.query);
    if (opts.sort) {
      // NOTE: Alza's /search.htm currently ignores the `o=` sort parameter
      // (verified 2026-09-12: o=0/2/3 all return identical relevance order;
      // the site's sort control is client-side JS). We keep the parameter as
      // documentation of intent and rely on `compareForSort` below, which
      // sorts the fetched page client-side — that is the actual guarantee.
      const sortMap: Record<SortOrder, string> = {
        relevance: "0",
        "price-asc": "2",
        "price-desc": "3",
        rating: "8",
        newest: "9",
      };
      url.searchParams.set("o", sortMap[opts.sort] ?? "0");
    }
    if (page > 1) url.searchParams.set("pg", String(page));
    if (opts.categoryId) url.searchParams.set("idc", String(opts.categoryId));
    return url.toString();
  }

  private normalizeCard(c: RawCard): Product | null {
    if (!c.code || !c.name || !c.url) return null;
    return {
      code: c.code,
      id: c.id ? Number(c.id) : 0,
      name: c.name,
      url: this.absUrl(c.url),
      image: c.image ?? undefined,
      price: parsePrice(c.priceText),
      currency: this.browser.locale.currency,
      availability:
        c.inStock === null ? undefined : c.inStock ? "in stock" : "not purchasable now",
      rating: c.ratingText ? Number(c.ratingText.replace(",", ".")) : undefined,
      ...payablePrices(c),
    };
  }

  private absUrl(url: string): string {
    if (url.startsWith("http")) return url;
    return new URL(url, this.browser.locale.baseUrl).toString();
  }
}

interface ProductPageData {
  title: string;
  url: string;
  h1: string | null;
  product: Record<string, unknown> | null;
  breadcrumb: Record<string, unknown> | null;
  availabilityText?: string | null;
  promoCode?: string | null;
  promoPriceText?: string | null;
  shelfPriceText?: string | null;
  params: Array<{ name: string; value: string }>;
}

/**
 * When the visible availability line and the JSON-LD token disagree, surface
 * the JSON-LD value (`jsonLdAvailability`) so callers can see the conflict;
 * the visible text stays the reported `availability`.
 */
export function jsonLdConflict(visible: string | null | undefined, jsonLd: string | undefined): { jsonLdAvailability?: string } {
  const v = normalizeAvailability(visible);
  const j = normalizeAvailability(jsonLd);
  return v && j && v !== j ? { jsonLdAvailability: j } : {};
}

function normText(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * How many result pages to gather before a client-side price/rating sort.
 * Alza serves ~24 cards per page (verified 2026-09-12). Two pages (~48
 * candidates) is the floor so the sort has real material; three pages (~72)
 * covers the largest limit. Bounded for latency: each page is one full
 * browser navigation.
 */
export function sortSweepPages(limit: number): number {
  return Math.min(3, Math.max(2, Math.ceil(limit / 24)));
}

/**
 * Whether page 1 gathers several result pages before filtering/sorting. A
 * client-side price/rating sort needs the larger pool, and so does a price
 * window: one rendered page (~24 cards) rarely holds more than a handful of
 * products in a narrow window (QA 2026-10-07: `min_price` on "myš" returned 3
 * of hundreds). An explicit `page` > 1 keeps the single-page behaviour.
 */
export function shouldSweep(opts: Pick<SearchOptions, "sort" | "minPrice" | "maxPrice">, page: number): boolean {
  if (page !== 1) return false;
  return (
    opts.sort === "price-asc" ||
    opts.sort === "price-desc" ||
    opts.sort === "rating" ||
    opts.minPrice !== undefined ||
    opts.maxPrice !== undefined
  );
}

/**
 * In-stock filter from the card's purchase CTA. `inStock: true` keeps only
 * products confirmed purchasable now; undetermined stock is excluded (the
 * flag is an assertion). Without the flag nothing is filtered.
 */
export function passesInStock(p: Product, inStock?: boolean): boolean {
  if (!inStock) return true;
  return p.availability === "in stock";
}

/**
 * Client-side sort for search results. Alza's search page serves results in
 * relevance order regardless of the `o=` parameter, so price/rating orders
 * are applied here — to the swept candidate pool for price/rating orders
 * (see sortSweepPages), never to the whole catalog. Products without a
 * price sort last for price orders; missing ratings sort last for rating order.
 */
export function compareForSort(a: Product, b: Product, sort?: SortOrder): number {
  if (sort === "price-asc" || sort === "price-desc") {
    if (a.price === undefined && b.price === undefined) return 0;
    if (a.price === undefined) return 1; // unknown price sorts last
    if (b.price === undefined) return -1;
    return sort === "price-asc" ? a.price - b.price : b.price - a.price;
  }
  if (sort === "rating") return (b.rating ?? 0) - (a.rating ?? 0);
  return 0;
}

/**
 * Price window. A product whose price could not be read is excluded whenever a
 * bound is set (it cannot be shown to satisfy the filter), like `passesInStock`.
 */
export function filterByPrice(p: Product, opts: Pick<SearchOptions, "minPrice" | "maxPrice">): boolean {
  if (opts.minPrice === undefined && opts.maxPrice === undefined) return true;
  if (p.price === undefined) return false;
  if (opts.minPrice !== undefined && p.price < opts.minPrice) return false;
  if (opts.maxPrice !== undefined && p.price > opts.maxPrice) return false;
  return true;
}

interface FacetsApiResponse {
  producers?: Array<{ v?: number; desc?: string; cnt?: number }>;
  params?: Array<{
    groups?: Array<{
      params?: Array<{
        tId?: number;
        name?: string;
        renderType?: string;
        values?: Array<{ v?: number; desc?: string; cnt?: number }>;
      }>;
    }>;
  }>;
}

/**
 * Flattens the facets API's `params[].groups[].params[]` nesting into a
 * flat list, and drops values whose `v`/`desc` didn't parse (the JSON
 * sometimes carries decorative rows, e.g. an "id:0" `art` entry within
 * the Diagonal slider — live-verified 2026-09-27).
 */
export function parseFacetsResponse(raw: FacetsApiResponse): FacetGroup[] {
  const out: FacetGroup[] = [];
  for (const group of raw.params ?? []) {
    for (const g of group.groups ?? []) {
      for (const p of g.params ?? []) {
        if (p.tId === undefined || !p.name) continue;
        const values: FacetGroup["values"] = [];
        for (const v of p.values ?? []) {
          if (v.v === undefined || !v.desc) continue;
          values.push({
            valueId: Math.trunc(v.v),
            description: v.desc,
            count: v.cnt,
            ...(p.renderType === "Slider" ? { value: v.v } : {}),
          });
        }
        const filterMode = p.renderType === "Checkbox" ? "value" : p.renderType === "Slider" ? "range" : undefined;
        out.push({
          paramId: p.tId,
          name: p.name,
          renderType: p.renderType ?? "Unknown",
          filterable: filterMode !== undefined,
          ...(filterMode ? { filterMode } : {}),
          values,
        });
      }
    }
  }
  return out;
}

/** Brand values from the facets API's top-level `producers` list. */
export function parseProducers(raw: FacetsApiResponse): FacetValue[] {
  const out: FacetValue[] = [];
  for (const v of raw.producers ?? []) {
    if (v.v === undefined || !v.desc) continue;
    out.push({ valueId: Math.trunc(v.v), description: v.desc, count: v.cnt });
  }
  return out;
}

/**
 * Filter segments Alza dropped while resolving a filtered category URL.
 * Alza 30x-redirects a `-par{p}-{v}` / `-v{id}` segment it doesn't serve a
 * landing page for back to the less-filtered page (live-verified 2026-10-03:
 * monitors `-par18073-239735342` "Quad HD" lands on the plain category), so
 * the final URL is the only reliable signal that a filter was applied.
 */
export function droppedFilterSegments(
  finalUrl: string,
  producerIds: number[] = [],
  filters: Array<{ paramId: number; valueId: number }> = []
): string[] {
  const last = new URL(finalUrl).pathname.split("/").pop() ?? "";
  const segments = last.replace(/\.htm$/, "").split("-");
  const missing: string[] = [];
  for (const id of producerIds) {
    if (!segments.includes(`v${id}`)) missing.push(`producer ${id}`);
  }
  for (const f of filters) {
    const i = segments.indexOf(`par${f.paramId}`);
    if (i < 0 || segments[i + 1] !== String(f.valueId)) missing.push(`param ${f.paramId}=${f.valueId}`);
  }
  return missing;
}

/**
 * Category browse URL with brand/attribute filters applied — live-verified
 * 2026-09-27 against real Alza category pages (monitor category, HDMI +
 * brand combined: product codes and page title both changed correctly).
 * The path's slug segments are purely cosmetic (any text, or none, 302s/
 * resolves to the canonical URL) — only the numeric suffix matters:
 * `{categoryId}[-v{producerId}]...[-par{paramId}-{valueId}]...`. Only some
 * Checkbox-type facets work this way (see `FacetGroup.filterable` and
 * `droppedFilterSegments`); Slider facets go in the URL hash instead — see
 * `buildRangeHash`.
 */
export function buildFilteredCategoryUrl(
  baseUrl: string,
  categoryId: number,
  producerIds?: number[],
  filters?: Array<{ paramId: number; valueId: number }>
): string {
  let suffix = String(categoryId);
  for (const id of producerIds ?? []) suffix += `-v${id}`;
  for (const f of filters ?? []) suffix += `-par${f.paramId}-${f.valueId}`;
  return new URL(`/${suffix}.htm`, baseUrl).toString();
}

const RANGE_FILTER_TIMEOUT_MS = 45_000;

interface RangePlan {
  resolved: ResolvedRange[];
  /** Requested ranges with no slider step inside them (result is necessarily empty). */
  empty: AppliedRange[];
  /** True when `min/max_screen_inches` is enforced by the category's diagonal slider. */
  screenServerSide: boolean;
}

interface FilterResponse {
  d?: { Boxes?: string; Count?: number; Page?: number };
}

function isFilterCallUrl(url: string): boolean {
  return /\/Services\/EShopService\.svc\/Filter(?:[?#]|$)/i.test(url);
}

function safeJsonParse(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Sorted, de-duplicated slider step values of a range facet. */
function sliderSteps(group: FacetGroup): number[] {
  const steps = group.values
    .map((v) => v.value)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return [...new Set(steps)].sort((a, b) => a - b);
}

function tolerance(x: number): number {
  return Math.abs(x) * 1e-9 + 1e-12;
}

/**
 * Snap a requested `[min, max]` (facet units) to the slider's real steps:
 * `from` = smallest step ≥ min, `to` = largest step ≤ max (an omitted bound
 * takes the slider's end). Alza's page needs both bounds in the hash — a
 * missing upper bound was live-observed 2026-10-06 to collapse to the
 * slider's minimum (zero results) — and snapping to real steps keeps the
 * page's own index lookup exact. Undefined when no step lies in range.
 */
export function snapRange(group: FacetGroup, min?: number, max?: number): ResolvedRange | undefined {
  const steps = sliderSteps(group);
  if (steps.length === 0) return undefined;
  const from = min === undefined ? steps[0] : steps.find((v) => v >= min - tolerance(min));
  const to = max === undefined ? steps[steps.length - 1] : [...steps].reverse().find((v) => v <= max + tolerance(max));
  if (from === undefined || to === undefined || from > to) return undefined;
  return { paramId: group.paramId, name: group.name, from, to };
}

/**
 * The category's screen-diagonal slider, recognised by its value labels
 * being inch sizes (`27 " (68,58 cm)`, `10,5 "`). Unit-agnostic on purpose:
 * the underlying step value is millimetres on monitors/laptops but inches on
 * TVs (live-verified 2026-10-06), so the param id and unit can't be assumed.
 */
export function findScreenDiagonalGroup(facets: FacetGroup[]): FacetGroup | undefined {
  return facets.find((g) => {
    if (g.filterMode !== "range" || g.values.length < 2) return false;
    const inchLabels = g.values.filter((v) => parseScreenInches(v.description) !== undefined).length;
    return inchLabels >= Math.ceil(g.values.length * 0.8);
  });
}

/** Snap an inch range to the diagonal slider's steps via each step's inch label. */
export function snapScreenInches(group: FacetGroup, minInches?: number, maxInches?: number): ResolvedRange | undefined {
  const pairs = group.values
    .map((v) => ({ value: v.value, inches: parseScreenInches(v.description) }))
    .filter((x): x is { value: number; inches: number } => typeof x.value === "number" && x.inches !== undefined)
    .sort((a, b) => a.value - b.value);
  const inRange = pairs.filter(
    (x) =>
      (minInches === undefined || x.inches >= minInches - 1e-9) &&
      (maxInches === undefined || x.inches <= maxInches + 1e-9)
  );
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  if (!first || !last) return undefined;
  return { paramId: group.paramId, name: group.name, from: first.value, to: last.value };
}

/** Plain decimal rendering (never exponent notation) for a hash value. */
export function formatRangeNumber(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Alza's category-page filter hash for slider facets — the exact shape the
 * page itself writes after a real mouse drag (live-verified 2026-10-06):
 * `#f&cud=0&pg={page}&prod=&par{paramId}={from}--{to}`, one `par` entry per
 * slider, values in the facet's own units.
 */
export function buildRangeHash(ranges: Array<{ paramId: number; from: number; to: number }>, page = 1): string {
  let hash = `#f&cud=0&pg=${Math.max(1, Math.trunc(page))}&prod=`;
  for (const r of ranges) hash += `&par${r.paramId}=${formatRangeNumber(r.from)}--${formatRangeNumber(r.to)}`;
  return hash;
}

/** Ranges actually sent in the page's `EShopService.svc/Filter` request body. */
export function parseAppliedRanges(body: unknown): AppliedRange[] {
  const params = (body as { parameters?: unknown } | undefined)?.parameters;
  if (!Array.isArray(params)) return [];
  const out: AppliedRange[] = [];
  for (const raw of params) {
    const p = raw as { typeId?: unknown; valueFrom?: unknown; valueTo?: unknown };
    if (typeof p.typeId !== "number") continue;
    const from = typeof p.valueFrom === "number" ? p.valueFrom : undefined;
    const to = typeof p.valueTo === "number" ? p.valueTo : undefined;
    if (from === undefined && to === undefined) continue;
    out.push({ paramId: p.typeId, from, to });
  }
  return out;
}

function mergeApplied(requested: AppliedRange[], applied: AppliedRange[]): AppliedRange[] {
  return requested.map((r) => {
    const a = applied.find((x) => x.paramId === r.paramId);
    return a ? { ...r, from: a.from, to: a.to } : r;
  });
}

/**
 * Screen-diagonal size, parsed from a leading `NN"` token — used on product
 * names (Alza's naming convention for displays, e.g. `40" MSI MAG401QR`) and
 * on diagonal-slider value labels (`27 " (68,58 cm)`). For product names it
 * is only the fallback when no category is given (or the category has no
 * diagonal slider): with a category, `min/max_screen_inches` is enforced by
 * Alza's own diagonal slider filter (live-verified 2026-10-06; see
 * `buildRangeHash`).
 */
export function parseScreenInches(name: string): number | undefined {
  const m = name.match(/^(\d+(?:[.,]\d+)?)\s*(?:"|''|″)/);
  if (!m) return undefined;
  const n = Number((m[1] ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function filterByScreenSize(p: Product, opts: SearchOptions): boolean {
  if (opts.minScreenInches === undefined && opts.maxScreenInches === undefined) return true;
  const inches = parseScreenInches(p.name);
  if (inches === undefined) return false; // can't verify => excluded, like passesInStock's undetermined case
  if (opts.minScreenInches !== undefined && inches < opts.minScreenInches) return false;
  if (opts.maxScreenInches !== undefined && inches > opts.maxScreenInches) return false;
  return true;
}

export function parsePrice(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  // Alza search cards show prices like "5 290,-" / "Super cena 4 399,- Ušetříte 91,-"
  // (alza.cz) and "395,90 €" / "297 €" (alza.sk, live-verified 2026-10-07).
  // Take the first price-shaped number: digits with optional space-grouped
  // thousands and optional decimals, followed by ",-", "€" or "Kč".
  const m = raw.match(/(\d{1,3}(?:\s\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:,-|€|Kč)/);
  if (!m) return undefined;
  const n = Number(`${(m[1] ?? "").replace(/\s+/g, "")}${m[2] ? `.${m[2]}` : ""}`);
  return Number.isFinite(n) ? n : undefined;
}

function pickOffer(raw: unknown): { price?: number; priceCurrency?: string; availability?: string } {
  if (!raw || typeof raw !== "object") return {};
  const first = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
  const price = first["price"] ?? (first["priceSpecification"] as Record<string, unknown> | undefined)?.["price"];
  return {
    price: asNumber(price),
    priceCurrency: asString(first["priceCurrency"]),
    availability: stripSchema(asString(first["availability"])),
  };
}

function pickRating(raw: unknown): { average?: number; count?: number } {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    average: asNumber(r["ratingValue"]),
    count: asNumber(r["reviewCount"] ?? r["ratingCount"]),
  };
}

function pickBrand(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") return asString((raw as Record<string, unknown>)["name"]);
  return undefined;
}

function pickImages(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) {
    return raw
      .map((i) => (typeof i === "string" ? i : asString((i as Record<string, unknown>)["url"])))
      .filter((u): u is string => !!u);
  }
  if (typeof raw === "object") {
    const u = asString((raw as Record<string, unknown>)["url"]);
    return u ? [u] : [];
  }
  return [];
}

/**
 * Product spec rows from the JSON-LD `additionalProperty` (schema.org
 * `PropertyValue[]`) array, when the product page's `Product` block carries
 * one. Some product-page templates (live-verified 2026-09-27, e.g. Mikrotik
 * CRS304-4XG-IN) render specs this way instead of — or in addition to — the
 * `.paramTbl` DOM table `PRODUCT_PAGE_EXTRACTOR` scrapes, so `getProduct`
 * merges both sources rather than relying on the DOM table alone (which
 * returned nothing at all for that product despite Alza's own page data
 * clearly listing e.g. "Počet LAN portů s rychlostí 10 Gbit": "4").
 */
export function pickAdditionalProperties(raw: unknown): ProductParam[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductParam[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name = decodeBasicEntities(asString((entry as Record<string, unknown>)["name"]) ?? "").trim();
    const value = decodeBasicEntities(asString((entry as Record<string, unknown>)["value"]) ?? "").trim();
    if (name && value) out.push({ name, value });
  }
  return out;
}

/**
 * JSON-LD `additionalProperty` strings arrive HTML-escaped (live 2026-10-06:
 * a monitor diagonal came back as `27 &quot; (68,58 cm)`). Decode the XML
 * entities plus numeric references instead of dropping them.
 */
function decodeBasicEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, n: string) => codePoint(m, Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n: string) => codePoint(m, parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Numeric reference -> character; an out-of-range reference is left as-is instead of throwing. */
function codePoint(raw: string, n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
}

function pickBreadcrumbs(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>)["itemListElement"];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => stripHtmlEntities(asString((item as Record<string, unknown>)["name"]) ?? ""))
    .filter(Boolean);
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function stripSchema(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.replace(/^https?:\/\/schema\.org\//, "");
}

export function stripHtmlEntities(s: string): string {
  // JSON-LD names are often double-encoded (`27&amp;quot; Philips`): undo the outer
  // `&amp;` first, then decode the common named and numeric entities so `27"`
  // keeps its inch mark (it was being deleted), and only then drop unknown ones.
  return decodeBasicEntities(s.replace(/&amp;(?=#?[a-z0-9]+;)/gi, "&")).replace(/&[a-z]+;/g, "");
}
