import { env } from "cloudflare:workers";
import { useState } from "react";
import { data, Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/quests.$id";
import {
  createStripeEscrowPaymentIntent,
  type DisputeReason,
  type EscrowMachineState,
  type RuntimeSecretsEnv,
} from "../lib/escrow-service";
import {
  ensureDemoUsers,
  formatCents,
  formatRelativeTime,
  isMatchTypeAllowed,
  STRICTNESS_LEVELS,
  type OfferRecord,
  type QuestRecord,
} from "../lib/quest-types";
import {
  buildPublicProfileUrl,
  ensureDemoSellerReputations,
  REPUTATION_PLATFORMS,
  type SellerReputationRecord,
} from "../lib/reputation-service";

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData?.quest) {
    return [{ title: "Quest Not Found · Quest" }];
  }
  return [
    {
      title: `${loaderData.quest.title} (${formatCents(loaderData.quest.max_budget_cents)}) · Quest`,
    },
    { name: "description", content: loaderData.quest.description },
  ];
}

interface EscrowRow {
  id: string;
  quest_id: string;
  offer_id: string;
  buyer_id: string;
  seller_id: string;
  state: string;
  item_amount_cents: number;
  shipping_amount_cents: number;
  buyer_fee_cents: number;
  seller_fee_cents: number;
  stripe_payment_intent_id: string;
  ship_by_deadline: number;
  delivered_at: number | null;
  inspection_deadline: number | null;
  tracking_number: string | null;
  carrier: string | null;
  label_r2_key: string | null;
}

interface DisputeRow {
  id: string;
  escrow_id: string;
  opened_by_user_id: string;
  reason: string;
  description: string;
  evidence_r2_keys: string;
  status: string;
  resolution_notes: string | null;
  created_at: number;
  resolved_at: number | null;
}

export async function loader({ params }: Route.LoaderArgs) {
  const questId = params.id;
  await ensureDemoUsers(env.quest_db);
  await ensureDemoSellerReputations(env.quest_db);

  const quest = await env.quest_db
    .prepare(
      `SELECT q.*, u.display_name AS buyer_name
       FROM quests q
       LEFT JOIN users u ON u.id = q.buyer_id
       WHERE q.id = ?`,
    )
    .bind(questId)
    .first<QuestRecord>();

  if (!quest) {
    throw data("Quest not found", { status: 404 });
  }

  const offersRes = await env.quest_db
    .prepare(
      `SELECT o.*, u.display_name AS seller_name
       FROM offers o
       LEFT JOIN users u ON u.id = o.seller_id
       WHERE o.quest_id = ?
       ORDER BY o.created_at DESC`,
    )
    .bind(questId)
    .all<OfferRecord>();

  const repRes = await env.quest_db
    .prepare(
      `SELECT * FROM seller_reputations WHERE verified = 1 ORDER BY review_count DESC`,
    )
    .all<SellerReputationRecord>()
    .catch(() => ({ results: [] as SellerReputationRecord[] }));

  const sellerReputations: Record<string, SellerReputationRecord[]> = {};
  for (const r of repRes.results || []) {
    if (!sellerReputations[r.user_id]) {
      sellerReputations[r.user_id] = [];
    }
    sellerReputations[r.user_id].push(r);
  }

  let escrow = await env.quest_db
    .prepare(`SELECT * FROM escrows WHERE quest_id = ?`)
    .bind(questId)
    .first<EscrowRow>();

  let escrowMachine: EscrowMachineState | null = null;
  let dispute: DisputeRow | null = null;

  if (escrow) {
    const doId = env.ESCROW_MACHINE.idFromName(escrow.id);
    const stub = env.ESCROW_MACHINE.get(doId);
    escrowMachine = await stub.getState();

    if (!escrowMachine) {
      escrowMachine = await stub.initialize({
        escrowId: escrow.id,
        questId: escrow.quest_id,
        offerId: escrow.offer_id,
        buyerId: escrow.buyer_id,
        sellerId: escrow.seller_id,
        itemAmountCents: escrow.item_amount_cents,
        shippingAmountCents: escrow.shipping_amount_cents,
        buyerFeeCents: escrow.buyer_fee_cents,
        sellerFeeCents: escrow.seller_fee_cents,
        stripePaymentIntentId: escrow.stripe_payment_intent_id,
        shipByDeadline: escrow.ship_by_deadline,
      });
    }

    escrow = await env.quest_db
      .prepare(`SELECT * FROM escrows WHERE id = ?`)
      .bind(escrow.id)
      .first<EscrowRow>();

    dispute = await env.quest_db
      .prepare(`SELECT * FROM disputes WHERE escrow_id = ?`)
      .bind(escrowMachine.escrowId)
      .first<DisputeRow>();
  }

  return {
    quest,
    offers: offersRes.results || [],
    sellerReputations,
    escrow: escrow || null,
    escrowMachine,
    dispute: dispute || null,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const questId = params.id;
  const quest = await env.quest_db
    .prepare(`SELECT * FROM quests WHERE id = ?`)
    .bind(questId)
    .first<QuestRecord>();

  if (!quest) {
    return data({ error: "Quest not found." }, { status: 404 });
  }

  await ensureDemoUsers(env.quest_db);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "submit_offer");

  if (intent === "accept_offer") {
    const offerId = String(formData.get("offer_id") || "");
    const offer = await env.quest_db
      .prepare(`SELECT * FROM offers WHERE id = ? AND quest_id = ?`)
      .bind(offerId, questId)
      .first<OfferRecord>();

    if (!offer) {
      return data({ error: "Offer not found." }, { status: 404 });
    }
    if (quest.status !== "open") {
      return data(
        { error: "This Quest is no longer open for acceptance." },
        { status: 400 },
      );
    }

    const escrowId = `esc_${crypto.randomUUID().slice(0, 12)}`;
    const buyerFeeCents = Math.round(offer.item_price_cents * 0.025);
    const sellerFeeCents = Math.round(offer.item_price_cents * 0.1);
    const totalBuyerChargeCents =
      offer.item_price_cents + offer.shipping_estimate_cents + buyerFeeCents;
    const sellerNetCents = offer.item_price_cents - sellerFeeCents;
    const shipByDeadline = Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60;

    const sellerUser = await env.quest_db
      .prepare(`SELECT stripe_connect_account_id FROM users WHERE id = ?`)
      .bind(offer.seller_id)
      .first<{ stripe_connect_account_id: string | null }>()
      .catch(() => null);

    const stripePi = await createStripeEscrowPaymentIntent(
      env as unknown as RuntimeSecretsEnv,
      {
        escrowId,
        questId,
        offerId,
        totalChargeCents: totalBuyerChargeCents,
        sellerTransferCents: sellerNetCents,
        sellerConnectAccountId: sellerUser?.stripe_connect_account_id,
      },
    );

    await env.quest_db.batch([
      env.quest_db
        .prepare(`UPDATE quests SET status = 'accepted' WHERE id = ?`)
        .bind(questId),
      env.quest_db
        .prepare(`UPDATE offers SET status = 'accepted' WHERE id = ?`)
        .bind(offerId),
      env.quest_db
        .prepare(
          `UPDATE offers SET status = 'rejected' WHERE quest_id = ? AND id != ? AND status = 'pending'`,
        )
        .bind(questId, offerId),
      env.quest_db
        .prepare(
          `INSERT INTO escrows (
            id, quest_id, offer_id, buyer_id, seller_id,
            item_amount_cents, shipping_amount_cents, buyer_fee_cents, seller_fee_cents,
            stripe_payment_intent_id, state, ship_by_deadline
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'funded', ?)`,
        )
        .bind(
          escrowId,
          questId,
          offerId,
          quest.buyer_id,
          offer.seller_id,
          offer.item_price_cents,
          offer.shipping_estimate_cents,
          buyerFeeCents,
          sellerFeeCents,
          stripePi.paymentIntentId,
          shipByDeadline,
        ),
    ]);

    const doId = env.ESCROW_MACHINE.idFromName(escrowId);
    const stub = env.ESCROW_MACHINE.get(doId);
    await stub.initialize({
      escrowId,
      questId,
      offerId,
      buyerId: quest.buyer_id,
      sellerId: offer.seller_id,
      itemAmountCents: offer.item_price_cents,
      shippingAmountCents: offer.shipping_estimate_cents,
      buyerFeeCents,
      sellerFeeCents,
      stripePaymentIntentId: stripePi.paymentIntentId,
      shipByDeadline,
    });

    return {
      success:
        "Offer accepted and funds locked in escrow! The seller now has 5 business days to ship using the prepaid label.",
    };
  }

  if (
    intent === "generate_label" ||
    intent === "carrier_scan" ||
    intent === "release_escrow" ||
    intent === "refund_buyer" ||
    intent === "open_dispute" ||
    intent === "trigger_alarm"
  ) {
    const escrow = await env.quest_db
      .prepare(`SELECT * FROM escrows WHERE quest_id = ?`)
      .bind(questId)
      .first<EscrowRow>();

    if (!escrow) {
      return data(
        { error: "No active escrow found for this Quest." },
        { status: 404 },
      );
    }

    const doId = env.ESCROW_MACHINE.idFromName(escrow.id);
    const stub = env.ESCROW_MACHINE.get(doId);

    try {
      if (intent === "generate_label") {
        const carrier = String(
          formData.get("carrier") || "USPS Priority Insured",
        );
        const state = await stub.generateLabel({ carrier });
        return {
          success: `Prepaid address-protected shipping label created (${state.carrier} · Tracking #${state.trackingNumber})!`,
        };
      }

      if (intent === "carrier_scan") {
        const scanStatus = String(formData.get("scan_status") || "in_transit");
        if (scanStatus !== "in_transit" && scanStatus !== "delivered") {
          return data({ error: "Invalid carrier scan status." }, { status: 400 });
        }
        const state = await stub.recordCarrierEvent({
          status: scanStatus,
          actor: "carrier_webhook",
        });
        return {
          success:
            scanStatus === "in_transit"
              ? `Shipment marked In Transit (Tracking #${state.trackingNumber || "N/A"}). 5-day shipping requirement satisfied!`
              : "Shipment marked Delivered! Your 72-hour buyer inspection window has started.",
        };
      }

      if (intent === "release_escrow") {
        await stub.releaseFunds(
          "Buyer confirmed authenticity & approved payout release.",
          "buyer",
        );
        return {
          success:
            "Escrow released! Payment has been transferred to the seller.",
        };
      }

      if (intent === "refund_buyer") {
        const reason = String(
          formData.get("refund_reason") ||
            "Claim resolved in buyer's favor; full refund issued.",
        );
        await stub.refundBuyer(reason, "arbiter");
        return {
          success: "Full refund issued to the buyer.",
        };
      }

      if (intent === "trigger_alarm") {
        const state = await stub.triggerScheduledAlarmNow();
        return {
          success: `Protection timer completed! Order status updated to '${state?.state || "updated"}'.`,
        };
      }

      if (intent === "open_dispute") {
        const reason = String(
          formData.get("dispute_reason") || "not_as_described",
        ) as DisputeReason;
        const description = String(
          formData.get("dispute_description") || "",
        ).trim();
        const evidenceFiles = formData.getAll("dispute_evidence");

        if (description.length < 10) {
          return data(
            {
              error:
                "Please describe the issue in detail (at least 10 characters) so we can hold the funds in escrow.",
            },
            { status: 400 },
          );
        }

        const evidenceKeys: string[] = [];
        for (let i = 0; i < evidenceFiles.length; i++) {
          const file = evidenceFiles[i];
          if (file instanceof File && file.size > 0) {
            const safeName = file.name
              .replace(/[^a-zA-Z0-9._-]/g, "_")
              .slice(0, 80);
            const key = `disputes/${escrow.id}/${Date.now()}-${i}-${safeName}`;
            await env.quest_assets.put(key, file.stream(), {
              httpMetadata: {
                contentType: file.type || "application/octet-stream",
              },
            });
            evidenceKeys.push(key);
          }
        }

        await stub.openDispute({
          openedByUserId: quest.buyer_id,
          reason,
          description,
          evidenceR2Keys: evidenceKeys,
        });

        return {
          success:
            "Issue reported! The 72-hour automatic payout has been paused and your payment remains safely held in escrow.",
        };
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to update escrow status.";
      return data({ error: message }, { status: 400 });
    }
  }

  if (quest.status !== "open") {
    return data(
      { error: "This Quest is no longer accepting new offers." },
      { status: 400 },
    );
  }

  const matchType = String(formData.get("match_type") || "").trim();
  const itemPriceDollars = Number(formData.get("item_price") || 0);
  const shippingDollars = Number(formData.get("shipping_estimate") || 0);
  const conditionGrade = String(formData.get("condition_grade") || "").trim();
  const notes = String(formData.get("notes") || "").trim();
  const proofFiles = formData.getAll("proof_images");

  if (!isMatchTypeAllowed(quest.strictness, matchType)) {
    const strictInfo = STRICTNESS_LEVELS[quest.strictness];
    return data(
      {
        error: `This buyer requested "${strictInfo.name}". "${matchType}" offers are not accepted for this Quest.`,
      },
      { status: 400 },
    );
  }

  if (Number.isNaN(itemPriceDollars) || itemPriceDollars < 1) {
    return data(
      { error: "Item price must be at least $1." },
      { status: 400 },
    );
  }
  if (Number.isNaN(shippingDollars) || shippingDollars < 0) {
    return data(
      { error: "Shipping estimate cannot be negative." },
      { status: 400 },
    );
  }
  if (!conditionGrade) {
    return data(
      { error: "Please select a condition grade." },
      { status: 400 },
    );
  }
  if (!notes || notes.length < 10) {
    return data(
      {
        error:
          "Please include provenance, serial/edition details, and condition notes (at least 10 characters).",
      },
      { status: 400 },
    );
  }

  const offerId = `off_${crypto.randomUUID().slice(0, 12)}`;
  const uploadedKeys: string[] = [];

  for (let i = 0; i < proofFiles.length; i++) {
    const file = proofFiles[i];
    if (file instanceof File && file.size > 0) {
      if (file.size > 10 * 1024 * 1024) {
        return data(
          { error: "Each proof photo must be 10MB or smaller." },
          { status: 400 },
        );
      }
      const safeName = file.name
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 80);
      const key = `offers/${offerId}/${Date.now()}-${i}-${safeName}`;
      await env.quest_assets.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type || "application/octet-stream",
        },
      });
      uploadedKeys.push(key);
    }
  }

  const itemPriceCents = Math.round(itemPriceDollars * 100);
  const shippingCents = Math.round(shippingDollars * 100);

  await env.quest_db
    .prepare(
      `INSERT INTO offers (
        id, quest_id, seller_id, match_type, item_price_cents,
        shipping_estimate_cents, condition_grade, notes, proof_image_keys, status
      ) VALUES (?, ?, 'user_seller_1', ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(
      offerId,
      questId,
      matchType,
      itemPriceCents,
      shippingCents,
      conditionGrade,
      notes,
      JSON.stringify(uploadedKeys),
    )
    .run();

  return {
    success: "Your offer has been sent to the buyer!",
  };
}

const ESCROW_PIPELINE_STEPS = [
  { key: "funded", label: "1. Funded", sub: "Ship in 5 Days" },
  { key: "label_created", label: "2. Label Ready", sub: "Address Protected" },
  { key: "in_transit", label: "3. In Transit", sub: "Insured Carrier" },
  { key: "delivered", label: "4. Delivered", sub: "72h Inspection" },
  { key: "released", label: "5. Completed", sub: "Payout Released" },
] as const;

const ESCROW_STATUS_LABELS: Record<string, string> = {
  funded: "Escrow Funded · Awaiting Shipment",
  label_created: "Prepaid Label Ready · Awaiting Carrier Scan",
  in_transit: "In Transit to Buyer",
  delivered: "Delivered · 72-Hour Buyer Inspection",
  released: "Inspection Complete · Seller Paid",
  disputed: "On Hold · Buyer Reported an Issue",
  refunded: "Refunded to Buyer",
};

export default function QuestDetailPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { quest, offers, sellerReputations, escrow, escrowMachine, dispute } =
    loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const strictInfo =
    STRICTNESS_LEVELS[quest.strictness] || STRICTNESS_LEVELS[1];

  const currentEscrowState = escrowMachine?.state || escrow?.state || null;

  const [pitchPrice, setPitchPrice] = useState<string>(
    String(Math.round(quest.max_budget_cents / 100)),
  );
  const [pitchShipping, setPitchShipping] = useState<string>("18");

  const pitchItemCents = Math.max(0, Math.round((Number(pitchPrice) || 0) * 100));
  const pitchShippingCents = Math.max(
    0,
    Math.round((Number(pitchShipping) || 0) * 100),
  );
  const pitchSellerFeeCents = Math.round(pitchItemCents * 0.1);
  const pitchSellerNetCents = pitchItemCents - pitchSellerFeeCents;
  const pitchBuyerFeeCents = Math.round(pitchItemCents * 0.025);
  const pitchBuyerTotalCents =
    pitchItemCents + pitchShippingCents + pitchBuyerFeeCents;

  const stepIndex = ESCROW_PIPELINE_STEPS.findIndex(
    (s) => s.key === currentEscrowState,
  );

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
      {/* Top Breadcrumb Bar */}
      <div className="mb-6 pb-4 border-b border-stone-200/80 dark:border-stone-800/80 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs">
          <Link
            to="/quests"
            className="font-semibold uppercase tracking-wider text-stone-500 hover:text-stone-900 dark:hover:text-white transition-colors"
          >
            ← Back to Quest Board
          </Link>
          <span className="text-stone-300 dark:text-stone-700">/</span>
          <Link
            to={`/quests?category=${encodeURIComponent(quest.category)}`}
            className="text-stone-600 dark:text-stone-400 hover:text-amber-600 transition-colors"
          >
            {quest.category}
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-bold uppercase px-2.5 py-1 rounded-lg ${
              quest.status === "open"
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                : quest.status === "fulfilled"
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300"
                  : "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200"
            }`}
          >
            ●{" "}
            {quest.status === "open"
              ? "Open for Offers"
              : quest.status === "accepted"
                ? "In Escrow"
                : quest.status}
          </span>
        </div>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/40 p-4 text-sm text-rose-800 dark:text-rose-200 flex items-center gap-3">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-rose-200/70 dark:bg-rose-900 text-rose-900 dark:text-rose-100">
            Notice
          </span>
          <span>{actionData.error}</span>
        </div>
      )}

      {actionData && "success" in actionData && actionData.success && (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/40 p-4 text-sm text-emerald-800 dark:text-emerald-200 flex items-center gap-3">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-emerald-200/70 dark:bg-emerald-900 text-emerald-900 dark:text-emerald-100">
            Confirmed
          </span>
          <span>{actionData.success}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 space-y-8">
          {/* Primary Quest Card */}
          <section className="dossier-card overflow-hidden">
            {quest.reference_image_key && (
              <div className="bg-stone-100 dark:bg-stone-950 border-b border-stone-200 dark:border-stone-800 max-h-96 overflow-hidden flex items-center justify-center relative">
                <img
                  src={`/assets/${quest.reference_image_key}`}
                  alt={quest.title}
                  className="max-h-96 w-auto object-contain"
                />
                <span className="absolute bottom-3 left-3 text-[11px] font-medium px-2.5 py-1 rounded bg-stone-950/80 text-stone-200 backdrop-blur-xs">
                  Buyer Reference Photo
                </span>
              </div>
            )}

            <div className="p-6 sm:p-8">
              <div className="flex flex-wrap items-center gap-2 mb-3.5">
                <span className="text-xs font-semibold uppercase tracking-wider px-2.5 py-1 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
                  {quest.category}
                </span>
                <span
                  className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${strictInfo.badgeClass}`}
                >
                  {strictInfo.shortLabel}
                </span>
              </div>

              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-900 dark:text-stone-100 leading-tight">
                {quest.title}
              </h1>

              <div className="mt-5 flex flex-wrap items-baseline justify-between gap-4 p-4 rounded-2xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800">
                <div>
                  <span className="text-[11px] uppercase tracking-wider text-stone-400 block font-medium">
                    Buyer&apos;s Maximum Budget
                  </span>
                  <span className="text-3xl font-extrabold text-amber-600 dark:text-amber-400 tabular-nums">
                    Up to {formatCents(quest.max_budget_cents)}
                  </span>
                </div>
                <div className="text-right text-xs text-stone-500">
                  <p className="font-medium text-stone-800 dark:text-stone-200">
                    Posted by {quest.buyer_name || "Demo Collector"}
                  </p>
                  <p className="text-[11px] mt-0.5">
                    {formatRelativeTime(quest.created_at)}
                  </p>
                </div>
              </div>

              {(quest.brand || quest.model_or_isbn || quest.size_or_spec) && (
                <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 py-5 border-b border-stone-100 dark:border-stone-800 text-sm">
                  <div>
                    <dt className="text-[11px] text-stone-400 uppercase tracking-wider font-medium">
                      Brand / Maker
                    </dt>
                    <dd className="mt-1 font-semibold text-stone-900 dark:text-stone-100">
                      {quest.brand || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-stone-400 uppercase tracking-wider font-medium">
                      Model / Ref / ISBN
                    </dt>
                    <dd className="mt-1 font-mono font-semibold text-stone-900 dark:text-stone-100">
                      {quest.model_or_isbn || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-stone-400 uppercase tracking-wider font-medium">
                      Size / Spec
                    </dt>
                    <dd className="mt-1 font-semibold text-stone-900 dark:text-stone-100">
                      {quest.size_or_spec || "—"}
                    </dd>
                  </div>
                </dl>
              )}

              <div className="mt-5">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-stone-400">
                  Buyer Notes &amp; Condition Criteria
                </h2>
                <p className="mt-2.5 text-sm text-stone-700 dark:text-stone-300 whitespace-pre-line leading-relaxed">
                  {quest.description}
                </p>
              </div>

              <div className="mt-6 rounded-xl bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-800/50 p-4 text-xs text-stone-600 dark:text-stone-400">
                <p className="font-semibold text-stone-900 dark:text-stone-200">
                  Match Preference: {strictInfo.name}
                </p>
                <p className="mt-1 leading-relaxed">{strictInfo.description}</p>
              </div>
            </div>
          </section>

          {/* Escrow & Delivery Tracker */}
          {escrow && (
            <section className="rounded-2xl border-2 border-emerald-500/60 bg-white dark:bg-stone-900 p-6 sm:p-7 space-y-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-stone-100 dark:border-stone-800">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                    {ESCROW_STATUS_LABELS[currentEscrowState || "funded"] ||
                      "Escrow Active"}
                  </span>
                </div>
                <span className="text-xs text-stone-500">
                  Protected by 72-Hour Buyer Inspection
                </span>
              </div>

              <div>
                <h2 className="text-lg font-bold text-stone-900 dark:text-stone-100">
                  Escrow &amp; Delivery Progress
                </h2>
                <p className="text-xs text-stone-500 mt-0.5">
                  Payment is held securely in escrow until the item is delivered
                  and verified by the buyer.
                </p>
              </div>

              {/* 5-Step Progress Stepper */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {ESCROW_PIPELINE_STEPS.map((step, idx) => {
                  const isActive = currentEscrowState === step.key;
                  const isCompleted = stepIndex > idx;
                  return (
                    <div
                      key={step.key}
                      className={`rounded-xl px-3 py-2.5 text-xs border text-center transition-colors ${
                        isActive
                          ? "bg-emerald-600 text-white border-emerald-600 shadow-xs"
                          : isCompleted
                            ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/70"
                            : "bg-stone-50 dark:bg-stone-950 text-stone-500 border-stone-200 dark:border-stone-800"
                      }`}
                    >
                      <div className="font-semibold">
                        {isCompleted ? `✓ ${step.label}` : step.label}
                      </div>
                      <div
                        className={`text-[10px] mt-0.5 ${
                          isActive
                            ? "text-emerald-100"
                            : "text-stone-400 dark:text-stone-500"
                        }`}
                      >
                        {step.sub}
                      </div>
                    </div>
                  );
                })}
              </div>

              {(currentEscrowState === "disputed" ||
                currentEscrowState === "refunded") && (
                <div
                  className={`rounded-xl p-3.5 text-xs font-semibold border ${
                    currentEscrowState === "disputed"
                      ? "bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200"
                      : "bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200"
                  }`}
                >
                  {currentEscrowState === "disputed"
                    ? "Payout Paused: Buyer reported an issue during inspection."
                    : "Order Refunded: Full payment has been returned to the buyer."}
                </div>
              )}

              {/* Financial & Deadline Breakdown */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800">
                  <span className="text-[11px] uppercase text-stone-400 block">
                    Item Price
                  </span>
                  <span className="font-bold text-sm tabular-nums mt-0.5 block">
                    {formatCents(escrow.item_amount_cents)}
                  </span>
                </div>
                <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800">
                  <span className="text-[11px] uppercase text-stone-400 block">
                    Prepaid Shipping
                  </span>
                  <span className="font-bold text-sm tabular-nums mt-0.5 block">
                    {formatCents(escrow.shipping_amount_cents)}
                  </span>
                </div>
                <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800">
                  <span className="text-[11px] uppercase text-stone-400 block">
                    Buyer Protection
                  </span>
                  <span className="font-bold text-sm tabular-nums mt-0.5 block">
                    {formatCents(escrow.buyer_fee_cents)} (2.5%)
                  </span>
                </div>
                <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800">
                  <span className="text-[11px] uppercase text-stone-400 block">
                    {escrow.inspection_deadline
                      ? "Inspection Ends"
                      : "Ship-By Date"}
                  </span>
                  <span className="font-bold text-sm tabular-nums mt-0.5 block">
                    {new Date(
                      (escrow.inspection_deadline || escrow.ship_by_deadline) *
                        1000,
                    ).toLocaleDateString()}
                  </span>
                </div>
              </div>

              {escrowMachine?.activeAlarmType && escrowMachine.activeAlarmAt && (
                <div className="rounded-xl bg-amber-50/90 dark:bg-amber-950/30 border border-amber-300/80 dark:border-amber-800/70 p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div>
                    <span className="font-bold uppercase tracking-wider text-amber-900 dark:text-amber-300 block">
                      Active Protection Timer:{" "}
                      {escrowMachine.activeAlarmType === "ship_by_sla"
                        ? "5-Day Shipping Deadline (Auto-Refund)"
                        : "72-Hour Buyer Inspection Window (Auto-Release)"}
                    </span>
                    <span className="text-stone-600 dark:text-stone-400 text-[11px]">
                      Completes on{" "}
                      {new Date(escrowMachine.activeAlarmAt).toLocaleString()}
                    </span>
                  </div>
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="trigger_alarm"
                    />
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold cursor-pointer shadow-2xs"
                    >
                      Fast-Forward Timer
                    </button>
                  </Form>
                </div>
              )}

              {(escrow.label_r2_key || escrowMachine?.labelR2Key) && (
                <div className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div>
                    <span className="font-semibold text-stone-900 dark:text-stone-100 block">
                      Prepaid Address-Protected Shipping Label (
                      {escrow.carrier || escrowMachine?.carrier})
                    </span>
                    <span className="font-mono text-stone-500">
                      Tracking #:{" "}
                      {escrow.tracking_number || escrowMachine?.trackingNumber}
                    </span>
                  </div>
                  <a
                    href={`/assets/${escrow.label_r2_key || escrowMachine?.labelR2Key}`}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3.5 py-2 rounded-xl bg-stone-900 dark:bg-stone-800 text-white font-semibold hover:opacity-90"
                  >
                    View Prepaid Shipping Label ↗
                  </a>
                </div>
              )}

              <div className="space-y-3 pt-2 border-t border-stone-200 dark:border-stone-800">
                <span className="text-xs font-semibold uppercase tracking-wider text-stone-400 block">
                  Shipping &amp; Inspection Actions
                </span>

                <div className="flex flex-wrap gap-2.5">
                  {(currentEscrowState === "funded" ||
                    currentEscrowState === "label_created") && (
                    <Form method="post" className="inline-flex flex-wrap gap-2">
                      <input
                        type="hidden"
                        name="intent"
                        value="generate_label"
                      />
                      <select
                        name="carrier"
                        defaultValue="USPS Priority Insured"
                        aria-label="Shipping carrier"
                        className="rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3 py-2 text-xs"
                      >
                        <option value="USPS Priority Insured">
                          USPS Priority Insured
                        </option>
                        <option value="UPS Next Day Air">
                          UPS Next Day Air
                        </option>
                        <option value="FedEx Priority Overnight">
                          FedEx Priority Overnight
                        </option>
                      </select>
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="px-3.5 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-amber-600 dark:hover:bg-amber-500 text-white text-xs font-semibold cursor-pointer"
                      >
                        1. Create Prepaid Shipping Label
                      </button>
                    </Form>
                  )}

                  {(currentEscrowState === "funded" ||
                    currentEscrowState === "label_created") && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="carrier_scan" />
                      <input
                        type="hidden"
                        name="scan_status"
                        value="in_transit"
                      />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold cursor-pointer"
                      >
                        2. Mark Shipped / In Transit
                      </button>
                    </Form>
                  )}

                  {(currentEscrowState === "funded" ||
                    currentEscrowState === "label_created" ||
                    currentEscrowState === "in_transit") && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="carrier_scan" />
                      <input
                        type="hidden"
                        name="scan_status"
                        value="delivered"
                      />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer"
                      >
                        3. Mark Delivered (Starts 72h Inspection)
                      </button>
                    </Form>
                  )}

                  {(currentEscrowState === "delivered" ||
                    currentEscrowState === "in_transit" ||
                    currentEscrowState === "disputed") && (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="release_escrow"
                      />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer"
                      >
                        ✓ Approve Item &amp; Release Payment
                      </button>
                    </Form>
                  )}

                  {currentEscrowState === "disputed" && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="refund_buyer" />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="px-3.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer"
                      >
                        Issue Buyer Refund
                      </button>
                    </Form>
                  )}
                </div>
              </div>

              {(currentEscrowState === "delivered" ||
                currentEscrowState === "in_transit") && (
                <details className="rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/40 dark:bg-rose-950/20 p-4 text-xs">
                  <summary className="font-semibold text-rose-800 dark:text-rose-300 cursor-pointer">
                    Something not right with the item? Report an issue to pause
                    payout
                  </summary>
                  <Form
                    method="post"
                    encType="multipart/form-data"
                    className="mt-3 space-y-3"
                  >
                    <input type="hidden" name="intent" value="open_dispute" />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor="dispute_reason"
                          className="block font-semibold text-stone-700 dark:text-stone-300 mb-1"
                        >
                          Reason
                        </label>
                        <select
                          id="dispute_reason"
                          name="dispute_reason"
                          defaultValue="not_as_described"
                          className="w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 py-2"
                        >
                          <option value="not_as_described">
                            Item Does Not Match Description
                          </option>
                          <option value="counterfeit">
                            Authenticity Concern
                          </option>
                          <option value="damaged_in_transit">
                            Damaged in Transit
                          </option>
                          <option value="wrong_item">Wrong Item Sent</option>
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="dispute_evidence"
                          className="block font-semibold text-stone-700 dark:text-stone-300 mb-1"
                        >
                          Supporting Photos
                        </label>
                        <input
                          id="dispute_evidence"
                          name="dispute_evidence"
                          type="file"
                          accept="image/*"
                          multiple
                          className="w-full text-xs"
                        />
                      </div>
                    </div>
                    <div>
                      <label
                        htmlFor="dispute_description"
                        className="block font-semibold text-stone-700 dark:text-stone-300 mb-1"
                      >
                        What Happened? *
                      </label>
                      <textarea
                        id="dispute_description"
                        name="dispute_description"
                        rows={2}
                        required
                        placeholder="Describe how the item differs from the seller's photos or condition notes..."
                        className="w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 py-2"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold cursor-pointer"
                    >
                      Hold Payment &amp; Submit Report
                    </button>
                  </Form>
                </details>
              )}

              {dispute && (
                <div className="rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/40 dark:bg-rose-950/20 p-4 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-bold uppercase text-rose-800 dark:text-rose-300">
                      Buyer Issue Report · {dispute.reason.replace(/_/g, " ")}
                    </span>
                    <span className="uppercase px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-900/60 text-rose-800 dark:text-rose-200 font-semibold">
                      {dispute.status}
                    </span>
                  </div>
                  <p className="text-stone-700 dark:text-stone-300">
                    {dispute.description}
                  </p>
                </div>
              )}

              {escrowMachine?.events && escrowMachine.events.length > 0 && (
                <div className="pt-3 border-t border-stone-200 dark:border-stone-800">
                  <span className="text-xs font-semibold uppercase tracking-wider text-stone-400 block mb-2.5">
                    Order Activity Timeline
                  </span>
                  <ul className="space-y-2 text-xs">
                    {escrowMachine.events.map((ev, idx) => (
                      <li
                        key={`${ev.timestamp}-${idx}`}
                        className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800 px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1"
                      >
                        <div>
                          <span className="font-bold text-amber-700 dark:text-amber-400 capitalize">
                            {ev.toState.replace(/_/g, " ")}
                          </span>{" "}
                          <span className="text-stone-600 dark:text-stone-300">
                            — {ev.note}
                          </span>
                        </div>
                        <span className="text-[11px] text-stone-400 shrink-0">
                          {formatRelativeTime(ev.timestamp)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* Submitted Seller Offers */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                  Seller Proposals
                </span>
                <h2 className="text-xl font-bold tracking-tight">
                  Submitted Offers ({offers.length})
                </h2>
              </div>
              <span className="text-xs text-stone-500">
                Backed by 72-hour post-delivery buyer inspection
              </span>
            </div>

            {offers.length === 0 ? (
              <div className="dossier-card border-dashed p-10 text-center text-sm text-stone-500">
                No offers submitted yet. Have this item in your collection or
                shop? Submit the first offer on the right.
              </div>
            ) : (
              <div className="space-y-4">
                {offers.map((offer) => {
                  let proofKeys: string[] = [];
                  try {
                    proofKeys = JSON.parse(offer.proof_image_keys || "[]");
                  } catch {
                    proofKeys = [];
                  }
                  const totalBuyerCents =
                    offer.item_price_cents +
                    offer.shipping_estimate_cents +
                    Math.round(offer.item_price_cents * 0.025);

                  return (
                    <div
                      key={offer.id}
                      className={`dossier-card p-5 sm:p-6 space-y-4 ${
                        offer.status === "accepted"
                          ? "border-emerald-500/60"
                          : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-sm text-stone-900 dark:text-stone-100">
                              {offer.seller_name || "Vault Vintage Studio"}
                            </span>
                            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 capitalize">
                              {offer.match_type} Match
                            </span>
                            <span className="text-xs font-medium px-2.5 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300">
                              Condition: {offer.condition_grade}
                            </span>
                          </div>

                          {(sellerReputations?.[offer.seller_id] || []).length >
                            0 && (
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              {(sellerReputations?.[offer.seller_id] || []).map(
                                (rep) => {
                                  const cfg =
                                    REPUTATION_PLATFORMS[rep.platform] ||
                                    REPUTATION_PLATFORMS.ebay;
                                  return (
                                    <a
                                      key={rep.id}
                                      href={buildPublicProfileUrl(
                                        rep.platform,
                                        rep.external_handle,
                                      )}
                                      target="_blank"
                                      rel="noreferrer"
                                      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${cfg.badgeColorClass}`}
                                    >
                                      <span>✓ {cfg.name}</span>
                                      <span>
                                        {rep.rating_score?.toFixed(2) || "5.0"}★
                                      </span>
                                      <span>({rep.review_count})</span>
                                    </a>
                                  );
                                },
                              )}
                            </div>
                          )}

                          <p className="text-xs text-stone-400">
                            Submitted {formatRelativeTime(offer.created_at)}
                          </p>
                        </div>

                        <div className="text-right">
                          <div className="text-2xl font-extrabold text-stone-900 dark:text-stone-100 tabular-nums">
                            {formatCents(offer.item_price_cents)}
                          </div>
                          <div className="text-xs text-stone-500 tabular-nums">
                            + {formatCents(offer.shipping_estimate_cents)}{" "}
                            insured shipping
                          </div>
                        </div>
                      </div>

                      <p className="text-sm text-stone-700 dark:text-stone-300 whitespace-pre-line leading-relaxed bg-stone-50/70 dark:bg-stone-950/60 p-3.5 rounded-xl border border-stone-100 dark:border-stone-800/80">
                        {offer.notes}
                      </p>

                      {proofKeys.length > 0 && (
                        <div>
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 block mb-2">
                            Seller Item Photos ({proofKeys.length})
                          </span>
                          <div className="flex flex-wrap gap-3">
                            {proofKeys.map((key) => (
                              <a
                                key={key}
                                href={`/assets/${key}`}
                                target="_blank"
                                rel="noreferrer"
                                className="group/img block w-24 h-24 rounded-xl overflow-hidden border border-stone-200 dark:border-stone-700 bg-stone-100 dark:bg-stone-800 hover:border-amber-500 transition-colors"
                              >
                                <img
                                  src={`/assets/${key}`}
                                  alt="Seller proof"
                                  className="w-full h-full object-cover group-hover/img:scale-105 transition-transform"
                                />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="pt-3.5 border-t border-stone-100 dark:border-stone-800 flex flex-wrap items-center justify-between gap-3">
                        <div className="text-xs text-stone-500 tabular-nums">
                          Total with 2.5% buyer protection:{" "}
                          <strong className="text-stone-900 dark:text-stone-100">
                            {formatCents(totalBuyerCents)}
                          </strong>{" "}
                          · Seller payout (90%):{" "}
                          <strong className="text-emerald-700 dark:text-emerald-400">
                            {formatCents(
                              Math.round(offer.item_price_cents * 0.9),
                            )}
                          </strong>
                        </div>

                        {quest.status === "open" &&
                        offer.status === "pending" ? (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="accept_offer"
                            />
                            <input
                              type="hidden"
                              name="offer_id"
                              value={offer.id}
                            />
                            <button
                              type="submit"
                              className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors cursor-pointer shadow-2xs"
                            >
                              ✓ Accept Offer &amp; Fund Escrow
                            </button>
                          </Form>
                        ) : (
                          <span
                            className={`text-xs font-semibold uppercase px-3 py-1 rounded-full ${
                              offer.status === "accepted"
                                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                                : "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400"
                            }`}
                          >
                            {offer.status}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Sticky Right Column: Make an Offer */}
        <aside className="lg:col-span-5 sticky top-24">
          <div className="dossier-card p-6 sm:p-7">
            <div className="mb-5 pb-4 border-b border-stone-100 dark:border-stone-800">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                  Have This Item?
                </span>
                <Link
                  to="/sellers/reputation"
                  className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
                >
                  ✓ Verify Your Storefront →
                </Link>
              </div>
              <h2 className="mt-1.5 text-xl font-bold text-stone-900 dark:text-stone-100">
                Make an Offer to the Buyer
              </h2>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
                Share photos of your item and your asking price. If accepted,
                you will receive a prepaid, address-protected shipping label.
              </p>
            </div>

            {quest.status !== "open" ? (
              <div className="rounded-xl bg-stone-100 dark:bg-stone-800/80 border border-stone-200 dark:border-stone-700 p-4 text-sm text-stone-600 dark:text-stone-300 leading-relaxed">
                This Quest has already accepted an offer and is currently{" "}
                <strong className="capitalize">{quest.status}</strong>. Use the{" "}
                <strong>Escrow &amp; Delivery Progress</strong> panel on the
                left to manage shipping and inspection steps.
              </div>
            ) : (
              <Form
                method="post"
                encType="multipart/form-data"
                className="space-y-4"
              >
                <input type="hidden" name="intent" value="submit_offer" />

                <div>
                  <label
                    htmlFor="match_type"
                    className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                  >
                    How Closely Does Your Item Match? *
                  </label>
                  <select
                    id="match_type"
                    name="match_type"
                    defaultValue="exact"
                    className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
                  >
                    <option value="exact">
                      Exact Match (Identical brand, model/ISBN &amp; spec)
                    </option>
                    <option
                      value="alternative"
                      disabled={quest.strictness === 1}
                    >
                      Close Alternative{" "}
                      {quest.strictness === 1
                        ? "(Not accepted for this Quest)"
                        : "(Nearby size, colorway, or later edition)"}
                    </option>
                    <option
                      value="curated"
                      disabled={quest.strictness === 1 || quest.strictness === 2}
                    >
                      Curated Suggestion{" "}
                      {quest.strictness < 3
                        ? "(Not accepted for this Quest)"
                        : "(Matches era & style brief)"}
                    </option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="item_price"
                      className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                    >
                      Item Price (USD) *
                    </label>
                    <input
                      id="item_price"
                      name="item_price"
                      type="number"
                      min="1"
                      step="1"
                      required
                      value={pitchPrice}
                      onChange={(e) => setPitchPrice(e.target.value)}
                      className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2 text-sm font-semibold tabular-nums focus:border-amber-600 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="shipping_estimate"
                      className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                    >
                      Shipping (USD) *
                    </label>
                    <input
                      id="shipping_estimate"
                      name="shipping_estimate"
                      type="number"
                      min="0"
                      step="1"
                      required
                      value={pitchShipping}
                      onChange={(e) => setPitchShipping(e.target.value)}
                      className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2 text-sm font-semibold tabular-nums focus:border-amber-600 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Live Payout Calculator */}
                <div className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800 p-3.5 space-y-1.5 text-xs tabular-nums">
                  <div className="flex items-center justify-between text-stone-500">
                    <span>Marketplace Commission (10%)</span>
                    <span>-{formatCents(pitchSellerFeeCents)}</span>
                  </div>
                  <div className="flex items-center justify-between font-semibold text-stone-900 dark:text-stone-100">
                    <span>Your Net Payout</span>
                    <span className="text-emerald-700 dark:text-emerald-400">
                      {formatCents(pitchSellerNetCents)}
                    </span>
                  </div>
                  <div className="pt-1.5 border-t border-stone-200/70 dark:border-stone-800 flex items-center justify-between text-[11px] text-stone-500">
                    <span>Buyer Total (incl. shipping + 2.5% protection)</span>
                    <span>{formatCents(pitchBuyerTotalCents)}</span>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="condition_grade"
                    className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                  >
                    Condition Grade *
                  </label>
                  <select
                    id="condition_grade"
                    name="condition_grade"
                    defaultValue="Mint / Near Mint (Used)"
                    className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
                  >
                    <option value="New / Deadstock (NOS)">
                      New / Deadstock (NOS)
                    </option>
                    <option value="Mint / Near Mint (Used)">
                      Mint / Near Mint (Used)
                    </option>
                    <option value="Very Good (Light Wear)">
                      Very Good (Light Wear)
                    </option>
                    <option value="Good (Honest Patina / Vintage)">
                      Good (Honest Patina / Vintage)
                    </option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="notes"
                    className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                  >
                    Provenance, Serial &amp; Condition Notes *
                  </label>
                  <textarea
                    id="notes"
                    name="notes"
                    rows={4}
                    required
                    placeholder="Describe condition details, serial or edition numbers, included box/papers, and any wear..."
                    className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2 text-sm focus:border-amber-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="proof_images"
                    className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                  >
                    Item Verification Photos
                  </label>
                  <input
                    id="proof_images"
                    name="proof_images"
                    type="file"
                    accept="image/*"
                    multiple
                    className="mt-1.5 block w-full text-xs text-stone-600 dark:text-stone-400 file:mr-3 file:rounded-lg file:border-0 file:bg-stone-900 file:text-white dark:file:bg-stone-800 dark:file:text-stone-200 file:px-3 file:py-1.5 file:text-xs file:font-semibold hover:file:bg-amber-600 file:cursor-pointer"
                  />
                </div>

                <div className="rounded-xl bg-stone-50 dark:bg-stone-950 p-3.5 text-xs text-stone-500 space-y-1 border border-stone-200 dark:border-stone-800">
                  <p className="font-semibold text-stone-700 dark:text-stone-300">
                    How Seller Protection Works:
                  </p>
                  <p>
                    • Ship within 5 business days using our prepaid,
                    address-protected label.
                  </p>
                  <p>
                    • Your payout is automatically released 72 hours after
                    delivery.
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-semibold text-sm transition-colors shadow-xs cursor-pointer"
                >
                  {isSubmitting
                    ? "Sending Offer..."
                    : "Send Offer to Buyer →"}
                </button>
              </Form>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
