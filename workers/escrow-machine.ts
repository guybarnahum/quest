import { DurableObject } from "cloudflare:workers";
import {
  type DisputeReason,
  type EscrowLifecycleState,
  type EscrowMachineState,
  executeStripeConnectRelease,
  executeStripeEscrowRefund,
  type InitializeEscrowInput,
  issuePrepaidShippingLabel,
  type RuntimeSecretsEnv,
} from "../app/lib/escrow-service";

const STORAGE_KEY = "escrow_state";

export class EscrowMachine extends DurableObject<Env> {
  private async loadState(): Promise<EscrowMachineState | null> {
    const state =
      await this.ctx.storage.get<EscrowMachineState>(STORAGE_KEY);
    return state ?? null;
  }

  private async saveState(state: EscrowMachineState): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, state);
  }

  private getSecretsEnv(): RuntimeSecretsEnv {
    return this.env as unknown as RuntimeSecretsEnv;
  }

  async getState(): Promise<EscrowMachineState | null> {
    return this.loadState();
  }

  /**
   * Initializes the EscrowMachine in `funded` state and sets the 5-business-day Ship-By SLA alarm.
   */
  async initialize(
    input: InitializeEscrowInput,
  ): Promise<EscrowMachineState> {
    const existing = await this.loadState();
    if (existing) {
      return existing;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const alarmMs = input.shipByDeadline * 1000;

    const record: EscrowMachineState = {
      escrowId: input.escrowId,
      questId: input.questId,
      offerId: input.offerId,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      itemAmountCents: input.itemAmountCents,
      shippingAmountCents: input.shippingAmountCents,
      buyerFeeCents: input.buyerFeeCents,
      sellerFeeCents: input.sellerFeeCents,
      stripePaymentIntentId: input.stripePaymentIntentId,
      stripeTransferId: null,
      stripeRefundId: null,
      state: "funded",
      trackingNumber: null,
      carrier: null,
      labelR2Key: null,
      shippingProviderShipmentId: null,
      shipByDeadline: input.shipByDeadline,
      deliveredAt: null,
      inspectionDeadline: null,
      activeAlarmType: "ship_by_sla",
      activeAlarmAt: alarmMs,
      disputeId: null,
      disputeReason: null,
      events: [
        {
          timestamp: nowSec,
          fromState: null,
          toState: "funded",
          actor: "buyer",
          note: `Escrow funded (${input.stripePaymentIntentId}). Ship-by SLA alarm armed for ${new Date(
            alarmMs,
          ).toISOString()}.`,
        },
      ],
    };

    await this.ctx.storage.setAlarm(alarmMs);
    await this.saveState(record);
    return record;
  }

  /**
   * Generates a prepaid, address-masked shipping label in R2 and transitions `funded` -> `label_created`.
   * Keeps the Ship-By SLA alarm active until the carrier records an `in_transit` scan.
   */
  async generateLabel(options?: {
    carrier?: string;
  }): Promise<EscrowMachineState> {
    const record = await this.loadState();
    if (!record) {
      throw new Error("Escrow state not initialized.");
    }
    if (record.state !== "funded" && record.state !== "label_created") {
      throw new Error(
        `Cannot generate prepaid label when escrow is in '${record.state}' state.`,
      );
    }

    const label = await issuePrepaidShippingLabel(
      this.env.quest_assets,
      this.getSecretsEnv(),
      {
        escrowId: record.escrowId,
        questId: record.questId,
        carrier: options?.carrier,
        shipByDeadline: record.shipByDeadline,
      },
    );

    const prevState = record.state;
    record.state = "label_created";
    record.carrier = label.carrier;
    record.trackingNumber = label.trackingNumber;
    record.labelR2Key = label.labelR2Key;
    record.shippingProviderShipmentId = label.providerShipmentId;
    record.events.push({
      timestamp: Math.floor(Date.now() / 1000),
      fromState: prevState,
      toState: "label_created",
      actor: "seller",
      note: `Prepaid masked shipping label generated (${label.carrier} · #${label.trackingNumber}). Waiting for carrier origin scan before SLA deadline.`,
    });

    await this.env.quest_db
      .prepare(
        `UPDATE escrows
         SET state = 'label_created',
             carrier = ?,
             tracking_number = ?,
             label_r2_key = ?
         WHERE id = ?`,
      )
      .bind(
        record.carrier,
        record.trackingNumber,
        record.labelR2Key,
        record.escrowId,
      )
      .run();

    await this.saveState(record);
    return record;
  }

  /**
   * Processes carrier tracking webhooks (`in_transit` or `delivered`).
   * - `in_transit`: cancels the 5-day Ship-By SLA auto-refund alarm.
   * - `delivered`: starts the 72-hour post-delivery buyer inspection alarm.
   */
  async recordCarrierEvent(payload: {
    status: "in_transit" | "delivered";
    trackingNumber?: string;
    carrier?: string;
    actor?: string;
  }): Promise<EscrowMachineState> {
    const record = await this.loadState();
    if (!record) {
      throw new Error("Escrow state not initialized.");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.trackingNumber) {
      record.trackingNumber = payload.trackingNumber;
    }
    if (payload.carrier) {
      record.carrier = payload.carrier;
    }

    if (payload.status === "in_transit") {
      if (
        record.state !== "funded" &&
        record.state !== "label_created" &&
        record.state !== "in_transit"
      ) {
        throw new Error(
          `Cannot transition to 'in_transit' from '${record.state}'.`,
        );
      }

      const prevState = record.state;
      record.state = "in_transit";
      record.activeAlarmType = null;
      record.activeAlarmAt = null;
      await this.ctx.storage.deleteAlarm();

      record.events.push({
        timestamp: nowSec,
        fromState: prevState,
        toState: "in_transit",
        actor: payload.actor || "carrier_webhook",
        note: `Carrier origin scan verified (${record.carrier || "Carrier"} #${
          record.trackingNumber || "N/A"
        }). Ship-by SLA satisfied; auto-refund alarm cleared.`,
      });

      await this.env.quest_db
        .prepare(
          `UPDATE escrows
           SET state = 'in_transit',
               tracking_number = COALESCE(?, tracking_number),
               carrier = COALESCE(?, carrier)
           WHERE id = ?`,
        )
        .bind(record.trackingNumber, record.carrier, record.escrowId)
        .run();

      await this.saveState(record);
      return record;
    }

    if (payload.status === "delivered") {
      if (
        record.state !== "funded" &&
        record.state !== "label_created" &&
        record.state !== "in_transit"
      ) {
        throw new Error(
          `Cannot transition to 'delivered' from '${record.state}'.`,
        );
      }

      const prevState = record.state;
      const inspectionDeadlineSec = nowSec + 72 * 60 * 60;
      const alarmMs = inspectionDeadlineSec * 1000;

      record.state = "delivered";
      record.deliveredAt = nowSec;
      record.inspectionDeadline = inspectionDeadlineSec;
      record.activeAlarmType = "inspection_window";
      record.activeAlarmAt = alarmMs;

      await this.ctx.storage.setAlarm(alarmMs);

      record.events.push({
        timestamp: nowSec,
        fromState: prevState,
        toState: "delivered",
        actor: payload.actor || "carrier_webhook",
        note: `Carrier delivery scan confirmed. 72-hour buyer inspection window started; auto-release alarm scheduled for ${new Date(
          alarmMs,
        ).toISOString()}.`,
      });

      await this.env.quest_db
        .prepare(
          `UPDATE escrows
           SET state = 'delivered',
               delivered_at = ?,
               inspection_deadline = ?,
               tracking_number = COALESCE(?, tracking_number),
               carrier = COALESCE(?, carrier)
           WHERE id = ?`,
        )
        .bind(
          nowSec,
          inspectionDeadlineSec,
          record.trackingNumber,
          record.carrier,
          record.escrowId,
        )
        .run();

      await this.saveState(record);
      return record;
    }

    return record;
  }

  /**
   * Opens a buyer SNAD dispute during the 72-hour inspection window, freezing funds
   * and cancelling the 72-hour auto-release alarm.
   */
  async openDispute(payload: {
    openedByUserId: string;
    reason: DisputeReason;
    description: string;
    evidenceR2Keys: string[];
  }): Promise<EscrowMachineState> {
    const record = await this.loadState();
    if (!record) {
      throw new Error("Escrow state not initialized.");
    }
    if (record.state !== "delivered" && record.state !== "in_transit") {
      throw new Error(
        `Disputes can only be opened when shipment is in transit or within the 72-hour post-delivery window (current state: '${record.state}').`,
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (
      record.inspectionDeadline &&
      nowSec > record.inspectionDeadline
    ) {
      throw new Error(
        "The 72-hour post-delivery inspection window has already expired.",
      );
    }

    const disputeId = `dsp_${crypto.randomUUID().slice(0, 12)}`;
    const prevState = record.state;

    await this.ctx.storage.deleteAlarm();
    record.state = "disputed";
    record.activeAlarmType = null;
    record.activeAlarmAt = null;
    record.disputeId = disputeId;
    record.disputeReason = payload.reason;

    record.events.push({
      timestamp: nowSec,
      fromState: prevState,
      toState: "disputed",
      actor: "buyer",
      note: `Dispute ${disputeId} opened (${payload.reason}): "${payload.description}". 72-hour auto-release timer paused; escrow funds frozen.`,
    });

    await this.env.quest_db.batch([
      this.env.quest_db
        .prepare(`UPDATE escrows SET state = 'disputed' WHERE id = ?`)
        .bind(record.escrowId),
      this.env.quest_db
        .prepare(
          `INSERT INTO disputes (
            id, escrow_id, opened_by_user_id, reason, description, evidence_r2_keys, status
          ) VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        )
        .bind(
          disputeId,
          record.escrowId,
          payload.openedByUserId,
          payload.reason,
          payload.description,
          JSON.stringify(payload.evidenceR2Keys),
        ),
    ]);

    await this.saveState(record);
    return record;
  }

  /**
   * Releases escrow funds to the seller's Stripe Connect account (either via 72-hour alarm,
   * buyer early approval, or dispute resolution in seller's favor).
   */
  async releaseFunds(
    reason = "Buyer approved item condition & released escrow.",
    actor = "buyer",
  ): Promise<EscrowMachineState> {
    const record = await this.loadState();
    if (!record) {
      throw new Error("Escrow state not initialized.");
    }
    if (record.state === "released") {
      return record;
    }
    if (
      record.state !== "delivered" &&
      record.state !== "disputed" &&
      record.state !== "in_transit"
    ) {
      throw new Error(
        `Cannot release funds from '${record.state}' state.`,
      );
    }

    const sellerRow = await this.env.quest_db
      .prepare(`SELECT stripe_connect_account_id FROM users WHERE id = ?`)
      .bind(record.sellerId)
      .first<{ stripe_connect_account_id: string | null }>()
      .catch(() => null);

    const sellerPayoutCents = Math.max(
      0,
      record.itemAmountCents - record.sellerFeeCents,
    );

    const { transferId } = await executeStripeConnectRelease(
      this.getSecretsEnv(),
      {
        escrowId: record.escrowId,
        paymentIntentId: record.stripePaymentIntentId,
        sellerPayoutCents,
        sellerConnectAccountId: sellerRow?.stripe_connect_account_id,
      },
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const prevState: EscrowLifecycleState = record.state;

    await this.ctx.storage.deleteAlarm();
    record.state = "released";
    record.stripeTransferId = transferId;
    record.activeAlarmType = null;
    record.activeAlarmAt = null;

    record.events.push({
      timestamp: nowSec,
      fromState: prevState,
      toState: "released",
      actor,
      note: `${reason} Stripe Connect transfer ${transferId} (${(
        sellerPayoutCents / 100
      ).toFixed(2)} USD net after 10% finder fee).`,
    });

    const statements = [
      this.env.quest_db
        .prepare(`UPDATE escrows SET state = 'released' WHERE id = ?`)
        .bind(record.escrowId),
      this.env.quest_db
        .prepare(`UPDATE quests SET status = 'fulfilled' WHERE id = ?`)
        .bind(record.questId),
    ];

    if (record.disputeId) {
      statements.push(
        this.env.quest_db
          .prepare(
            `UPDATE disputes
             SET status = 'buyer_fault',
                 resolution_notes = ?,
                 resolved_at = ?
             WHERE id = ?`,
          )
          .bind(reason, nowSec, record.disputeId),
      );
    }

    await this.env.quest_db.batch(statements);
    await this.saveState(record);
    return record;
  }

  /**
   * Refunds the buyer via Stripe when the seller misses the 5-business-day Ship-By SLA
   * or when a dispute resolves in the buyer's favor.
   */
  async refundBuyer(
    reason = "Refunded to buyer.",
    actor = "system",
  ): Promise<EscrowMachineState> {
    const record = await this.loadState();
    if (!record) {
      throw new Error("Escrow state not initialized.");
    }
    if (record.state === "refunded") {
      return record;
    }
    if (record.state === "released") {
      throw new Error("Cannot refund an escrow that has already been released.");
    }

    const { refundId } = await executeStripeEscrowRefund(this.getSecretsEnv(), {
      escrowId: record.escrowId,
      paymentIntentId: record.stripePaymentIntentId,
      reason,
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const prevState: EscrowLifecycleState = record.state;

    await this.ctx.storage.deleteAlarm();
    record.state = "refunded";
    record.stripeRefundId = refundId;
    record.activeAlarmType = null;
    record.activeAlarmAt = null;

    record.events.push({
      timestamp: nowSec,
      fromState: prevState,
      toState: "refunded",
      actor,
      note: `${reason} Stripe refund ${refundId} issued to buyer.`,
    });

    const statements = [
      this.env.quest_db
        .prepare(`UPDATE escrows SET state = 'refunded' WHERE id = ?`)
        .bind(record.escrowId),
    ];

    if (record.disputeId) {
      statements.push(
        this.env.quest_db
          .prepare(
            `UPDATE disputes
             SET status = 'seller_fault',
                 resolution_notes = ?,
                 resolved_at = ?
             WHERE id = ?`,
          )
          .bind(reason, nowSec, record.disputeId),
      );
    }

    await this.env.quest_db.batch(statements);
    await this.saveState(record);
    return record;
  }

  /**
   * Cloudflare Durable Object alarm handler:
   * - Fires after 5 business days if state is still `funded` or `label_created` -> Auto-Refunds buyer.
   * - Fires after 72 hours post-delivery if state is `delivered` -> Auto-Releases payout to seller.
   */
  async alarm(): Promise<void> {
    const record = await this.loadState();
    if (!record) return;

    if (record.state === "funded" || record.state === "label_created") {
      await this.refundBuyer(
        "Auto-refunded by EscrowMachine SLA alarm: Seller did not complete carrier origin scan within the 5-business-day ship-by window.",
        "alarm:ship_by_sla",
      );
      return;
    }

    if (record.state === "delivered") {
      await this.releaseFunds(
        "Auto-released by EscrowMachine inspection alarm: 72-hour post-delivery inspection window elapsed with zero SNAD disputes.",
        "alarm:inspection_window",
      );
    }
  }

  /**
   * Helper to trigger the currently armed Durable Object alarm immediately for live verification.
   */
  async triggerScheduledAlarmNow(): Promise<EscrowMachineState | null> {
    await this.alarm();
    return this.loadState();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/state") {
        const state = await this.getState();
        return Response.json({ state });
      }
      if (request.method === "POST" && url.pathname === "/initialize") {
        const body = (await request.json()) as InitializeEscrowInput;
        const state = await this.initialize(body);
        return Response.json({ state });
      }
      if (request.method === "POST" && url.pathname === "/generate-label") {
        const body = (await request.json().catch(() => ({}))) as {
          carrier?: string;
        };
        const state = await this.generateLabel(body);
        return Response.json({ state });
      }
      if (request.method === "POST" && url.pathname === "/carrier-event") {
        const body = (await request.json()) as {
          status: "in_transit" | "delivered";
          trackingNumber?: string;
          carrier?: string;
          actor?: string;
        };
        const state = await this.recordCarrierEvent(body);
        return Response.json({ state });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "EscrowMachine error";
      return Response.json({ error: message }, { status: 400 });
    }
  }
}
