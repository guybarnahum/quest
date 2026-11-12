# Quest — Reverse Marketplace for Rare & Discontinued Goods

**Quest** is a reverse e-commerce marketplace ("bounty board" for slow buying of rare, out-of-print, vintage, or discontinued items—such as discontinued watches, out-of-print books, archive clothing, and vintage audio/optics) built on **Cloudflare Workers** with **React Router v8**.

Instead of sellers listing inventory and waiting, **buyers post "Quests"** with a committed maximum budget and a strictness tier (`L1`–`L3`), and **sellers (collectors, boutiques, and archives) discover Quests via hybrid search and pitch verified Fulfillment Offers** protected by a 72-hour post-delivery inspection escrow.

---

## Architecture & Cloudflare Stack

| Component | Binding / Resource | Purpose |
| :--- | :--- | :--- |
| **Compute & SSR** | Cloudflare Workers (`workers/app.ts`) | React Router v8 SSR, loaders/actions, and webhook endpoints |
| **Relational + Lexical Search** | D1 Database `quest-db` (`env.quest_db`) | Stores `users`, `seller_reputations`, `quests`, `offers`, `escrows`, `disputes`, and `quests_fts` (`FTS5` triggers) |
| **Object Storage** | R2 Bucket `quest-assets` (`env.quest_assets`) | Reference photos, seller verification proof photos, dispute evidence, and address-masked SVG prepaid shipping labels |
| **Semantic Vector Search** | Vectorize `quest-embeddings` (`env.VECTORIZE`) | 384-dimension cosine similarity index populated on Quest creation |
| **Edge Embeddings** | Workers AI (`env.AI`) | Generates 384-dim vectors using `@cf/baai/bge-small-en-v1.5` |
| **Stateful Escrow & Timers** | Durable Object `EscrowMachine` (`env.ESCROW_MACHINE`) | Enforces escrow state machine transitions, **5-day Ship-By SLA** auto-refund alarms, and **72-hour post-delivery inspection** auto-release timers |

---

## Core Marketplace Mechanics

### 1. Edge-Enforced Strictness Tiers
Every Quest specifies a strictness policy enforced both in the UI and server-side in [app/lib/quest-types.ts](app/lib/quest-types.ts):
- **Level 1 (`L1 · Exact Match Only`):** Zero variance in brand, model/ISBN, size, and color. Only `exact` offers are accepted.
- **Level 2 (`L2 · Direct Alternative`):** Exact item preferred, or an adjacent size, alternate colorway of the same cut, or reissue (`exact`, `alternative`).
- **Level 3 (`L3 · Curated / Surprise Me`):** Open-ended era or aesthetic brief (`exact`, `alternative`, `curated`).

### 2. Hybrid Seller Discovery (`FTS5` + `Vectorize`)
In [app/routes/quests.tsx](app/routes/quests.tsx), seller search runs two queries in parallel:
1. **Lexical Search (`D1 FTS5`):** Exact SKU, reference number, or ISBN matching against `quests_fts`.
2. **Semantic Search (`Workers AI` + `Vectorize`):** Embeds the query with `@cf/baai/bge-small-en-v1.5` and queries `env.VECTORIZE` for conceptual matches (e.g., *"70s blue dial field watch"*).
Results are merged, deduplicated, and ranked (`hybrid` > `fts` > `semantic`).

### 3. `EscrowMachine` Durable Object & 72-Hour Inspection Lifecycle
Implemented in [workers/escrow-machine.ts](workers/escrow-machine.ts) with Stripe Connect & shipping helpers in [app/lib/escrow-service.ts](app/lib/escrow-service.ts):
- **`funded`:** Created when a buyer accepts an offer. Locks funds via Stripe PaymentIntent (manual capture / Connect `transfer_group`) and schedules a **5-business-day Ship-By SLA alarm** (`alarm()`).
- **`label_created`:** Generates a prepaid, address-masked shipping label (`labels/<escrowId>/prepaid-label.svg` in R2) so buyer and seller street addresses remain private.
- **`in_transit`:** Triggered when the carrier records an origin scan via `POST /webhooks/shipping`. Cancels the 5-day Ship-By SLA auto-refund alarm.
- **`delivered`:** Triggered when the carrier confirms delivery. Schedules a **72-hour post-delivery inspection alarm** (`alarm()`).
- **`released`:** Triggered either automatically when the 72-hour inspection alarm fires with zero disputes, or early when the buyer clicks **Approve & Release Payout**. Transfers net payout (`item_amount - 10% finder fee`) to the seller via Stripe Connect.
- **`disputed` / `refunded`:** If the buyer opens a SNAD dispute with R2 photo evidence during the 72-hour window, the auto-release alarm is cancelled and funds are frozen until resolved.

---

## Routes & Webhook Endpoints

| Route | File | Description |
| :--- | :--- | :--- |
| `/` | [app/routes/home.tsx](app/routes/home.tsx) | Landing page with live D1 bounty metrics, recent open Quests, strictness guide, and escrow overview |
| `/quests` | [app/routes/quests.tsx](app/routes/quests.tsx) | Seller Quest Board with category/strictness filters and hybrid `FTS5` + `Vectorize` search |
| `/quests/new` | [app/routes/quests.new.tsx](app/routes/quests.new.tsx) | Buyer Quest creation form with R2 reference image upload and Vectorize indexing |
| `/quests/:id` | [app/routes/quests.$id.tsx](app/routes/quests.$id.tsx) | Quest detail page, strictness-enforced Seller Offer form, and interactive `EscrowMachine` fulfillment console |
| `/assets/*` | [app/routes/assets.$.tsx](app/routes/assets.$.tsx) | Streaming R2 proxy for reference photos, proof images, dispute evidence, and SVG shipping labels |
| `/webhooks/stripe` | [app/routes/webhooks.stripe.tsx](app/routes/webhooks.stripe.tsx) | Stripe webhook receiver (`Stripe-Signature` HMAC-SHA256 verification) routing events to `EscrowMachine` |
| `/webhooks/shipping` | [app/routes/webhooks.shipping.tsx](app/routes/webhooks.shipping.tsx) | Carrier webhook receiver (EasyPost `tracker.updated`, Shippo `track_updated`, direct scans) |

---

## Development & Deployment

### Install Dependencies
```bash
npm install
```

### Database Schema & Demo Seed
Apply schema and seed demo users (`user_demo_1` and `user_seller_1`) to remote D1:
```bash
npx wrangler d1 execute quest-db --remote --file=./schema.sql
npm run d1:seed
```

### Optional Live API Secrets
`EscrowMachine` works out-of-the-box in deterministic sandbox mode and automatically switches to live API calls when the following Worker secrets are set:
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
- `SHIPPO_API_KEY` / `EASYPOST_API_KEY`

### Local Development
```bash
npm run dev
```

### Typecheck & Build
```bash
npm run typecheck
npm run build
```

### Deploy to Cloudflare Workers
```bash
npm run deploy
```
