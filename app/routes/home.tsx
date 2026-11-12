import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/home";
import {
  formatCents,
  formatRelativeTime,
  QUEST_CATEGORIES,
  STRICTNESS_LEVELS,
  type QuestRecord,
} from "../lib/quest-types";

export function meta({}: Route.MetaArgs) {
  return [
    {
      title: "Quest · The Reverse Marketplace for Rare & Discontinued Goods",
    },
    {
      name: "description",
      content:
        "Post a buying Quest with your budget and match preference. Collectors, boutiques, and archives pitch verified offers backed by 72-hour inspection escrow.",
    },
  ];
}

export async function loader() {
  const [recentRes, statsRes] = await Promise.all([
    env.quest_db
      .prepare(
        `SELECT q.*, u.display_name AS buyer_name,
          (SELECT COUNT(*) FROM offers o WHERE o.quest_id = q.id) AS offer_count
         FROM quests q
         LEFT JOIN users u ON u.id = q.buyer_id
         WHERE q.status = 'open'
         ORDER BY q.created_at DESC
         LIMIT 6`,
      )
      .all<QuestRecord>()
      .catch(() => ({ results: [] as QuestRecord[] })),
    env.quest_db
      .prepare(
        `SELECT
          COUNT(*) AS open_count,
          COALESCE(SUM(max_budget_cents), 0) AS total_bounty_cents,
          (SELECT COUNT(*) FROM offers) AS total_offers
         FROM quests
         WHERE status = 'open'`,
      )
      .first<{
        open_count: number;
        total_bounty_cents: number;
        total_offers: number;
      }>()
      .catch(() => null),
  ]);

  return {
    recentQuests: recentRes.results || [],
    stats: {
      openCount: statsRes?.open_count ?? 0,
      totalBountyCents: statsRes?.total_bounty_cents ?? 0,
      totalOffers: statsRes?.total_offers ?? 0,
    },
  };
}

const SAMPLE_SEARCHES = [
  { label: "Seiko SARB033", query: "SARB033" },
  { label: "First Edition Print", query: "first edition" },
  { label: "70s Field Watch", query: "70s field watch" },
  { label: "Archive Shell Jacket", query: "archive shell" },
];

const MATCH_TYPE_LABELS: Record<string, string> = {
  exact: "Exact Item",
  alternative: "Close Alternative",
  curated: "Curated Discovery",
};

export default function Home({ loaderData }: Route.ComponentProps) {
  const { recentQuests, stats } = loaderData;
  const spotlightQuest = recentQuests[0] || null;

  return (
    <main className="space-y-24 pb-12">
      {/* Editorial Hero Section */}
      <section className="relative overflow-hidden border-b border-stone-200/90 dark:border-stone-800/90 bg-archival-grid bg-gradient-to-b from-amber-50/50 via-[#FAF8F5] to-[#FAF8F5] dark:from-stone-900/50 dark:via-[#0C0B0A] dark:to-[#0C0B0A]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20 lg:py-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
            <div className="lg:col-span-7 space-y-6">
              <div className="inline-flex flex-wrap items-center gap-2 rounded-full border border-amber-400/50 dark:border-amber-600/40 bg-amber-100/60 dark:bg-amber-950/50 px-3.5 py-1 text-xs font-medium text-amber-950 dark:text-amber-200">
                <span className="font-semibold uppercase tracking-wider text-[11px]">
                  The Collector&apos;s Reverse Marketplace
                </span>
                <span className="text-amber-600 dark:text-amber-400">·</span>
                <span className="text-stone-700 dark:text-stone-300">
                  72-Hour Buyer Inspection Guarantee
                </span>
              </div>

              <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] font-extrabold tracking-tight text-stone-900 dark:text-stone-100 leading-[1.06]">
                Stop refreshing search alerts.{" "}
                <span className="font-display italic font-normal text-amber-700 dark:text-amber-400 text-[1.08em]">
                  Let rare inventory find you.
                </span>
              </h1>

              <p className="text-base sm:text-lg text-stone-600 dark:text-stone-300 leading-relaxed max-w-2xl">
                Post a buying <strong>Quest</strong> for discontinued watches,
                out-of-print books, archival garments, or rare audio gear with
                your maximum budget and match preferences. Verified collectors
                and dealers come to you with photo-documented offers protected
                by escrow.
              </p>

              <Form
                action="/quests"
                method="get"
                className="pt-1 max-w-2xl space-y-3"
              >
                <div className="flex flex-col sm:flex-row gap-2.5 p-1.5 rounded-2xl bg-white dark:bg-stone-900 border border-stone-300/90 dark:border-stone-700/90 shadow-sm focus-within:border-amber-600 dark:focus-within:border-amber-500 transition-colors">
                  <div className="flex-1 flex items-center pl-3">
                    <span className="text-stone-400 text-sm mr-2.5 select-none">
                      ⌕
                    </span>
                    <input
                      type="search"
                      name="q"
                      placeholder="Have an item to sell? Search by model, ISBN, brand, or era..."
                      className="w-full bg-transparent py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-amber-600 dark:bg-amber-500 dark:text-stone-950 dark:hover:bg-amber-400 text-white text-sm font-semibold transition-colors cursor-pointer shrink-0"
                  >
                    Search Quests
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-[11px] uppercase tracking-wider text-stone-400 font-medium">
                    Popular searches:
                  </span>
                  {SAMPLE_SEARCHES.map((item) => (
                    <Link
                      key={item.query}
                      to={`/quests?q=${encodeURIComponent(item.query)}`}
                      className="px-2.5 py-1 rounded-lg border border-stone-200 dark:border-stone-800 bg-white/80 dark:bg-stone-900/80 text-stone-600 dark:text-stone-300 hover:border-amber-500 hover:text-amber-700 dark:hover:text-amber-400 transition-colors"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </Form>

              <div className="pt-2 flex flex-wrap items-center gap-3">
                <Link
                  to="/quests/new"
                  className="px-6 py-3.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm shadow-xs transition-colors"
                >
                  + Post a Buying Quest
                </Link>
                <Link
                  to="/quests"
                  className="px-6 py-3.5 rounded-xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-900 dark:text-stone-100 font-semibold text-sm transition-colors"
                >
                  Browse Open Quests →
                </Link>
              </div>
            </div>

            {/* Right Column: Featured Request Preview */}
            <div className="lg:col-span-5">
              <div className="relative">
                <div className="absolute -inset-1 rounded-3xl bg-gradient-to-tr from-amber-500/20 via-stone-400/10 to-emerald-500/20 blur-xl pointer-events-none" />
                <div className="relative dossier-card p-6 sm:p-7 space-y-5 border-stone-300/90 dark:border-stone-700/90">
                  <div className="flex items-center justify-between gap-2 pb-4 border-b border-stone-200/80 dark:border-stone-800">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                        Featured Collector Request
                      </span>
                    </div>
                    <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-500/20">
                      Escrow Protected
                    </span>
                  </div>

                  {spotlightQuest ? (
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
                            {spotlightQuest.category}
                          </span>
                          <h2 className="mt-1 font-bold text-lg text-stone-900 dark:text-stone-100 leading-snug line-clamp-2">
                            {spotlightQuest.title}
                          </h2>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-[10px] uppercase tracking-wider text-stone-400 block font-medium">
                            Max Budget
                          </span>
                          <span className="text-2xl font-extrabold text-amber-600 dark:text-amber-400 tabular-nums">
                            {formatCents(spotlightQuest.max_budget_cents)}
                          </span>
                        </div>
                      </div>

                      {(spotlightQuest.brand ||
                        spotlightQuest.model_or_isbn ||
                        spotlightQuest.size_or_spec) && (
                        <div className="grid grid-cols-3 gap-2 p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800 text-xs">
                          <div>
                            <span className="text-[10px] uppercase text-stone-400 block">
                              Maker
                            </span>
                            <span className="font-semibold text-stone-800 dark:text-stone-200 truncate block">
                              {spotlightQuest.brand || "—"}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] uppercase text-stone-400 block">
                              Model / ISBN
                            </span>
                            <span className="font-mono font-semibold text-stone-800 dark:text-stone-200 truncate block">
                              {spotlightQuest.model_or_isbn || "—"}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] uppercase text-stone-400 block">
                              Size / Spec
                            </span>
                            <span className="font-semibold text-stone-800 dark:text-stone-200 truncate block">
                              {spotlightQuest.size_or_spec || "—"}
                            </span>
                          </div>
                        </div>
                      )}

                      <p className="text-xs text-stone-600 dark:text-stone-400 line-clamp-2 leading-relaxed">
                        {spotlightQuest.description}
                      </p>

                      <div className="pt-2 flex items-center justify-between gap-2">
                        <span
                          className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
                            (
                              STRICTNESS_LEVELS[spotlightQuest.strictness] ||
                              STRICTNESS_LEVELS[1]
                            ).badgeClass
                          }`}
                        >
                          {
                            (
                              STRICTNESS_LEVELS[spotlightQuest.strictness] ||
                              STRICTNESS_LEVELS[1]
                            ).shortLabel
                          }
                        </span>
                        <Link
                          to={`/quests/${spotlightQuest.id}`}
                          className="text-xs font-semibold text-amber-700 dark:text-amber-400 hover:underline"
                        >
                          View Request &amp; Make an Offer →
                        </Link>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <span className="text-xs font-medium text-stone-500">
                            Watches &amp; Horology
                          </span>
                          <h2 className="mt-1 font-bold text-lg text-stone-900 dark:text-stone-100">
                            Seiko SARB033 Spirit Mechanical Full Kit
                          </h2>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-[10px] uppercase text-stone-400 block">
                            Max Budget
                          </span>
                          <span className="text-2xl font-extrabold text-amber-600 dark:text-amber-400 tabular-nums">
                            $650
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-stone-600 dark:text-stone-400 leading-relaxed">
                        Unpolished case with original 6R15 movement, box, and
                        warranty card. Looking for an exact match only.
                      </p>
                    </div>
                  )}

                  <div className="pt-4 border-t border-stone-200/80 dark:border-stone-800 space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-stone-500 font-medium">
                      <span>How Every Sale Is Protected</span>
                      <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                        ● 72-Hour Inspection
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5 text-[10px] font-medium text-center">
                      <div className="py-1.5 rounded bg-stone-900 text-amber-400 dark:bg-amber-500 dark:text-stone-950 font-semibold">
                        1. Funded
                      </div>
                      <div className="py-1.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300">
                        2. Prepaid Label
                      </div>
                      <div className="py-1.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300">
                        3. Shipped
                      </div>
                      <div className="py-1.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300">
                        4. Verified
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 3-Column Marketplace Highlights */}
          <dl className="mt-14 grid grid-cols-1 sm:grid-cols-3 gap-4 pt-8 border-t border-stone-200/80 dark:border-stone-800/80">
            <div className="dossier-card p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <dt className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                  Active Buyer Budgets
                </dt>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  Live Demand
                </span>
              </div>
              <dd className="mt-2 text-3xl sm:text-4xl font-extrabold text-amber-600 dark:text-amber-400 tabular-nums">
                {formatCents(stats.totalBountyCents)}
              </dd>
              <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
                Committed across{" "}
                <strong className="text-stone-800 dark:text-stone-200">
                  {stats.openCount}
                </strong>{" "}
                open collector Quest{stats.openCount === 1 ? "" : "s"}
              </p>
            </div>

            <div className="dossier-card p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <dt className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                  Smart Collector Discovery
                </dt>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300">
                  Exact &amp; Style
                </span>
              </div>
              <dd className="mt-2 text-3xl sm:text-4xl font-extrabold text-stone-900 dark:text-stone-100">
                Ref &amp; Era Match
              </dd>
              <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
                Search by exact model number or ISBN, or browse by era,
                craftsmanship, and style
              </p>
            </div>

            <div className="dossier-card p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <dt className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                  Escrow Protection
                </dt>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                  Verified
                </span>
              </div>
              <dd className="mt-2 text-3xl sm:text-4xl font-extrabold text-stone-900 dark:text-stone-100">
                72-Hour Window
              </dd>
              <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
                <strong className="text-stone-800 dark:text-stone-200">
                  {stats.totalOffers}
                </strong>{" "}
                verified seller offer{stats.totalOffers === 1 ? "" : "s"}{" "}
                submitted with proof photos
              </p>
            </div>
          </dl>
        </div>
      </section>

      {/* Recent Open Buying Quests */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
              Wanted by Collectors
            </span>
            <h2 className="mt-1.5 text-2xl sm:text-3xl font-bold tracking-tight">
              Recent Open Buying Quests
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Have one of these pieces in your collection or shop? View the
              buyer&apos;s request and pitch an offer directly.
            </p>
          </div>
          <Link
            to="/quests"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-400 hover:text-amber-600 transition-colors"
          >
            <span>Browse all open Quests ({stats.openCount})</span>
            <span>→</span>
          </Link>
        </div>

        {/* Category Filter Strip */}
        <div className="mb-8 flex items-center gap-2 overflow-x-auto pb-2">
          <Link
            to="/quests"
            className="shrink-0 text-xs font-semibold px-3.5 py-2 rounded-xl bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-950 transition-colors"
          >
            All Categories
          </Link>
          {QUEST_CATEGORIES.map((category) => (
            <Link
              key={category}
              to={`/quests?category=${encodeURIComponent(category)}`}
              className="shrink-0 text-xs font-medium px-3.5 py-2 rounded-xl border border-stone-200/90 dark:border-stone-800 bg-white dark:bg-stone-900 hover:border-amber-500 hover:text-amber-700 dark:hover:text-amber-400 text-stone-700 dark:text-stone-300 transition-colors"
            >
              {category}
            </Link>
          ))}
        </div>

        {recentQuests.length === 0 ? (
          <div className="dossier-card border-dashed p-12 text-center">
            <h3 className="text-base font-semibold">
              No active Quests posted yet
            </h3>
            <p className="mt-1 text-sm text-stone-500 max-w-md mx-auto">
              Be the first collector to post a bounty for a rare or discontinued
              item.
            </p>
            <Link
              to="/quests/new"
              className="mt-4 inline-flex px-4 py-2.5 rounded-xl bg-amber-600 text-white text-sm font-semibold hover:bg-amber-500 transition-colors"
            >
              + Post First Quest
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {recentQuests.map((quest) => {
              const strictInfo =
                STRICTNESS_LEVELS[quest.strictness] || STRICTNESS_LEVELS[1];
              return (
                <Link
                  key={quest.id}
                  to={`/quests/${quest.id}`}
                  className="group flex flex-col dossier-card dossier-card-hover overflow-hidden"
                >
                  <div className="relative h-48 bg-stone-100 dark:bg-stone-950 border-b border-stone-200/70 dark:border-stone-800/80 flex items-center justify-center overflow-hidden">
                    {quest.reference_image_key ? (
                      <img
                        src={`/assets/${quest.reference_image_key}`}
                        alt={quest.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                    ) : (
                      <div className="w-full h-full bg-archival-grid flex flex-col items-center justify-center p-6 text-center">
                        <span className="text-[10px] font-medium uppercase tracking-widest text-stone-400 dark:text-stone-500 px-2.5 py-0.5 rounded border border-stone-200 dark:border-stone-800 bg-white/80 dark:bg-stone-900/80">
                          {quest.category}
                        </span>
                        {quest.brand ? (
                          <p className="mt-3 font-display italic text-2xl text-stone-700 dark:text-stone-300">
                            {quest.brand}
                          </p>
                        ) : (
                          <p className="mt-3 font-display italic text-2xl text-stone-500 dark:text-stone-400">
                            Collector Request
                          </p>
                        )}
                        {quest.model_or_isbn && (
                          <span className="mt-1 font-mono text-xs text-stone-500 dark:text-stone-400">
                            Ref. {quest.model_or_isbn}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
                      <span
                        className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border backdrop-blur-xs ${strictInfo.badgeClass}`}
                      >
                        {strictInfo.shortLabel}
                      </span>
                    </div>

                    <div className="absolute bottom-3 right-3 rounded-xl bg-stone-950/90 text-white px-3 py-1.5 text-xs font-bold backdrop-blur-xs border border-white/10 shadow-sm tabular-nums">
                      <span className="text-[10px] uppercase tracking-wider text-stone-400 mr-1.5 font-normal">
                        Up to
                      </span>
                      <span className="text-amber-400">
                        {formatCents(quest.max_budget_cents)}
                      </span>
                    </div>
                  </div>

                  <div className="p-5 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-2 text-xs text-stone-500 dark:text-stone-400">
                        <span className="font-medium truncate">
                          {quest.category}
                        </span>
                        <span className="text-[11px] shrink-0">
                          {formatRelativeTime(quest.created_at)}
                        </span>
                      </div>

                      <h3 className="mt-1.5 font-bold text-base text-stone-900 dark:text-stone-100 group-hover:text-amber-700 dark:group-hover:text-amber-400 transition-colors line-clamp-2 leading-snug">
                        {quest.title}
                      </h3>

                      {(quest.brand ||
                        quest.model_or_isbn ||
                        quest.size_or_spec) && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {quest.brand && (
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800/90 text-stone-700 dark:text-stone-300">
                              {quest.brand}
                            </span>
                          )}
                          {quest.model_or_isbn && (
                            <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800/90 text-stone-700 dark:text-stone-300">
                              {quest.model_or_isbn}
                            </span>
                          )}
                          {quest.size_or_spec && (
                            <span className="text-[11px] px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800/90 text-stone-700 dark:text-stone-300">
                              {quest.size_or_spec}
                            </span>
                          )}
                        </div>
                      )}

                      <p className="mt-2.5 text-xs text-stone-600 dark:text-stone-400 line-clamp-2 leading-relaxed">
                        {quest.description}
                      </p>
                    </div>

                    <div className="mt-4 pt-3.5 border-t border-stone-100 dark:border-stone-800/80 flex items-center justify-between text-xs">
                      <span className="text-stone-500 dark:text-stone-400 truncate">
                        By{" "}
                        <strong className="font-medium text-stone-700 dark:text-stone-300">
                          {quest.buyer_name || "Collector"}
                        </strong>
                      </span>
                      <span className="font-semibold text-amber-700 dark:text-amber-400 shrink-0 group-hover:translate-x-0.5 transition-transform">
                        {quest.offer_count || 0} offer
                        {quest.offer_count === 1 ? "" : "s"} →
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Match Preferences Section */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
              Signal Without the Noise
            </span>
            <h2 className="mt-1.5 text-2xl sm:text-3xl font-bold tracking-tight">
              You Control How Strictly Sellers Match Your Request
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400 max-w-2xl">
              Every Quest sets clear expectations up front—so collectors hunting
              a specific reference number never receive unwanted substitutes.
            </p>
          </div>
          <Link
            to="/quests/new"
            className="text-xs font-semibold px-4 py-2.5 rounded-xl border border-stone-300 dark:border-stone-700 hover:border-amber-500 transition-colors self-start md:self-auto"
          >
            Post a Buying Quest →
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {([1, 2, 3] as const).map((lvl) => {
            const info = STRICTNESS_LEVELS[lvl];
            const allMatchTypes = ["exact", "alternative", "curated"] as const;
            return (
              <div
                key={lvl}
                className="dossier-card p-6 sm:p-7 flex flex-col justify-between space-y-5"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full border ${info.badgeClass}`}
                    >
                      {info.shortLabel}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-stone-900 dark:text-stone-100">
                    {info.name}
                  </h3>
                  <p className="text-sm text-stone-600 dark:text-stone-400 leading-relaxed">
                    {info.description}
                  </p>
                </div>

                <div className="pt-4 border-t border-stone-100 dark:border-stone-800 space-y-2">
                  <span className="text-[11px] uppercase tracking-wider text-stone-400 block font-medium">
                    Accepted Seller Offers
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {allMatchTypes.map((mt) => {
                      const allowed = (
                        info.allowedMatchTypes as readonly string[]
                      ).includes(mt);
                      return (
                        <span
                          key={mt}
                          className={`text-xs px-2.5 py-1 rounded-lg border ${
                            allowed
                              ? "bg-stone-900 text-white border-stone-900 dark:bg-stone-100 dark:text-stone-950 dark:border-stone-100 font-semibold"
                              : "bg-stone-50 text-stone-400 border-stone-200 dark:bg-stone-950 dark:text-stone-600 dark:border-stone-800 line-through"
                          }`}
                        >
                          {allowed ? "✓ " : "✕ "}
                          {MATCH_TYPE_LABELS[mt]}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* End-to-End Trust & Escrow Section */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="rounded-3xl border border-stone-800 bg-stone-950 text-stone-100 p-8 sm:p-12 relative overflow-hidden">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-10 border-b border-stone-800">
            <div className="max-w-2xl">
              <span className="text-xs font-semibold uppercase tracking-widest text-amber-400">
                Buyer &amp; Seller Protection
              </span>
              <h2 className="mt-2 text-2xl sm:text-4xl font-bold tracking-tight">
                How Quest Escrow &amp; Fulfillment Works
              </h2>
              <p className="mt-2.5 text-sm text-stone-300 leading-relaxed">
                Every accepted offer is protected from end to end—sellers never
                ship without locked funds, and buyers get a full 72 hours after
                delivery to verify condition and authenticity.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 shrink-0">
              <Link
                to="/sellers/reputation"
                className="px-4 py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-100 text-xs font-semibold border border-stone-700 transition-colors"
              >
                ✓ Verify Your Storefront
              </Link>
              <Link
                to="/quests/new"
                className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-semibold transition-colors"
              >
                + Post a Buying Quest
              </Link>
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <div className="rounded-2xl bg-stone-900/90 border border-stone-800 p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-2.5">
                <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                  Step 01
                </span>
                <h3 className="font-semibold text-base text-white">
                  Post Your Quest
                </h3>
                <p className="text-xs text-stone-400 leading-relaxed">
                  Share the item specifications, condition requirements,
                  reference photo, and the maximum price you are willing to pay.
                </p>
              </div>
              <div className="pt-3 border-t border-stone-800/80 text-[11px] text-stone-500">
                Free to post · No upfront charge
              </div>
            </div>

            <div className="rounded-2xl bg-stone-900/90 border border-stone-800 p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-2.5">
                <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                  Step 02
                </span>
                <h3 className="font-semibold text-base text-white">
                  Review Verified Offers
                </h3>
                <p className="text-xs text-stone-400 leading-relaxed">
                  Collectors and dealers with matching inventory submit offers
                  with proof photos, condition grades, and verified storefront
                  ratings.
                </p>
              </div>
              <div className="pt-3 border-t border-stone-800/80 text-[11px] text-stone-500">
                eBay, Discogs, Etsy, Grailed &amp; Poshmark badges
              </div>
            </div>

            <div className="rounded-2xl bg-stone-900/90 border border-stone-800 p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-2.5">
                <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                  Step 03
                </span>
                <h3 className="font-semibold text-base text-white">
                  Prepaid Insured Shipping
                </h3>
                <p className="text-xs text-stone-400 leading-relaxed">
                  Accepting an offer locks funds in escrow and issues an
                  address-protected prepaid label. Orders auto-refund if not
                  shipped within 5 business days.
                </p>
              </div>
              <div className="pt-3 border-t border-stone-800/80 text-[11px] text-stone-500">
                Private addresses for both parties
              </div>
            </div>

            <div className="rounded-2xl bg-stone-900/90 border border-stone-800 p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-2.5">
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  Step 04
                </span>
                <h3 className="font-semibold text-base text-white">
                  72-Hour Buyer Inspection
                </h3>
                <p className="text-xs text-stone-400 leading-relaxed">
                  Once delivered, you have 72 hours to verify authenticity and
                  condition before seller payout is released—or freeze funds if
                  something isn&apos;t right.
                </p>
              </div>
              <div className="pt-3 border-t border-stone-800/80 text-[11px] text-emerald-400">
                Guaranteed authenticity window
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
