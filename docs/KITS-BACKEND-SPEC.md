# Spec: Editable Grade Kits in the Admin ("Kit Builder")

> Status: **Parked / not built.** Scoped for a future quote. Lives on the `product-manager`
> branch alongside the rest of the self-service admin work. Nothing here is live.

## 1. Summary

Let Houa create and edit the grade-level kits himself from `/admin` — kit name, grade, age range,
tagline, and **which products are in the kit and how many of each** — instead of those living only in
code. It rides the same Draft → Preview → Publish rails already built for products and storefront.

- **Effort:** ~1 focused day. The biggest of the add-ons so far.
- **Risk:** Moderate — kits are live SEO landing pages *and* a checkout path, so the correctness bar
  is higher than for a plain product. The existing preview/publish safety + 10× test harness manage it.
- **Suggested price:** treat as its own add-on line item, **~$500–$750** (Product Manager ballpark),
  toward the higher end if the kit-builder UI needs to be very polished. See §9.

## 2. What Houa will be able to do (client-facing, plain English)

In a new **Kits** area of his dashboard he can:

- **Edit an existing kit** — rename it, change the grade/age/tagline, and adjust the product list:
  add a product, remove one, or change the quantity (e.g. "6 glue sticks → 8").
- **Build a brand-new kit** from scratch — name it, then search his own catalog and drop in products
  with quantities. He sees the bundle price and total item count update as he builds.
- **Preview and publish** — exactly like products: his kit changes are a draft only he can see, he
  clicks **Preview store** to see the real kit page, then **Publish** to make it live. Nothing
  half-finished ever reaches customers or Google.
- **Remove a kit** he no longer offers.

Guardrails so he can't break anything: a kit can't be published empty or pointing at a product that
doesn't exist; the bundle discount stays a fixed rule he doesn't touch; and a kit that's live keeps
working right up until he publishes a change.

## 3. Scope

**In scope**
- CRUD for kits: name, `grade_label`, `age_range`, `tagline`, `hero_color`, and `items[{id, quantity}]`.
- A Kits tab + kit editor with a searchable product picker and per-line quantities.
- Full Draft → Preview → Publish integration (kits fold into the existing unified publish bar).
- Validation + guardrails (see §7).
- Tests added to the existing end-to-end suite; 10× clean before ship.

**Out of scope (unless separately requested)**
- Changing the **bundle discount %** (`KIT_DISCOUNT`, currently 10%) from the UI — stays a code constant.
- Per-kit hero images / rich media (kits use a `hero_color` swatch today).
- Reordering kits in the index, or drag-and-drop item ordering (items can be shown catalog-sorted).
- Kit-level sale pricing (kits already have the bundle discount; item sales don't stack — see the
  on-sale feature).

## 4. Data model

Today `kits.json` is loaded **once at boot** from the repo into a `const KITS` (server.js:80). To make
it editable it becomes mutable data on the persistent disk, mirroring products exactly:

- Move the live copy to `DATA_DIR/kits.json`; seed from the repo copy on first boot (`seedDataFile`).
- `let KITS`, refreshed by a `reloadKits()` (or fold into `reloadCatalog()`), so edits take effect
  with no restart — same pattern as `PRODUCTS`.
- Add a **kits draft**: `DATA_DIR/kits-draft.json` (parallel to `products-draft.json`), with
  `readKitsDraft()/workingKits()/saveKitsDraft()`, and add it to the deny-list.

Kit shape (unchanged):
```json
{
  "kindergarten": {
    "name": "Kindergarten Starter Kit",
    "grade_label": "Kindergarten",
    "age_range": "Ages 5-6",
    "tagline": "Everything a brand-new student needs to walk in confident.",
    "hero_color": "#FDE7B5",
    "items": [{ "id": "backpack", "quantity": 1 }, { "id": "crayon", "quantity": 4 }, ...]
  }
}
```

## 5. API (all behind `requireAdmin`, all draft-aware)

- `GET /api/admin/kits` — list working kits (draft ∪ published) with computed bundle price + stock.
- `POST /api/admin/kits` — create; server slugs a unique immutable `kit_id` from the name.
- `POST /api/admin/kits/:id` — update meta + items.
- `DELETE /api/admin/kits/:id` — remove (draft).
- Publish/discard/preview reuse the **existing** `/api/admin/publish`, `/discard-draft`, `/preview`
  (extended to also promote/clear the kits draft and include kit changes in `draftSummary()` and the
  preview banner).

Validation: every item `id` must exist in the **working** catalog; quantities are positive integers;
a kit needs ≥1 item; `hero_color` is a hex color; name required. Reject bad input with 400.

## 6. Admin UI

- New **Kits** nav item + `#panel-kits`: a list of kits (name, grade, item count, bundle price,
  "all in stock?" pill), plus **+ New kit**.
- **Kit editor** (slide-over, like the product editor) with two parts:
  1. **Meta:** name, grade label, age range, tagline, hero-color swatch.
  2. **Items:** a searchable product picker; adding a product creates a line with a quantity stepper;
     remove per line. A live footer shows **item count + bundle price** (base sum − 10%).
- Reuses existing patterns: search box, category chips, stepper, slide-over drawer, armed-delete,
  toasts. The **net-new** piece is the nested item-picker-with-quantities (this is the main work).

## 7. Guardrails & edge cases (the risk area)

- **No empty/broken kit goes live.** Publish already guards `brokenKits` (server.js:1476); extend the
  same idea to the kits draft — can't publish a kit with 0 items or a missing product id.
- **Kit pages are SEO landing pages.** `/kits/:id` is SSR'd with JSON-LD + canonical + titles
  (`renderKitPage`). Draft kit edits must only show under a preview token; the live page is untouched
  until publish. A **deleted** kit's URL should 404/redirect to `/kits` (it already redirects when a
  kit isn't found) — note this is a minor SEO loss for a previously-indexed URL; consider a 301 to
  `/kits` and updating `sitemap.xml`.
- **Checkout stays correct.** Kit purchases pass `kit_id`; `normalizeCart` (server.js:1035) re-derives
  prices from the **current** kit, so a composition change can't mis-charge an in-flight cart.
- **Product delete guard** (`kitsUsing`, server.js:1069/1378) keeps working; with editable kits Houa
  can now remove a product from its kits first, then delete it.
- **Dashboard** readiness (`kits_ready`/`kits_total`, server.js:1137) reads live and needs no change.
- `kits.html` (the index) fetches `/api/kits`, so it auto-updates.

## 8. Consumers to route through the working/preview kits (from `grep KITS server.js` — 11 sites)

boot load (80) · `/kit` redirect (569) · `/kits/:id` SSR (573-575) · `/api/kits` list (718-721) ·
`/api/kits/:id` (793-794) · `buildKitDetail` (750-751) · checkout `kit_id` (1035) · `kitItemIds`/
`kitsUsing` delete guard (1065-1069, 1378) · dashboard readiness (1137, 1162) · publish `brokenKits`
guard (1476). Each `KITS` read becomes a getter that respects published vs. draft-in-preview, mirroring
`catalogFor(req)` / `contentFor(req)`.

## 9. Effort, risk, and pricing

| | |
|---|---|
| Effort | ~1 focused day |
| Risk | Moderate (SEO pages + checkout + bundle pricing) |
| De-risked by | Mutable-data + draft/preview/publish + 10× test harness already exist |
| New work | Kit-builder UI (nested item picker) + routing kit reads through the draft/preview layer |
| Suggested price | **$500–$750** add-on (higher end for a very polished builder) |

Pricing note: this is comparable to the core Product Manager because the item-picker UI is real and
the correctness bar is higher (live SEO + checkout). Don't under-quote it as a "small tweak."

## 10. Open decisions (confirm before building)

1. **Create new kits, or only edit the 8 existing ones?** (Full CRUD assumed above.)
2. **Can he change the bundle discount %?** (Assumed no — stays 10% in code.)
3. **Deleted-kit URL:** 301 to `/kits` + drop from sitemap, or plain 404? (301 recommended.)
4. **Hero color:** keep the swatch, or add a small preset palette so kits stay on-brand?
5. **Item ordering** on the kit page: keep catalog/alphabetical, or let him drag to reorder? (Adds UI.)

---
*Prepared as a parked spec. When greenlit, build on the `product-manager` branch and verify with the
existing suite (10× clean) before merge.*
