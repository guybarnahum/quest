import { env } from "cloudflare:workers";
import type { Route } from "./+types/webhooks.stripe";
import type { RuntimeSecretsEnv } from "../lib/escrow-service";

async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret?: string,
): Promise<boolean> {
  if (!secret) return true;
  if (!sigHeader) return false;

  const parts = Object.fromEntries(
    sigHeader.split(",").map((part) => {
      const [k, v] = part.trim().split("=");
      return [k, v];
    }),
  );

  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  const computedHex = Array.from(new Uint8Array(signedBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computedHex === v1;
}

export async function loader() {
  return Response.json({
    endpoint: "/webhooks/stripe",
    status: "active",
    supported_events: [
      "payment_intent.succeeded",
      "payment_intent.amount_capturable_updated",
      "payment_intent.canceled",
      "charge.dispute.created",
    ],
  });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const rawBody = await request.text();
  const secrets = env as unknown as RuntimeSecretsEnv;
  const sigHeader = request.headers.get("stripe-signature");

  const valid = await verifyStripeSignature(
    rawBody,
    sigHeader,
    secrets.STRIPE_WEBHOOK_SECRET,
  );
  if (!valid) {
    return Response.json(
      { error: "Invalid Stripe webhook signature" },
      { status: 400 },
    );
  }

  let event: {
    id?: string;
    type?: string;
    data?: {
      object?: {
        id?: string;
        payment_intent?: string;
        metadata?: Record<string, string>;
        reason?: string;
      };
    };
  };

  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const obj = event.data?.object;
  let escrowId = obj?.metadata?.escrow_id || null;

  if (!escrowId && (obj?.id || obj?.payment_intent)) {
    const piId = obj?.payment_intent || obj?.id;
    const row = await env.quest_db
      .prepare(`SELECT id FROM escrows WHERE stripe_payment_intent_id = ?`)
      .bind(piId)
      .first<{ id: string }>();
    escrowId = row?.id || null;
  }

  if (!escrowId) {
    return Response.json({
      received: true,
      handled: false,
      reason: "No matching escrow_id found for event",
    });
  }

  const doId = env.ESCROW_MACHINE.idFromName(escrowId);
  const stub = env.ESCROW_MACHINE.get(doId);

  if (
    event.type === "payment_intent.succeeded" ||
    event.type === "payment_intent.amount_capturable_updated"
  ) {
    const row = await env.quest_db
      .prepare(`SELECT * FROM escrows WHERE id = ?`)
      .bind(escrowId)
      .first<{
        id: string;
        quest_id: string;
        offer_id: string;
        buyer_id: string;
        seller_id: string;
        item_amount_cents: number;
        shipping_amount_cents: number;
        buyer_fee_cents: number;
        seller_fee_cents: number;
        stripe_payment_intent_id: string;
        ship_by_deadline: number;
      }>();

    if (row) {
      const state = await stub.initialize({
        escrowId: row.id,
        questId: row.quest_id,
        offerId: row.offer_id,
        buyerId: row.buyer_id,
        sellerId: row.seller_id,
        itemAmountCents: row.item_amount_cents,
        shippingAmountCents: row.shipping_amount_cents,
        buyerFeeCents: row.buyer_fee_cents,
        sellerFeeCents: row.seller_fee_cents,
        stripePaymentIntentId: row.stripe_payment_intent_id,
        shipByDeadline: row.ship_by_deadline,
      });
      return Response.json({ received: true, handled: true, state });
    }
  }

  if (event.type === "payment_intent.canceled") {
    const state = await stub.refundBuyer(
      "Stripe PaymentIntent canceled via webhook.",
      "stripe_webhook",
    );
    return Response.json({ received: true, handled: true, state });
  }

  if (event.type === "charge.dispute.created") {
    const state = await stub.openDispute({
      openedByUserId: "user_demo_1",
      reason: "not_as_described",
      description: `Stripe chargeback/dispute opened (${obj?.reason || "general"}).`,
      evidenceR2Keys: [],
    });
    return Response.json({ received: true, handled: true, state });
  }

  return Response.json({
    received: true,
    handled: false,
    event_type: event.type,
  });
}
