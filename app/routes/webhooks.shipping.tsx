import { env } from "cloudflare:workers";
import type { Route } from "./+types/webhooks.shipping";

interface ShippingWebhookPayload {
  escrow_id?: string;
  tracking_number?: string;
  carrier?: string;
  status?: string;
  event?: string;
  description?: string;
  result?: {
    tracking_code?: string;
    carrier?: string;
    status?: string;
  };
  data?: {
    tracking_number?: string;
    carrier?: string;
    tracking_status?: {
      status?: string;
    };
  };
}

function normalizeCarrierStatus(
  rawStatus?: string,
): "in_transit" | "delivered" | null {
  if (!rawStatus) return null;
  const s = rawStatus.toLowerCase().trim();
  if (
    s === "in_transit" ||
    s === "transit" ||
    s === "out_for_delivery" ||
    s === "pre_transit_scanned" ||
    s === "accepted"
  ) {
    return "in_transit";
  }
  if (s === "delivered") {
    return "delivered";
  }
  return null;
}

export async function loader() {
  return Response.json({
    endpoint: "/webhooks/shipping",
    status: "active",
    providers: ["EasyPost (tracker.updated)", "Shippo (track_updated)", "Direct Carrier Scan"],
    transitions: {
      in_transit: "Clears 5-business-day Ship-By SLA auto-refund alarm",
      delivered: "Arms 72-hour post-delivery inspection auto-release alarm",
    },
  });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let payload: ShippingWebhookPayload;
  try {
    payload = (await request.json()) as ShippingWebhookPayload;
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const trackingNumber =
    payload.tracking_number ||
    payload.result?.tracking_code ||
    payload.data?.tracking_number ||
    undefined;

  const carrier =
    payload.carrier ||
    payload.result?.carrier ||
    payload.data?.carrier ||
    undefined;

  const rawStatus =
    payload.status ||
    payload.result?.status ||
    payload.data?.tracking_status?.status;

  const normalizedStatus = normalizeCarrierStatus(rawStatus);
  if (!normalizedStatus) {
    return Response.json(
      {
        received: true,
        handled: false,
        reason: `Unrecognized or non-transitioning carrier status: ${rawStatus || "none"}`,
      },
      { status: 200 },
    );
  }

  let escrowId = payload.escrow_id || null;
  if (!escrowId && trackingNumber) {
    const row = await env.quest_db
      .prepare(`SELECT id FROM escrows WHERE tracking_number = ?`)
      .bind(trackingNumber)
      .first<{ id: string }>();
    escrowId = row?.id || null;
  }

  if (!escrowId) {
    return Response.json(
      {
        error:
          "Could not resolve escrow_id from payload or tracking_number lookup in D1.",
      },
      { status: 404 },
    );
  }

  const doId = env.ESCROW_MACHINE.idFromName(escrowId);
  const stub = env.ESCROW_MACHINE.get(doId);

  try {
    const state = await stub.recordCarrierEvent({
      status: normalizedStatus,
      trackingNumber,
      carrier,
      actor: "carrier_webhook",
    });

    return Response.json({
      received: true,
      handled: true,
      escrow_id: escrowId,
      transitioned_to: state.state,
      active_alarm: state.activeAlarmType,
      active_alarm_at: state.activeAlarmAt,
      state,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to process carrier webhook";
    return Response.json({ error: message }, { status: 400 });
  }
}
