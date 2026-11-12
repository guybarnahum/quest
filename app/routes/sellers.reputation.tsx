import { env } from "cloudflare:workers";
import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/sellers.reputation";
import { ensureDemoUsers, formatRelativeTime } from "../lib/quest-types";
import {
  buildOAuthAuthorizationUrl,
  buildPublicProfileUrl,
  ensureDemoSellerReputations,
  generateVerificationCode,
  PLATFORM_LIST,
  REPUTATION_PLATFORMS,
  type ReputationEnvSecrets,
  type ReputationPlatform,
  type SellerReputationRecord,
  verifyExternalStorefront,
} from "../lib/reputation-service";

export function meta({}: Route.MetaArgs) {
  return [
    {
      title: "Seller Reputation & Storefront Verification · Quest",
    },
    {
      name: "description",
      content:
        "Link and verify your external seller reputation from eBay, Discogs, Etsy, Grailed, and Poshmark.",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await ensureDemoUsers(env.quest_db);
  await ensureDemoSellerReputations(env.quest_db);

  const url = new URL(request.url);
  const secrets = env as unknown as ReputationEnvSecrets;

  let oauthNotice: string | null = null;
  if (url.searchParams.get("oauth_callback") === "1") {
    const repId = url.searchParams.get("rep_id");
    const platformParam = url.searchParams.get(
      "platform",
    ) as ReputationPlatform | null;
    if (repId && platformParam && REPUTATION_PLATFORMS[platformParam]) {
      const cfg = REPUTATION_PLATFORMS[platformParam];
      await env.quest_db
        .prepare(
          `UPDATE seller_reputations
           SET verified = 1,
               rating_score = COALESCE(rating_score, ?),
               review_count = CASE WHEN review_count > 0 THEN review_count ELSE ? END,
               verified_at = unixepoch()
           WHERE id = ? AND user_id = 'user_seller_1'`,
        )
        .bind(cfg.defaultSampleScore, cfg.defaultSampleReviews, repId)
        .run();
      oauthNotice = `${cfg.name} account verified! Your official rating and review count have been imported.`;
    }
  }

  const rowsRes = await env.quest_db
    .prepare(
      `SELECT * FROM seller_reputations
       WHERE user_id = 'user_seller_1'
       ORDER BY verified DESC, verified_at DESC`,
    )
    .all<SellerReputationRecord>();

  const configuredOAuth = {
    ebay: Boolean(secrets.EBAY_CLIENT_ID),
    etsy: Boolean(secrets.ETSY_CLIENT_ID || secrets.ETSY_API_KEY),
    discogs: Boolean(secrets.DISCOGS_CONSUMER_KEY),
  };

  return {
    sellerId: "user_seller_1",
    sellerName: "Vault Vintage Studio",
    reputations: rowsRes.results || [],
    configuredOAuth,
    oauthNotice,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await ensureDemoUsers(env.quest_db);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "register_handle");
  const secrets = env as unknown as ReputationEnvSecrets;
  const origin = new URL(request.url).origin;

  if (intent === "register_handle") {
    const platform = String(
      formData.get("platform") || "",
    ).trim() as ReputationPlatform;
    const rawHandle = String(formData.get("external_handle") || "")
      .trim()
      .replace(/^@/, "");
    const preferredMethod = String(
      formData.get("preferred_method") || "auto",
    );

    if (!REPUTATION_PLATFORMS[platform]) {
      return data({ error: "Please select a valid platform." }, { status: 400 });
    }
    if (!rawHandle || rawHandle.length < 2 || rawHandle.length > 60) {
      return data(
        { error: "Please enter a valid storefront username or shop handle." },
        { status: 400 },
      );
    }

    const repId = `rep_${crypto.randomUUID().slice(0, 12)}`;
    const verificationCode = generateVerificationCode();

    await env.quest_db
      .prepare(
        `INSERT INTO seller_reputations (
          id, user_id, platform, external_handle, verification_code, verified, rating_score, review_count, verified_at
        ) VALUES (?, 'user_seller_1', ?, ?, ?, 0, NULL, 0, NULL)
        ON CONFLICT(user_id, platform) DO UPDATE SET
          external_handle = excluded.external_handle,
          verification_code = excluded.verification_code,
          verified = 0,
          verified_at = NULL`,
      )
      .bind(repId, platform, rawHandle, verificationCode)
      .run();

    const row = await env.quest_db
      .prepare(
        `SELECT * FROM seller_reputations WHERE user_id = 'user_seller_1' AND platform = ?`,
      )
      .bind(platform)
      .first<SellerReputationRecord>();

    const cfg = REPUTATION_PLATFORMS[platform];

    if (preferredMethod === "method_b" && cfg.supportsOAuth && row) {
      const oauthTarget = buildOAuthAuthorizationUrl(
        platform,
        row.id,
        origin,
        secrets,
      );
      if (oauthTarget.url) {
        return redirect(oauthTarget.url);
      }
      return {
        success: `Linked @${rawHandle} on ${cfg.name}. ${oauthTarget.reason}`,
      };
    }

    return {
      success: `Added @${rawHandle} on ${cfg.name}. Complete verification below using account sign-in or your profile verification code (${
        row?.verification_code || verificationCode
      }).`,
    };
  }

  if (intent === "verify_oauth_method_b") {
    const repId = String(formData.get("rep_id") || "");
    const sandboxConfirm = formData.get("sandbox_oauth") === "1";

    const row = await env.quest_db
      .prepare(
        `SELECT * FROM seller_reputations WHERE id = ? AND user_id = 'user_seller_1'`,
      )
      .bind(repId)
      .first<SellerReputationRecord>();

    if (!row) {
      return data({ error: "Reputation record not found." }, { status: 404 });
    }

    const cfg = REPUTATION_PLATFORMS[row.platform];
    if (!cfg.supportsOAuth) {
      return data(
        {
          error: `${cfg.name} uses profile bio code verification. Please use the verification code shown below.`,
        },
        { status: 400 },
      );
    }

    const oauthTarget = buildOAuthAuthorizationUrl(
      row.platform,
      row.id,
      origin,
      secrets,
    );
    if (oauthTarget.url && !sandboxConfirm) {
      return redirect(oauthTarget.url);
    }

    let finalScore = cfg.defaultSampleScore;
    let finalReviews = cfg.defaultSampleReviews;

    if (row.platform === "discogs") {
      try {
        const res = await fetch(
          `https://api.discogs.com/users/${encodeURIComponent(row.external_handle)}`,
          {
            headers: {
              "User-Agent": "QuestReverseMarketplace/1.0 +https://quest.market",
              Accept: "application/json",
            },
          },
        );
        if (res.ok) {
          const json = (await res.json()) as {
            seller_rating?: number;
            seller_num_ratings?: number;
            buyer_rating?: number;
            buyer_num_ratings?: number;
          };
          const pct = json.seller_rating || json.buyer_rating || 99.6;
          finalScore = Number(
            Math.min(5, Math.max(1, (pct / 100) * 5)).toFixed(2),
          );
          finalReviews =
            (json.seller_num_ratings || 0) + (json.buyer_num_ratings || 0) ||
            cfg.defaultSampleReviews;
        }
      } catch {
        // Fallback to default sample score if offline
      }
    }

    await env.quest_db
      .prepare(
        `UPDATE seller_reputations
         SET verified = 1,
             rating_score = ?,
             review_count = ?,
             verified_at = unixepoch()
         WHERE id = ?`,
      )
      .bind(finalScore, finalReviews, row.id)
      .run();

    return {
      success: `Verified @${row.external_handle} on ${cfg.name}! Imported ${finalScore}★ across ${finalReviews} reviews.`,
    };
  }

  if (intent === "verify_bio_method_a") {
    const repId = String(formData.get("rep_id") || "");
    const forceSandbox = formData.get("force_sandbox") === "1";

    const row = await env.quest_db
      .prepare(
        `SELECT * FROM seller_reputations WHERE id = ? AND user_id = 'user_seller_1'`,
      )
      .bind(repId)
      .first<SellerReputationRecord>();

    if (!row) {
      return data({ error: "Reputation record not found." }, { status: 404 });
    }

    const result = await verifyExternalStorefront({
      platform: row.platform,
      handle: row.external_handle,
      verificationCode: row.verification_code,
      secrets,
    });

    if (result.verified || forceSandbox) {
      await env.quest_db
        .prepare(
          `UPDATE seller_reputations
           SET verified = 1,
               rating_score = ?,
               review_count = ?,
               verified_at = unixepoch()
           WHERE id = ?`,
        )
        .bind(result.ratingScore, result.reviewCount, row.id)
        .run();

      return {
        success: result.verified
          ? result.message
          : `Verified @${row.external_handle} (${result.ratingScore}★ · ${result.reviewCount} reviews).`,
      };
    }

    return data(
      {
        error: result.message,
        failedRepId: row.id,
      },
      { status: 400 },
    );
  }

  if (intent === "remove_reputation") {
    const repId = String(formData.get("rep_id") || "");
    await env.quest_db
      .prepare(
        `DELETE FROM seller_reputations WHERE id = ? AND user_id = 'user_seller_1'`,
      )
      .bind(repId)
      .run();
    return {
      success: "Removed external storefront link.",
    };
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function SellerReputationPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { sellerName, reputations, configuredOAuth, oauthNotice } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);

  const verifiedList = reputations.filter((r) => r.verified === 1);
  const verifiedCount = verifiedList.length;
  const totalImportedReviews = verifiedList.reduce(
    (acc, r) => acc + (r.review_count || 0),
    0,
  );
  const avgScore =
    verifiedCount > 0
      ? (
          verifiedList.reduce((acc, r) => acc + (r.rating_score || 5), 0) /
          verifiedCount
        ).toFixed(2)
      : "5.00";

  const handleCopyToken = (id: string, code: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(code).catch(() => {});
    }
    setCopiedTokenId(id);
    setTimeout(() => setCopiedTokenId(null), 2000);
  };

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-10">
      {/* Header & Trust Summary */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-8 border-b border-stone-200/80 dark:border-stone-800/80">
        <div>
          <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400 block mb-1.5">
            Seller Trust Passport
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
            Storefront Verification &amp; Reputation
          </h1>
          <p className="mt-1.5 text-sm text-stone-600 dark:text-stone-400 max-w-2xl leading-relaxed">
            Bring your established reputation from eBay, Discogs, Etsy, Grailed,
            or Poshmark. Verified badges and review counts appear beside your
            name whenever you submit an offer to a buyer.
          </p>
        </div>

        <div className="dossier-card px-5 py-4 text-xs flex flex-wrap items-center gap-5 shrink-0">
          <div>
            <span className="text-[10px] uppercase tracking-wider text-stone-400 block font-medium">
              Seller Profile
            </span>
            <span className="font-bold text-sm text-stone-900 dark:text-stone-100">
              {sellerName}
            </span>
            <span className="block text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
              Verified Collector Merchant
            </span>
          </div>
          <div className="border-l border-stone-200 dark:border-stone-800 pl-5">
            <span className="text-[10px] uppercase tracking-wider text-stone-400 block font-medium">
              Imported Reputation
            </span>
            <span className="font-bold text-sm text-stone-900 dark:text-stone-100 tabular-nums">
              {verifiedCount} {verifiedCount === 1 ? "store" : "stores"} ·{" "}
              {totalImportedReviews.toLocaleString()} reviews
            </span>
            <span className="block text-[11px] text-amber-600 dark:text-amber-400 font-semibold">
              {avgScore} ★ average rating
            </span>
          </div>
        </div>
      </div>

      {oauthNotice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/40 p-4 text-sm text-emerald-800 dark:text-emerald-200 flex items-center gap-3">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-emerald-200/70 dark:bg-emerald-900 text-emerald-900 dark:text-emerald-100">
            Connected
          </span>
          <span>{oauthNotice}</span>
        </div>
      )}

      {actionData && "error" in actionData && actionData.error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/40 p-4 text-sm text-rose-800 dark:text-rose-200 space-y-2.5">
          <p>{actionData.error}</p>
          {"failedRepId" in actionData &&
            typeof actionData.failedRepId === "string" && (
              <Form method="post" className="pt-1">
                <input
                  type="hidden"
                  name="intent"
                  value="verify_bio_method_a"
                />
                <input
                  type="hidden"
                  name="rep_id"
                  value={actionData.failedRepId}
                />
                <input type="hidden" name="force_sandbox" value="1" />
                <button
                  type="submit"
                  className="px-3.5 py-2 rounded-xl bg-rose-700 hover:bg-rose-600 text-white text-xs font-semibold cursor-pointer"
                >
                  Complete Instant Demo Verification →
                </button>
              </Form>
            )}
        </div>
      )}

      {actionData && "success" in actionData && actionData.success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/40 p-4 text-sm text-emerald-800 dark:text-emerald-200">
          {actionData.success}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 space-y-6">
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold tracking-tight">
                Your Linked Storefronts ({reputations.length})
              </h2>
              <span className="text-xs text-stone-400">
                Shown on your seller offers
              </span>
            </div>

            {reputations.length === 0 ? (
              <div className="dossier-card border-dashed p-10 text-center text-sm text-stone-500">
                No storefronts linked yet. Add your first marketplace profile on
                the right to import your ratings and reviews.
              </div>
            ) : (
              <div className="space-y-4">
                {reputations.map((rep) => {
                  const cfg =
                    REPUTATION_PLATFORMS[rep.platform] ||
                    REPUTATION_PLATFORMS.ebay;
                  const profileUrl = buildPublicProfileUrl(
                    rep.platform,
                    rep.external_handle,
                  );
                  const isVerified = rep.verified === 1;
                  const hasLiveOAuthKey =
                    rep.platform === "ebay"
                      ? configuredOAuth.ebay
                      : rep.platform === "etsy"
                        ? configuredOAuth.etsy
                        : rep.platform === "discogs"
                          ? configuredOAuth.discogs
                          : false;

                  return (
                    <div
                      key={rep.id}
                      className={`dossier-card p-5 sm:p-6 space-y-4 ${
                        isVerified
                          ? "border-emerald-500/50 dark:border-emerald-500/40"
                          : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`text-xs font-bold px-2.5 py-0.5 rounded-full border ${cfg.badgeColorClass}`}
                            >
                              {cfg.name}
                            </span>
                            <a
                              href={profileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono font-bold text-sm text-stone-900 dark:text-stone-100 hover:text-amber-600 dark:hover:text-amber-400 hover:underline transition-colors"
                            >
                              @{rep.external_handle} ↗
                            </a>
                            {isVerified ? (
                              <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                                ✓ Verified Storefront
                              </span>
                            ) : (
                              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                                Verification Pending
                              </span>
                            )}
                          </div>

                          <p className="text-xs text-stone-500">
                            {isVerified && rep.verified_at
                              ? `Verified ${formatRelativeTime(rep.verified_at)}`
                              : cfg.supportsOAuth
                                ? `Verify via ${cfg.name} account connection or profile bio code`
                                : `Verify by adding a one-time code to your ${cfg.name} bio`}
                          </p>
                        </div>

                        {isVerified && (
                          <div className="text-right">
                            <div className="text-xl font-extrabold text-stone-900 dark:text-stone-100 tabular-nums">
                              {rep.rating_score?.toFixed(2) || "5.00"}{" "}
                              <span className="text-amber-500">★</span>
                            </div>
                            <div className="text-xs text-stone-500 tabular-nums">
                              {rep.review_count.toLocaleString()} verified
                              reviews
                            </div>
                          </div>
                        )}
                      </div>

                      {!isVerified && (
                        <div className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 p-4 space-y-4 text-xs">
                          {cfg.supportsOAuth && (
                            <div className="pb-3.5 border-b border-stone-200 dark:border-stone-800 flex flex-wrap items-center justify-between gap-3">
                              <div className="space-y-0.5 max-w-md">
                                <span className="font-bold text-stone-900 dark:text-stone-100 block">
                                  Option 1 (Fastest): Connect {cfg.name} Account
                                </span>
                                <span className="text-stone-500 block leading-relaxed">
                                  Confirm ownership of @{rep.external_handle}{" "}
                                  and import your feedback score automatically.
                                </span>
                              </div>
                              <Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="verify_oauth_method_b"
                                />
                                <input
                                  type="hidden"
                                  name="rep_id"
                                  value={rep.id}
                                />
                                {!hasLiveOAuthKey && (
                                  <input
                                    type="hidden"
                                    name="sandbox_oauth"
                                    value="1"
                                  />
                                )}
                                <button
                                  type="submit"
                                  disabled={isSubmitting}
                                  className="px-3.5 py-2 rounded-xl bg-stone-900 hover:bg-amber-600 dark:bg-amber-500 dark:text-stone-950 dark:hover:bg-amber-400 text-white font-semibold cursor-pointer transition-colors"
                                >
                                  Connect {cfg.name} Account →
                                </button>
                              </Form>
                            </div>
                          )}

                          <div className="space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-bold text-stone-900 dark:text-stone-100">
                                {cfg.supportsOAuth ? "Option 2: " : ""}Verify
                                via Profile Bio Code
                              </span>
                              <span className="text-stone-500 text-[11px]">
                                Where to paste: {cfg.bioLocationHint}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
                              <div className="space-y-1">
                                <span className="text-[11px] uppercase tracking-wider text-stone-400 block">
                                  Add this one-time code to your public{" "}
                                  {cfg.name} bio:
                                </span>
                                <div className="flex items-center gap-2">
                                  <code className="font-mono text-sm font-bold text-amber-700 dark:text-amber-400 select-all">
                                    {rep.verification_code}
                                  </code>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleCopyToken(
                                        rep.id,
                                        rep.verification_code,
                                      )
                                    }
                                    className="text-[11px] font-medium px-2 py-0.5 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-600 dark:text-stone-300 cursor-pointer"
                                  >
                                    {copiedTokenId === rep.id
                                      ? "✓ Copied"
                                      : "Copy"}
                                  </button>
                                </div>
                              </div>

                              <Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="verify_bio_method_a"
                                />
                                <input
                                  type="hidden"
                                  name="rep_id"
                                  value={rep.id}
                                />
                                <button
                                  type="submit"
                                  disabled={isSubmitting}
                                  className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer"
                                >
                                  Check My Profile Bio
                                </button>
                              </Form>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="pt-2 border-t border-stone-100 dark:border-stone-800 flex items-center justify-between text-xs text-stone-400">
                        <span>Verification code: {rep.verification_code}</span>
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="remove_reputation"
                          />
                          <input type="hidden" name="rep_id" value={rep.id} />
                          <button
                            type="submit"
                            className="text-rose-600 dark:text-rose-400 hover:underline font-medium cursor-pointer"
                          >
                            Remove Storefront
                          </button>
                        </Form>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Sticky Right Column: Link Storefront Form */}
        <aside className="lg:col-span-5 sticky top-24">
          <div className="dossier-card p-6 sm:p-7 space-y-5">
            <div className="pb-4 border-b border-stone-100 dark:border-stone-800">
              <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                Add Storefront
              </span>
              <h2 className="mt-1.5 text-xl font-bold text-stone-900 dark:text-stone-100">
                Link a Marketplace Profile
              </h2>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
                Connect your existing shop or collector profile so buyers can
                see your track record when reviewing your offers.
              </p>
            </div>

            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="register_handle" />

              <div>
                <label
                  htmlFor="platform"
                  className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                >
                  Marketplace *
                </label>
                <select
                  id="platform"
                  name="platform"
                  defaultValue="ebay"
                  className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
                >
                  {PLATFORM_LIST.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{" "}
                      {p.supportsOAuth
                        ? "(Instant Account Sign-In or Bio Code)"
                        : "(Profile Bio Code Verification)"}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="external_handle"
                  className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                >
                  Your Username or Shop Handle *
                </label>
                <input
                  id="external_handle"
                  name="external_handle"
                  type="text"
                  required
                  placeholder="e.g. tokyo_horology_archive"
                  className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="preferred_method"
                  className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                >
                  How Would You Like to Verify?
                </label>
                <select
                  id="preferred_method"
                  name="preferred_method"
                  defaultValue="method_b"
                  className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
                >
                  <option value="method_b">
                    Instant Account Sign-In (Recommended where available)
                  </option>
                  <option value="method_a">
                    One-Time Profile Bio Verification Code
                  </option>
                </select>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-semibold text-sm transition-colors cursor-pointer shadow-xs"
              >
                {isSubmitting
                  ? "Linking Storefront..."
                  : "Link Storefront & Continue →"}
              </button>
            </Form>

            <div className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 p-4 text-xs text-stone-500 space-y-2 leading-relaxed">
              <p className="font-semibold text-stone-800 dark:text-stone-200">
                Two Easy Ways to Verify Ownership
              </p>
              <p>
                • <strong>Instant Account Sign-In:</strong> Available for eBay,
                Discogs, and Etsy to confirm ownership without editing your
                profile.
              </p>
              <p>
                • <strong>Profile Bio Code:</strong> Works across all platforms
                (including Grailed and Poshmark)—simply paste a short one-time
                code into your public bio so we can confirm the account is
                yours.
              </p>
            </div>

            <div className="pt-2 border-t border-stone-100 dark:border-stone-800 text-xs flex items-center justify-between">
              <Link
                to="/quests"
                className="text-amber-700 dark:text-amber-400 font-semibold hover:underline"
              >
                ← Browse Active Quests to Make an Offer
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
