# Fast Track School Supplies — Project Operating Manual

This file is the source of truth for how this project works. Read it before making changes.
It is written for Claude Code (and for Chelsea) to understand the architecture, the ownership
split, and exactly how updates reach the live site.

---

## 1. What this is

A custom-coded e-commerce site for **Fast Track School Supplies Inc** (a Minnesota corporation,
operating from a Las Vegas mailing address). It sells school supplies, pre-built grade-level
kits, gift kits, and subscriptions. It was built as an agency deliverable for the client
("Houa Moua", email mouah07@gmail.com). Live at **https://fasttrackschoolsupplies.com**.

It is NOT a CMS (not Shopify/WordPress/Squarespace). It is a hand-built Node.js app. It DOES now
have a self-service admin "Product Manager" (see section 12) so the client can edit products,
prices, photos, and shipping himself — but the app itself is custom code, not a CMS.

---

## 2. Tech stack

- **Backend:** Node.js + Express (`server.js`)
- **Frontend:** plain HTML/CSS/vanilla JS (no framework, no build step)
- **Payments:** Stripe Checkout (one-time + subscriptions), Stripe webhooks, Stripe Customer Portal, Stripe Tax
- **AI:** Anthropic Claude (vision) parses uploaded school-supply-list photos on `/upload`
- **Data storage:** flat JSON files (`products.json`, `kits.json`, `inventory.json`, `orders.json`)
- **Hosting:** Render (Node web service, paid Starter tier, always-on, persistent disk)
- **Domain registrar:** CheapNames
- **Email:** none in code — Stripe sends all customer emails (receipts, renewals, dunning)

---

## 3. Ownership map — THE KEY THING TO UNDERSTAND

The work is split across two people's accounts. This is deliberate and is what lets Chelsea
push updates forever without owning the hosting.

| Thing | Owner | Account |
|---|---|---|
| **GitHub repo (the code)** | **Chelsea** | github.com/chelseajobe41/fast-track-mockup |
| Render hosting | Houa (client) | render.com, mouah07@gmail.com |
| Domain | Houa (client) | CheapNames, mouah07@gmail.com |
| Stripe account | Houa (client) | dashboard.stripe.com, mouah07@gmail.com |
| Anthropic API account | Houa (client) | console.anthropic.com, mouah07@gmail.com |

**Chelsea owns the code. Houa owns the hosting and all the money/service accounts.**

---

## 4. How updates reach the live site (the magic)

This is the most important section. Chelsea can update the live site forever WITHOUT ever
logging into Houa's Render, Stripe, domain, or Anthropic accounts. Here is why:

1. The GitHub repo is **public** and lives on **Chelsea's** account.
2. Houa's Render service is connected to that public repo and is set to **auto-deploy on push**.
3. So the flow is:

   ```
   Chelsea edits files locally
        -> git commit
        -> git push origin main   (pushes to Chelsea's GitHub repo)
        -> Render detects the new commit on the repo it's watching
        -> Render automatically pulls, rebuilds, and redeploys (~2 minutes)
        -> changes are live at fasttrackschoolsupplies.com
   ```

**Chelsea never touches Houa's Render account to ship an update.** She only pushes to her own
GitHub. Render does the rest automatically because it is watching the repo.

This is the answer to "how do I push updates without owning the Render." You don't need to own
the Render. You own the code; his Render watches your code; pushing your code deploys his site.

### What would BREAK this auto-deploy bridge
- Making the repo **private** — Render's public-URL connection stops working until Render is
  reconnected to GitHub via authorized access. (Doable, but a one-time reconnect step that
  requires Houa's Render login.)
- Houa **disconnecting** the repo from his Render service.
- Houa's Render **billing lapsing** (the $7/mo Starter plan must stay active).
- Transferring the repo to Houa's GitHub account — then Chelsea needs to be re-added as a
  collaborator to keep pushing.

**Recommendation: keep the repo public.** It is the simplest setup. The code being publicly
*viewable* is not a security risk — no secrets are in the code (see section 6). Nobody can
*edit* the repo except Chelsea. Nobody can change the live site, the admin, or customer data.

---

## 5. The standard update workflow (for Claude Code)

Working directory: `/Users/chelseajobe/fast-track-mockup`

1. Make the edits (see section 7 for which file does what).
2. Validate: `node --check server.js` if server.js changed.
3. (Optional but preferred) preview locally — see section 8.
4. Commit and push:
   ```
   git add -A
   git commit -m "Describe the change"
   git push origin main
   ```
5. Render auto-deploys in ~2 minutes. Confirm by curling the live URL or telling Chelsea to
   hard-refresh (Cmd+Shift+R) since browsers cache aggressively.

Node binary on this machine: `/Users/chelseajobe/.local/node/bin/node` and `.../npm`.

---

## 6. Secrets / environment variables (live ONLY in Houa's Render, never in code)

These are set in Render -> service -> Environment. They are NOT in the repo (`.env` is
gitignored). The public repo exposes none of them.

- `STRIPE_SECRET_KEY` — Houa's live Stripe key
- `STRIPE_WEBHOOK_SECRET` — from the Stripe webhook endpoint
- `STRIPE_PORTAL_URL` — Stripe-hosted customer portal login URL (may or may not be set)
- `ANTHROPIC_API_KEY` — Houa's Claude API key (powers /upload list parsing)
- `BASE_URL` — https://fasttrackschoolsupplies.com
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — protects /admin. The server now FAILS CLOSED: it refuses to
  boot in production (BASE_URL = the live domain) if `ADMIN_PASSWORD` is unset or the default
  `change-me`. So this env var must stay set on Houa's Render, or a deploy will not come up.
- (Stripe Tax is enabled in code via `automatic_tax: { enabled: true }`; the MN registration
  lives in Houa's Stripe dashboard, not in code.)

Because env vars live in Houa's Render, Chelsea cannot run the live integrations locally unless
she sets her own test values. Locally, Stripe/Anthropic features will no-op or error without
keys — that is expected and fine for editing content/markup.

---

## 7. File map — what to edit for what

| To change... | Edit |
|---|---|
| Product price, name, description, image, keywords | `products.json` |
| Add/remove a product | `products.json` (+ add an entry in `inventory.json`) |
| Kit contents / quantities | `kits.json` |
| Stock levels / low-stock thresholds | `inventory.json` (admin dashboard also writes this) |
| Homepage copy/layout | `index.html` |
| Store page (search, filters, cart drawer) | `store.html` (SSR — see note below) |
| AI upload page | `upload.html` |
| Kits listing | `kits.html` |
| Single kit page (+ Product JSON-LD) | `kit.html` (SSR template — see note below) |
| Grandparent gift flow | `gift.html` |
| FAQ (+ FAQPage schema) | `faq.html` |
| Legal pages | `terms.html`, `privacy.html`, `shipping.html`, `returns.html` |
| Admin dashboard | `admin.html` |
| Checkout success/cancel | `success.html`, `cancel.html` |
| Server routes, Stripe checkout, webhook, shipping rate, tax flag | `server.js` |
| Shared animations, logo wordmark, mobile menu, cookie banner, a11y | `motion.js`, `motion.css` |
| Product photos | `assets/products/<id>.png|jpg` (referenced by absolute https URL) |
| SEO/AEO | `sitemap.xml`, `robots.txt`, `llms.txt`, per-page meta + JSON-LD |

Product images MUST be absolute `https://fasttrackschoolsupplies.com/...` URLs in products.json.
Relative paths break Stripe Checkout ("Not a valid URL"). The placeholder
`/assets/photo-coming.svg` is filtered out of the Stripe payload in server.js for that reason.

Key server.js constants: `FLAT_SHIPPING_CENTS` (currently 995 = $9.95), `KIT_DISCOUNT` (0.10),
`SUBSCRIPTION_DISCOUNT` (0.10).

### Server-side rendering (SEO) — do NOT revert to sendFile

Kit detail pages and the store page are **server-side rendered** so Google sees correct
canonical/title/schema in the initial HTML (client JS runs too late for crawlers).

- **Kit pages use clean URLs: `/kits/<id>`** (e.g. `/kits/kindergarten`). The old `/kit?id=<id>`
  301-redirects to the clean path. `kit.html` is a TEMPLATE with placeholder tokens
  (`{{KIT_TITLE}}`, `{{KIT_CANONICAL}}`, `{{KIT_DESCRIPTION}}`, `{{KIT_OG_TITLE}}`, `{{KIT_H1}}`,
  and the `<!--KIT_JSONLD-->` comment). `renderKitPage()` in server.js fills these per kit with a
  self-referencing canonical and a VALID Product JSON-LD (real price/availability) built from
  `buildKitDetail()`. The client JS hydrates the interactive cart and reads the kit id from the
  URL path (`getKitId()` parses the path, not a query string).
- **`/store` is rendered by `renderStorePage()`** which injects an `ItemList` of Products (with
  offers) before `</head>` AND server-renders the product grid, filter chips, result count, and a
  `window.__STORE_INVENTORY__` stock snapshot into `store.html` (so the page paints at full height —
  no layout shift — and out-of-stock state survives a failed inventory fetch). The client `render()`
  still re-runs on load for the interactive cart; the SSR card markup in server.js
  (`storeCardHtml`/`storeProductGridHtml`/`storeFilterChipsHtml` + `STORE_CATEGORIES`) is a hand-port
  of the client template in store.html — **change one, change both.** Token substitution uses function
  replacers (`.replace(x, () => v)`), not string replacers, to avoid `$`-sequence corruption.
- `kit.html` and `store.html` are in the deny-list so the raw templates (with unfilled tokens)
  cannot be fetched directly.
- When editing these two files, KEEP the placeholder tokens / `</head>` structure intact, and
  do NOT re-add a client-side Product schema injector to kit.html (the server provides the only
  valid one). Internal links to kits must use `/kits/<id>`, never `/kit?id=`.

---

## 8. Local preview (for verifying before push)

There is a `.claude/launch.json` configured with a server named `fast-track` on port 3001.
Use the preview tooling (preview_start name "fast-track") rather than backgrounding node by hand.
The Node server serves all static files + the APIs. Without Stripe/Anthropic env vars,
checkout and AI parsing will error locally — that is expected; verify markup/content/data instead.

To sanity-check data integrity after editing JSON, confirm: products.json and inventory.json have
matching ids, no kit references a missing product id, and every product image is an https URL or
the placeholder.

---

## 9. Things to NEVER break

- Do not put real secret keys in any committed file. `.env` stays gitignored.
- Do not give product images relative URLs in products.json (breaks Stripe Checkout).
- Do not leave payment-mode-only Stripe params (`shipping_options`, `customer_creation`) at the
  top level of the checkout session — they must be inside the `if (!isSubscription)` branch.
  In subscription mode Stripe rejects them.
- The deny-list middleware in server.js (before express.static) blocks public access to orders.json,
  inventory.json, kits.json, settings.json, products-draft.json, server.js, package.json, admin.html,
  .env, node_modules, .git, .claude. It CANONICALIZES the request path first (`canonicalPath()`:
  decode %-encoding, collapse slashes/backslashes, resolve `.`/`..`, case-insensitive) BEFORE matching,
  so encoding/traversal variants (`/orders%2ejson`, `//orders.json`, `//.git/config`) can't slip a
  protected file past it. Keep both the canonicalization and the list; add any new sensitive file to
  DENY_PATHS. It prevents customer PII (orders.json) exposure.
- Checkout is server-authoritative on price: `normalizeCart` looks up every price by `sku_id` from the
  in-memory catalog and aggregates duplicate SKUs. NEVER trust a price/name from the client, and don't
  reintroduce the kit + subscription discount stacking (a kit on a subscription must get ONE 10%).
- The Stripe webhook is idempotent: `logOrder()` dedupes by order id and returns whether it appended;
  inventory is decremented ONLY when a new order was logged, and the handler returns 500 on error so
  Stripe safely retries. Don't "simplify" that back to an unconditional write.
- Flat-file reads (`readProducts/readInventory/readOrders`) default ONLY on a missing file and THROW
  on a corrupt one — so a read-modify-write never overwrites real data with an empty result. Do NOT
  change them back to returning `[]`/`{}` on any read error (that silently wipes orders/inventory).
- The `/api/parse-list` rate limit relies on `app.set('trust proxy', 1)` + `req.ip` (plus a global
  ceiling + a concurrency guard). Don't revert to keying off a raw `x-forwarded-for` header.
- Batch pushes when possible. Every push triggers a Render rebuild.

---

## 10. Client-handling notes (for Chelsea)

- Pricing: $150 flat for changes that fit in an email; $200/hr (1-hour minimum) for technical
  fixes/troubleshooting; bigger features quoted separately. No monthly care plan offered to this
  client.
- When sending email drafts to Chelsea, write PLAIN TEXT (no markdown bold/em-dashes/lists) so
  it pastes into Gmail cleanly. Best path: write to a temp file and `pbcopy` it so no app styling
  rides along. Chelsea pastes with Cmd+V (or Cmd+Shift+V to force plain text).
- The site launched with zero traffic — the growth opportunity (analytics, SEO, local marketing,
  email capture) is the Visible Local upsell, to revisit once Houa has sales.

---

## 11. Quick status (update this as things change)

- Catalog: 55 products, alphabetized, real photos — compressed + self-hosted at `/assets/products/`
  (~2.5 MB total, no external CDN dependency).
- Shipping: configurable in admin (flat or order-total tiers) — see section 12. Subscriptions now
  charge shipping too (a recurring line item), not just one-time orders.
- Tax: Stripe Tax enabled in code; Houa registered Minnesota (collecting tax confirmed).
- Business entity: Fast Track School Supplies Inc (MN corp), mailing 3225 McLeod Dr, Suite 100,
  Las Vegas, NV 89121, contact Main@fasttrackschoolsupplies.com.
- Repo visibility: public (so Render auto-deploys). Not yet transferred to Houa.
- **Product Manager / self-service admin: LIVE on `main`.** Deployed and in production; the Render
  persistent disk is active (`DATA_DIR=/var/data`), and a real Stripe order + organization code were
  verified end-to-end in prod. (The old "$1,400, branch `product-manager`, pending payment" status is
  historical — it shipped.)
- **Admin now includes a Financials tab** — revenue by day / week / month / quarter / year / all-time,
  with a Daily/Monthly/Yearly chart + table, computed client-side from the order list in local time.
- **Custom-code updates shipped this cycle (all live):** organization code is a Stripe Checkout
  custom field (shows on the payment page for every flow); the `/upload` page's matched list has an
  "Add to cart" action that puts items in the shared persistent cart (survives navigation); the
  `/store` product grid is server-rendered (SSR); product images compressed/self-hosted; a full
  security + correctness hardening pass (see section 9, commit `8143e84`).
- Accessibility/CWV: storefront pages score Accessibility 100 (WCAG 2.2 AA); homepage/store CLS in
  Google's "good" band. `/kits/:id` and `/gift` still client-render their lists (higher CLS) — deferred
  until Houa drives traffic.

---

## 12. Product Manager / self-service admin (LIVE on `main`)

Adds owner self-service to `/admin` (same Basic-Auth login). Redesigned as a Shopify-style app:
left sidebar (Home / Orders / Financials / Products / Shipping / Storefront), KPI dashboard,
slide-over editors. Inventory is merged INTO Products (stock pill on each row; stock stepper +
low-stock threshold inside the editor — one Save writes product + stock). No separate Inventory tab.

### Premium features (dashboard, fulfillment, storefront, power tools)

- **Living dashboard (Home)** — `GET /api/admin/overview` returns: week-vs-prior-week revenue/orders
  trends + AOV, a 14-day `revenue_series` (rendered as an inline SVG sparkline), best sellers with
  images + revenue, a "needs your attention" feed (out-of-stock / low / no-photo, kit-critical items
  ranked first via `kitItemIds()`), and a "store readiness" score (share of catalog that's in stock +
  has a photo + has a description, plus kits-ready count).
- **Financials tab** — revenue by Today / This week / This month / This quarter / This year / All time
  (six KPI cards), plus a "Revenue over time" card with a Daily/Monthly/Yearly toggle driving a bar
  chart + itemized table. Computed entirely client-side (admin.html) from `GET /api/admin/orders`, so
  every period boundary lands in the owner's LOCAL time. Revenue = total collected at checkout
  (`amount_total_cents`, incl. shipping + tax). No server route added.
- **Fulfillment cockpit (Orders)** — order list with search + status chips (pending/packed/shipped);
  clicking an order opens a slide-over drawer with a status stepper (`POST /api/admin/orders/:id/
  fulfillment`, states validated, sets `packed_at`/`shipped_at`), pick list, ship-to, org code, and a
  **printable packing slip** at `GET /api/admin/orders/:id/packing-slip` (standalone print view).
- **Storefront customizer (Storefront)** — announcement bar (toggle/text/link, `javascript:` links
  stripped), editable hero title/subtitle, and up-to-8 featured products. Saved to
  `settings.content_draft`; served into the store via SSR token replacement (`{{HERO_TITLE}}`,
  `{{HERO_SUBTITLE}}`, `<!--ANNOUNCEMENT_BAR-->`) + a `window.__STORE_CONTENT__` script for featured
  badges. Goes through the SAME Draft→Preview→Publish flow as the catalog (see below).
- **Power tools** — multi-select mode in Products → bulk restock (`POST /api/admin/bulk/inventory`,
  instant) and bulk price change (`POST /api/admin/bulk/price`, draft); one-click **Duplicate** in the
  editor (`POST /api/admin/products/:id/duplicate`); and a **⌘K command palette** to jump to any
  product/order/page. NB: bulk routes live under `/api/admin/bulk/*` to avoid being shadowed by
  `/api/admin/products/:id` and `/api/admin/inventory/:skuId`.

### Unified Draft → Preview → Publish (catalog + storefront)

Catalog edits write `products-draft.json`; storefront edits write `settings.content_draft`. ONE global
"unpublished changes" bar (`GET /api/admin/pending` → `draftSummary()` with `content_changed`) shows
whenever either exists. `POST /api/admin/publish` promotes both atomically (guards kits, prunes
inventory, `reloadCatalog()`); `POST /api/admin/discard-draft` clears both AND prunes inventory rows
for never-published draft products. A store-preview token makes `/store`, `/kits/:id`, `/products.json`
and `/api/store-content` render the drafts with a fixed "not live yet" banner (shown for ANY valid
preview session — catalog OR content draft); checkout is blocked in preview. Stock + shipping stay
instant (operational). Verified by a 97-check end-to-end suite run 10× (970/970).

- **Products tab** — searchable, category-grouped list (same keyword rules as the storefront
  chips); add/edit/remove products (name, price, description, keywords) and upload photos from the
  computer. Product ids are immutable (kits + order logs reference them). Deleting a product that's
  in a kit is blocked (409 + names the kits). Destructive/irreversible actions use inline two-step
  "armed" buttons, never native confirm() dialogs.

### Draft → Preview → Publish (catalog edits are NOT instant-live)

Product edits write to `products-draft.json` in `DATA_DIR` (deny-listed from static serving), NOT
the live catalog. The admin shows an "unpublished changes" bar (summary + Preview / Discard /
Publish). `POST /api/admin/preview` mints a 30-min token; `/store?preview=<token>` sets an HttpOnly
cookie and renders the DRAFT catalog with a fixed "not live yet" banner (kit pages + /products.json
are preview-aware too). Checkout is blocked in preview sessions (guard runs before the Stripe-config
check). `POST /api/admin/publish` promotes draft → `products.json`, prunes inventory rows for
removed products, and calls `reloadCatalog()`; `POST /api/admin/discard-draft` throws the draft
away. Stock and shipping stay INSTANT (operational, not presentational). Photo uploads get a unique
filename per upload (`<id>-<ts>.<ext>`) so the live catalog keeps the old image until publish.
A no-op edit (draft identical to published) auto-discards the draft — no phantom "unpublished" bar.
- **Shipping tab** — flat rate OR order-total tiers ("up to $30 → $9.95", … , "all larger → $19.95").
  Checkout computes shipping via `shippingCentsFor(subtotalCents)` from `settings.json`; cart pages
  fetch `/api/shipping-config` to show a matching amount.
- **Organization codes** — an optional Stripe Checkout `custom_field` (`custom_fields[].key = 'orgcode'`
  in `/api/checkout`) so the "Organization or fundraiser code" box appears on the Stripe payment page
  for EVERY flow (store cart, uploaded list, kit, gift). The webhook reads it from
  `session.custom_fields` (with a metadata fallback for pre-change orders). The Orders tab shows the
  code per order + a summary card (orders + total per code) for rebates. Tracking only, no discount.
  (This replaced the earlier cart-drawer input, which only worked from the store page.)

### Data now lives on a persistent disk, NOT the repo (critical)

Live `products.json`, `inventory.json`, `orders.json`, `settings.json`, and uploaded images live in
`DATA_DIR` (`process.env.DATA_DIR`, resolved absolute). Reads/writes go there; `writeJsonAtomic`
(temp+rename) is crash-safe. Every product write calls `reloadCatalog()` which refreshes the
in-memory `PRODUCTS`/`PRODUCT_BY_ID`/`SYSTEM_PROMPT` (now `let`) so checkout/kits/store/AI use fresh
data with no restart. On first boot `DATA_DIR` is seeded from the repo copies. `/products.json` is
served from memory; uploaded images serve via `GET /uploads/:file` (path-traversal guarded).

**Why:** without this, a git deploy would revert the client's admin edits AND wipe order history
(the repo files overwrite on checkout). The disk keeps live data durable across deploys.

### Render setup — DONE (one-time, on Houa's Render — he owns it)

This is already in place on prod (kept here for reference / disaster recovery):
1. **Persistent Disk** (1 GB, mounted at `/var/data`) — added.
2. Env var `DATA_DIR=/var/data` — set.
3. `main` deployed; first boot seeded `/var/data` from the repo copies.
If `DATA_DIR`/disk is ever missing, the app safely falls back to repo files (pre-build behavior).
Also required in prod: a strong `ADMIN_PASSWORD` env var — the server now REFUSES to boot in
production if it's unset or the default (see section 6).

### Local review / testing

Run with a scratch data dir so admin edits don't churn the repo:
`DATA_DIR=./.localdata ADMIN_USERNAME=admin ADMIN_PASSWORD=<pw> node server.js`
(`.localdata/` is gitignored; it seeds from the repo copies on first boot.)
