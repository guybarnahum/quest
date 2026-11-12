# AGENTS.md — Quest Repository Guide & Handoff State

> **Instructions for AI Agents:** Read this file at the start of every task. Whenever you add routes, modify database tables, or change loader/action contracts, update this document so it stays the single source of truth.

---

## 1. Environment & Shell Rules (Critical)
- **OS / Shell:** macOS running `zsh` **without** `interactivecomments` enabled.
- **Rule:** **Never include `#` comment lines in shell commands.**
- **Validation Commands:**
  - `npm run typecheck` (`wrangler types && react-router typegen && tsc -b`)
  - `npm run build` (`react-router build`)
  - `npm run dev` (local Vite + Cloudflare Workers dev server)

---

## 2. Product Overview & UX Direction
**Quest** is a reverse e-commerce marketplace ("bounty board" for slow buying of rare, out-of-print, vintage, or discontinued items—such as discontinued horology, rare print/books, archival garments, cameras, and vinyl).
- **Buyer Flow:** Buyers post a **Quest** with a committed maximum budget (`max_budget_cents`), reference photo, and strictness tier (`L1` Exact Match, `L2` Direct Alternative, `L3` Curated Open).
- **Seller Flow:** Collectors, vintage dealers, and boutiques discover Quests via hybrid search (`D1 FTS5` lexical + `Vectorize` semantic similarity), verify their external storefront reputation (`eBay`, `Discogs`, `Etsy`, `Grailed`, `Poshmark`), and pitch **Fulfillment Offers** with R2 proof photos.
- **Trust & Escrow Flow:** Accepting an offer locks funds in an **`EscrowMachine` Durable Object**, issues an address-masked prepaid shipping label, enforces a **5-business-day Ship-By SLA** alarm, and gives the buyer a **72-hour post-delivery inspection window** before auto-releasing funds via Stripe Connect.

---

## 3. Cloudflare Bindings (`wrangler.jsonc`)
All bindings are accessed via `import { env } from "cloudflare:workers"`:
- `env.quest_db` (**D1 Database** `quest-db`): SQLite tables (`users`, `seller_reputations`, `quests`, `quests_fts`, `offers`, `escrows`, `disputes`). Schema is in [schema.sql](schema.sql); seed data is in [seed.sql](seed.sql).
- `env.quest_assets` (**R2 Bucket** `quest-assets`): Stores Quest reference photos (`quests/...`), seller offer proof photos (`offers/...`), dispute evidence (`disputes/...`), and SVG prepaid shipping labels (`labels/...`).
- `env.VECTORIZE` (**Vectorize Index** `quest-embeddings`): 384-dimension cosine similarity index.
- `env.AI` (**Workers AI**): Runs `@cf/baai/bge-small-en-v1.5` for 384-dim text embeddings.
- `env.ESCROW_MACHINE` (**Durable Object** `EscrowMachine` in [workers/escrow-machine.ts](workers/escrow-machine.ts)): Manages stateful escrow transitions and `alarm()` timers.

---

## 4. Route Map & Data Contracts (For UI/UX & Feature Work)

When redesigning UI/UX, preserve the `loaderData` props and `<Form>` field names/`intent` values below so backend actions continue working seamlessly:

| Route | File | `loaderData` Contract | `<Form method="post">` Actions / Intents |
| :--- | :--- | :--- | :--- |
| **Global Layout** | [app/root.tsx](app/root.tsx) | Renders `<Outlet />`, sticky header nav (`/quests`, `/quests/new`, `/sellers/reputation`), global styles ([app/app.css](app/app.css)). | None |
| **`/` (Home)** | [app/routes/home.tsx](app/routes/home.tsx) | `{ recentQuests: QuestRecord[], stats: { openCount, totalBountyCents, totalOffers } }` | GET form to `/quests?q=...` |
| **`/quests`** | [app/routes/quests.tsx](app/routes/quests.tsx) | `{ quests: QuestRecord[], filters: { q, category, strictness }, searchDiagnostics: { ftsCount, vectorCount, mode } }` | GET filter form (`q`, `category`, `strictness`) |
| **`/quests/new`** | [app/routes/quests.new.tsx](app/routes/quests.new.tsx) | Static form metadata | `multipart/form-data`: `title`, `category`, `strictness` (`1\|2\|3`), `max_budget` (USD), `brand`, `model_or_isbn`, `size_or_spec`, `description`, `reference_image` (`File`) |
| **`/quests/:id`** | [app/routes/quests.$id.tsx](app/routes/quests.$id.tsx) | `{ quest, offers, sellerReputations, escrow, escrowMachine, dispute }` | `intent`:<br>• `submit_offer` (`match_type`, `item_price`, `shipping_estimate`, `condition_grade`, `notes`, `proof_images`)<br>• `accept_offer` (`offer_id`)<br>• `generate_label` (`carrier`)<br>• `carrier_scan` (`scan_status`: `'in_transit' \| 'delivered'`)<br>• `release_escrow`<br>• `open_dispute` (`dispute_reason`, `dispute_description`, `dispute_evidence`)<br>• `refund_buyer`<br>• `trigger_alarm` |
| **`/sellers/reputation`** | [app/routes/sellers.reputation.tsx](app/routes/sellers.reputation.tsx) | `{ sellerId, sellerName, reputations: SellerReputationRecord[], configuredOAuth, oauthNotice }` | `intent`:<br>• `register_handle` (`platform`, `external_handle`, `preferred_method`)<br>• `verify_oauth_method_b` (`rep_id`, `sandbox_oauth`)<br>• `verify_bio_method_a` (`rep_id`, `force_sandbox`)<br>• `remove_reputation` (`rep_id`) |
| **`/assets/*`** | [app/routes/assets.$.tsx](app/routes/assets.$.tsx) | Streams R2 objects (`image/*`, `image/svg+xml`) with ETag/Cache-Control headers. | None |
| **`/webhooks/stripe`** | [app/routes/webhooks.stripe.tsx](app/routes/webhooks.stripe.tsx) | JSON status | `POST` Stripe webhook events (`Stripe-Signature` HMAC-SHA256) |
| **`/webhooks/shipping`** | [app/routes/webhooks.shipping.tsx](app/routes/webhooks.shipping.tsx) | JSON status | `POST` EasyPost / Shippo / carrier scan events |

---

## 5. Shared Domain Libraries
- [app/lib/quest-types.ts](app/lib/quest-types.ts): `QUEST_CATEGORIES`, `STRICTNESS_LEVELS` (`1 | 2 | 3`), `QuestRecord`, `OfferRecord`, `formatCents()`, `formatRelativeTime()`, `isMatchTypeAllowed()`, `ensureDemoUsers()`.
- [app/lib/escrow-service.ts](app/lib/escrow-service.ts): `EscrowMachineState`, Stripe Connect helpers (`createStripeEscrowPaymentIntent`, `executeStripeConnectRelease`, `executeStripeEscrowRefund`), and R2 SVG masked label generator (`issuePrepaidShippingLabel`).
- [app/lib/reputation-service.ts](app/lib/reputation-service.ts): `REPUTATION_PLATFORMS` (`ebay`, `discogs`, `etsy`, `grailed`, `poshmark`), Method B OAuth URL builder (`buildOAuthAuthorizationUrl`), and Method A public profile/API verifier (`verifyExternalStorefront`).
