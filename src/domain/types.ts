export interface Product {
  /** Alza product code, e.g. "WEXOA002B0". This is the canonical identifier. */
  code: string;
  /** Numeric internal id used by REST endpoints (the `d<id>` in the product URL); 0 when unknown. */
  id: number;
  name: string;
  url: string;
  image?: string;
  /** Price as a number in the locale's currency. */
  price?: number;
  /** Original / strike-through price, if discounted. */
  originalPrice?: number;
  /**
   * Lowest price a buyer can pay without a membership, when the listing card
   * carries a promo code ("Kúpiť s kódom ALZADNI15"): `price` is then the shelf
   * price and `priceNow` the price with the code. Absent when there is no code.
   */
  priceNow?: number;
  /** The promo code behind `priceNow`, e.g. "ALZADNI15". */
  promoCode?: string;
  /** The code's percent (its trailing number), e.g. 15. */
  promoPercent?: number;
  /** AlzaPlus+ member price from the card's AlzaPlus+ box, when shown. */
  alzaPlusPrice?: number;
  /**
   * Set only for previously sold goods: "opened" (Rozbalené, opened box) or
   * "used" (Zánovné/Použité). Absent for new goods. Their price is a compromise
   * on condition, so it must not be compared with new goods' prices.
   */
  condition?: "opened" | "used";
  /** For `condition` goods: the price of the same product new ("Nový 165 €" on the card). */
  newPrice?: number;
  currency: string;
  /**
   * Normalised stock label shared by every tool (see availability.ts): "in
   * stock", "limited stock", "preorder", "out of stock", "discontinued", or —
   * search cards only — "not purchasable now".
   */
  availability?: string;
  /** The upstream text (schema.org token or CZ/SK display text) when it differs from `availability`. */
  availabilityText?: string;
  /** Only set when the page's schema.org JSON-LD availability disagrees with the visible line (`availability` follows the visible line). */
  jsonLdAvailability?: string;
  /** Rating on 0–5 scale (Alza serves 0–100, we normalize). */
  rating?: number;
  brand?: string;
  category?: string;
  /** Spec params (CPU socket, RAM type, etc.) — opaque key/values. */
  params?: ProductParam[];
}

export interface ProductParam {
  name: string;
  value: string;
}

export interface SearchResult {
  query: string;
  total: number;
  page: number;
  /**
   * How many organic cards one rendered Alza page holds (~24), i.e. the real
   * page capacity — not the requested `limit`.
   */
  pageSize: number;
  /**
   * True when Alza renders further result pages beyond the last one scanned
   * (pass `page` to read them). Absent for results that were never paged.
   */
  hasMore?: boolean;
  /** The `page` value that continues after the last scanned page; present when `hasMore`. */
  nextPage?: number;
  products: Product[];
  /**
   * How many candidate cards were scanned before filtering/sorting (one
   * page ≈ 24 for relevance/newest or explicit page; up to 3 pages ≈ 72
   * for a client-side price/rating sort). Useful context for "why only N
   * results" — the scan is bounded, not the whole catalog.
   */
  candidatesScanned?: number;
  /**
   * Slider (range) filters Alza's own category page actually applied, read
   * back from the page's filter request — values are snapped to the facet's
   * real steps. `empty: true` means no step fell inside the requested range,
   * so the result is empty without a page fetch.
   */
  appliedRanges?: AppliedRange[];
}

export interface AppliedRange {
  paramId: number;
  name?: string;
  from?: number;
  to?: number;
  /** Set when the requested range contains no facet step (no product can match). */
  empty?: boolean;
  /** Set when this range came from `min_screen_inches`/`max_screen_inches`. */
  fromScreenInches?: boolean;
}

export interface Category {
  id: number;
  name: string;
  url?: string;
  parentId?: number;
  childCount?: number;
}

export interface ProductReview {
  author?: string;
  date?: string;
  rating?: number;
  body?: string;
  /** Positive points the reviewer listed, when present. */
  pros?: string[];
  /** Negative points the reviewer listed, when present. */
  cons?: string[];
  verifiedPurchase?: boolean;
  /** Reviewed variant label, e.g. "iPhone 15 128GB cerna". */
  variant?: string;
  helpfulCount?: number;
}

export interface ProductReviews {
  code: string;
  ratingAverage?: number;
  reviewCount?: number;
  reviews: ProductReview[];
}

export interface FacetValue {
  /** Numeric value id — the `-par{paramId}-{valueId}` (or `-v{producerId}` for brands) URL segment. */
  valueId: number;
  description: string;
  /** Product count carrying this value, when Alza reports it. */
  count?: number;
  /**
   * Slider (range) facets only: the raw, unrounded step value in Alza's own
   * unit for this facet (e.g. millimetres for a monitor diagonal, inches for
   * a TV diagonal, Hz, kg, …). Pass these numbers as `min`/`max` of a range
   * filter in `search_products`'s `filters`.
   */
  value?: number;
}

export interface FacetGroup {
  /** Numeric param id — the `{paramId}` in `-par{paramId}-{valueId}`. */
  paramId: number;
  name: string;
  /** Alza's UI widget for this facet ("Checkbox", "Slider", …). */
  renderType: string;
  /**
   * True for Checkbox-type facets (filter by `value_id`) and Slider-type
   * facets (filter by `min`/`max` range over `values[].value`, live-verified
   * 2026-10-06; see docs/gap-analysis.md). For Checkbox facets this is
   * necessary but not sufficient: Alza only honours URL filters for facets it
   * publishes landing pages for, and silently redirects the rest to the
   * unfiltered category (live-verified 2026-10-03). `search_products` detects
   * that redirect and errors instead of returning unfiltered results.
   */
  filterable: boolean;
  /** How `search_products` filters on this group: `"value"` (`{param_id, value_id}`) or `"range"` (`{param_id, min?, max?}`). Absent when not filterable. */
  filterMode?: "value" | "range";
  values: FacetValue[];
}

export interface CategoryFilters {
  categoryId: number;
  /** Brands in this category — pass `valueId`s to `search_products` as `producer_ids`. */
  brands: FacetValue[];
  groups: FacetGroup[];
}

export interface PickupPoint {
  type: "alzabox" | "branch";
  id: string;
  name: string;
  address: string;
  city: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  /** Distance from query point, in km. */
  distanceKm?: number;
  openingHours?: string;
  /** Free-form note (e.g. "24/7", "self-service"). */
  note?: string;
  /** AlzaBox only: Alza's parcel-shop id (the `parcelShopId` used in checkout). */
  parcelShopId?: number;
  /** AlzaBox only: Alza's delivery-option id for the locker network (e.g. 2680). */
  deliveryId?: number;
}
