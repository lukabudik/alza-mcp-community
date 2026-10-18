import type { Product, ProductReviews, SearchResult, Category, PickupPoint, CategoryFilters } from "../domain/types.js";

export function formatPrice(price: number | undefined, currency: string): string {
  if (price === undefined) return "—";
  return `${price.toLocaleString("cs-CZ")} ${currency}`;
}

/** "OPENED BOX" / "USED" tag for previously sold goods; empty for new goods. */
export function conditionTag(p: Pick<Product, "condition" | "newPrice" | "currency">): string {
  if (!p.condition) return "";
  const label = p.condition === "opened" ? "OPENED BOX (previously sold, not new)" : "USED (previously sold, not new)";
  return p.newPrice !== undefined ? `${label}, new: ${formatPrice(p.newPrice, p.currency)}` : label;
}

export function formatProductLine(p: Product): string {
  const parts = [`**${p.name}**`];
  parts.push(`code: \`${p.code}\``);
  if (p.condition) parts.push(`⚠ ${conditionTag(p)}`);
  if (p.priceNow !== undefined && p.promoCode) {
    parts.push(`**${formatPrice(p.priceNow, p.currency)}** with code ${p.promoCode} (shelf ${formatPrice(p.price, p.currency)})`);
  } else if (p.price !== undefined) {
    parts.push(`${formatPrice(p.price, p.currency)}`);
  }
  if (p.alzaPlusPrice !== undefined) parts.push(`AlzaPlus+ ${formatPrice(p.alzaPlusPrice, p.currency)}`);
  if (p.availability) parts.push(p.availability);
  if (p.rating !== undefined) parts.push(`★ ${p.rating.toFixed(1)}`);
  return `- ${parts.join(" · ")}\n  ${p.url}`;
}

export function formatSearchResult(res: SearchResult): string {
  const scanned =
    res.candidatesScanned !== undefined ? ` (scanned ${res.candidatesScanned} candidates)` : "";
  const ranges = (res.appliedRanges ?? []).map((r) =>
    r.empty
      ? `${r.name ?? `param ${r.paramId}`}: no step in requested range`
      : `${r.name ?? `param ${r.paramId}`} ${r.from ?? "…"}–${r.to ?? "…"}`
  );
  const rangeNote = ranges.length > 0 ? ` [range filters: ${ranges.join("; ")}]` : "";
  if (res.products.length === 0) {
    return `No products found for **"${res.query}"**${scanned}${rangeNote}.`;
  }
  const lines: string[] = [
    `Top ${res.products.length} result(s) for **"${res.query}"**${scanned}${rangeNote}:`,
    "",
    ...res.products.map(formatProductLine),
  ];
  if (res.hasMore && res.nextPage) lines.push("", `More results exist: pass page=${res.nextPage} to continue.`);
  return lines.join("\n");
}

export function formatProduct(p: Product): string {
  const lines: string[] = [`# ${p.name}`, ``, `Code: \`${p.code}\``, `URL: ${p.url}`];
  if (p.condition) lines.push(`Condition: ⚠ ${conditionTag(p)} — a compromise on condition; do not rank it against new goods, but it may be a bargain`);
  if (p.price !== undefined) {
    let line = `Price: **${formatPrice(p.price, p.currency)}**`;
    if (p.originalPrice && p.originalPrice > p.price) {
      const save = p.originalPrice - p.price;
      line += ` (was ${formatPrice(p.originalPrice, p.currency)}, save ${formatPrice(save, p.currency)})`;
    }
    lines.push(line);
  }
  if (p.priceNow !== undefined && p.promoCode) {
    lines.push(`Lowest price you can pay: **${formatPrice(p.priceNow, p.currency)}** with code ${p.promoCode}${p.promoPercent ? ` (-${p.promoPercent} %)` : ""}; the price above is the shelf price`);
  }
  if (p.alzaPlusPrice !== undefined) lines.push(`AlzaPlus+ member price: ${formatPrice(p.alzaPlusPrice, p.currency)}`);
  if (p.availability) lines.push(`Availability: ${p.availability}${p.availabilityText ? ` (${p.availabilityText})` : ""}${p.jsonLdAvailability ? ` [structured data says: ${p.jsonLdAvailability}]` : ""}`);
  if (p.rating !== undefined) lines.push(`Rating: ★ ${p.rating.toFixed(1)} / 5`);
  if (p.brand) lines.push(`Brand: ${p.brand}`);
  if (p.category) lines.push(`Category: ${p.category}`);
  if (p.params && p.params.length > 0) {
    lines.push("", "## Specs");
    for (const param of p.params) {
      lines.push(`- **${param.name}**: ${param.value}`);
    }
  }
  return lines.join("\n");
}

export function formatReviews(r: ProductReviews): string {
  const lines: string[] = [`# Reviews for ${r.code}`];
  if (r.ratingAverage !== undefined) {
    lines.push(
      `Average: ★ ${r.ratingAverage.toFixed(1)}${r.reviewCount ? ` (${r.reviewCount} reviews)` : ""}`
    );
  }
  if (r.reviews.length === 0) {
    lines.push("", "_No individual reviews available._");
    return lines.join("\n");
  }
  // The count comes from the product page's aggregate; the list comes from the
  // reviews API, which can also include reviews from the other storefront
  // (live 2026-10-07: 11 on the page, 18 listed incl. Slovak ones).
  if (r.reviewCount !== undefined && r.reviews.length > r.reviewCount) {
    lines.push(
      `_Note: the list has ${r.reviews.length} reviews, more than the aggregate count of ${r.reviewCount}; the API appears to also return reviews from other storefronts (Slovak-language reviews have been seen), which the aggregate likely does not cover._`
    );
  }
  lines.push("", "## Recent reviews (newest first)");
  for (const rev of r.reviews) {
    const head = [rev.author ?? "Anonymous", rev.date, rev.rating !== undefined ? `★ ${rev.rating}` : null]
      .filter(Boolean)
      .join(" · ");
    lines.push(`### ${head}`);
    if (rev.body) lines.push(rev.body);
    if (rev.pros?.length) lines.push(`+ ${rev.pros.join("; ")}`);
    if (rev.cons?.length) lines.push(`- ${rev.cons.join("; ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatCategories(cats: Category[]): string {
  if (cats.length === 0) return "No categories.";
  return cats
    .map((c) => `- **${c.name}** (id: ${c.id})${c.childCount ? ` — ${c.childCount} subcategories` : ""}`)
    .join("\n");
}

export function formatCategoryFilters(filters: CategoryFilters): string {
  if (filters.brands.length === 0 && filters.groups.length === 0) {
    return "No filters for this category.";
  }
  const lines: string[] = [];
  if (filters.brands.length > 0) {
    lines.push("**Brands** (pass as producer_ids)");
    for (const v of filters.brands.slice(0, 30)) {
      const count = v.count !== undefined ? ` (${v.count})` : "";
      lines.push(`  - ${v.description}${count} → producer_id: ${v.valueId}`);
    }
    if (filters.brands.length > 30) lines.push(`  … ${filters.brands.length - 30} more brands`);
    lines.push("");
  }
  for (const g of filters.groups) {
    const isRange = g.filterMode === "range";
    const flag = !g.filterable
      ? " (not filterable via search_products — informational only)"
      : isRange
        ? " — range filter: {param_id, min?, max?} using the `value` numbers below"
        : " — checkbox filter: {param_id, value_id}; Alza only honours values it has a landing page for (e.g. HDMI), others (often panel type, resolution) make search_products error";
    lines.push(`**${g.name}** (param_id: ${g.paramId}, ${g.renderType})${flag}`);
    const last = g.values[g.values.length - 1];
    const shown = isRange && last && g.values.length > 15 ? [...g.values.slice(0, 14), last] : g.values.slice(0, 15);
    for (const v of shown) {
      const count = v.count !== undefined ? ` (${v.count})` : "";
      const id = isRange && v.value !== undefined ? `value: ${v.value}` : `value_id: ${v.valueId}`;
      lines.push(`  - ${v.description}${count} → ${id}`);
    }
    if (g.values.length > 15) lines.push(`  … ${g.values.length - 15} more values${isRange ? " (last step shown above)" : ""}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function formatPickupPoints(points: PickupPoint[], warnings: string[] = []): string {
  const notes = warnings.map((w) => `> ${w}`).join("\n");
  if (points.length === 0) {
    return [notes, "No pickup points found in the requested radius."].filter(Boolean).join("\n\n");
  }
  const lines: string[] = notes ? [notes, ""] : [];
  for (const p of points) {
    const head = `**${p.name}** (${p.type === "alzabox" ? "AlzaBox locker" : "showroom"})`;
    const distance = p.distanceKm !== undefined ? ` · ${p.distanceKm} km` : "";
    lines.push(`${head}${distance}`);
    lines.push(`  ${p.address}, ${p.city}${p.postalCode ? ` ${p.postalCode}` : ""}`);
    if (p.openingHours) lines.push(`  Open: ${p.openingHours}`);
    if (p.parcelShopId !== undefined) lines.push(`  parcelShopId: ${p.parcelShopId}`);
    if (p.note) lines.push(`  ${p.note}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
