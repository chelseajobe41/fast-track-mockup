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

It is NOT a CMS (not Shopify/WordPress/Squarespace). It is a hand-built Node.js app. There is
no admin UI for editing products — product data lives in JSON files edited through code.

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
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — protects /admin
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
| Store page (search, filters, cart drawer) | `store.html` |
| AI upload page | `upload.html` |
| Kits listing | `kits.html` |
| Single kit page (+ Product JSON-LD) | `kit.html` |
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
- The deny-list middleware in server.js (before express.static) blocks public access to
  orders.json, inventory.json, kits.json, server.js, package.json, node_modules, .git, .claude.
  Keep it. It prevents customer PII (orders.json) from being downloadable.
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

- Catalog: 56 products, alphabetized, all with real photos (one was last to land:
  construction-12x18).
- Shipping: flat $9.95 every order.
- Tax: Stripe Tax enabled in code; Houa registered Minnesota (collecting tax confirmed).
- Business entity: Fast Track School Supplies Inc (MN corp), mailing 3225 McLeod Dr, Suite 100,
  Las Vegas, NV 89121, contact Main@fasttrackschoolsupplies.com.
- Repo visibility: public (so Render auto-deploys). Not yet transferred to Houa.
