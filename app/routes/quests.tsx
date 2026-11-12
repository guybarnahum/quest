import { env } from "cloudflare:workers";
import { Form, Link, useSearchParams } from "react-router";
import type { Route } from "./+types/quests";
import {
  formatCents,
  formatRelativeTime,
  QUEST_CATEGORIES,
  STRICTNESS_LEVELS,
  type QuestRecord,
  type StrictnessLevel,
} from "../lib/quest-types";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Browse Quests · Discover Active Buying Bounties" },
    {
      name: "description",
      content:
        "Search active buyer Quests for rare, vintage, and discontinued items by model number, ISBN, brand, or style.",
    },
  ];
}

function buildFtsQuery(rawQuery: string): string {
  const tokens = rawQuery
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const category = (url.searchParams.get("category") || "").trim();
  const strictnessParam = Number(url.searchParams.get("strictness") || 0);
  const strictness = [1, 2, 3].includes(strictnessParam)
    ? (strictnessParam as StrictnessLevel)
    : null;

  let quests: QuestRecord[] = [];
  let searchDiagnostics: {
    ftsCount: number;
    vectorCount: number;
    mode: "browse" | "hybrid";
  } = {
    ftsCount: 0,
    vectorCount: 0,
    mode: q ? "hybrid" : "browse",
  };

  if (q) {
    const ftsMatchExpr = buildFtsQuery(q);

    const ftsPromise = ftsMatchExpr
      ? env.quest_db
          .prepare(
            `SELECT q.*, u.display_name AS buyer_name,
              (SELECT COUNT(*) FROM offers o WHERE o.quest_id = q.id) AS offer_count
             FROM quests_fts f
             JOIN quests q ON q.id = f.quest_id
             LEFT JOIN users u ON u.id = q.buyer_id
             WHERE quests_fts MATCH ? AND q.status = 'open'
             LIMIT 25`,
          )
          .bind(ftsMatchExpr)
          .all<QuestRecord>()
          .catch((err) => {
            console.error("FTS5 query failed:", err);
            return { results: [] as QuestRecord[] };
          })
      : Promise.resolve({ results: [] as QuestRecord[] });

    const vectorPromise = (async () => {
      try {
        const emb = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
          text: [q],
        });
        const vec = "data" in emb && emb.data?.[0] ? emb.data[0] : null;
        if (!vec || vec.length !== 384) return [];
        const matches = await env.VECTORIZE.query(vec, {
          topK: 20,
          returnMetadata: "none",
        });
        return matches.matches || [];
      } catch (err) {
        console.error("Vectorize semantic search failed:", err);
        return [];
      }
    })();

    const [ftsResult, vectorMatches] = await Promise.all([
      ftsPromise,
      vectorPromise,
    ]);

    const ftsRows = ftsResult.results || [];
    searchDiagnostics.ftsCount = ftsRows.length;
    searchDiagnostics.vectorCount = vectorMatches.length;

    const mergedMap = new Map<string, QuestRecord>();
    for (const row of ftsRows) {
      mergedMap.set(row.id, {
        ...row,
        match_source: "fts",
      });
    }

    const scoreMap = new Map<string, number>();
    const missingVectorIds: string[] = [];

    for (const m of vectorMatches) {
      if (m.score < 0.45) continue;
      scoreMap.set(m.id, m.score);
      const existing = mergedMap.get(m.id);
      if (existing) {
        existing.match_source = "hybrid";
        existing.similarity_score = m.score;
      } else {
        missingVectorIds.push(m.id);
      }
    }

    if (missingVectorIds.length > 0) {
      const placeholders = missingVectorIds.map(() => "?").join(", ");
      const vecDbRes = await env.quest_db
        .prepare(
          `SELECT q.*, u.display_name AS buyer_name,
            (SELECT COUNT(*) FROM offers o WHERE o.quest_id = q.id) AS offer_count
           FROM quests q
           LEFT JOIN users u ON u.id = q.buyer_id
           WHERE q.id IN (${placeholders}) AND q.status = 'open'`,
        )
        .bind(...missingVectorIds)
        .all<QuestRecord>();

      for (const row of vecDbRes.results || []) {
        mergedMap.set(row.id, {
          ...row,
          match_source: "semantic",
          similarity_score: scoreMap.get(row.id),
        });
      }
    }

    quests = Array.from(mergedMap.values()).filter((item) => {
      if (category && item.category !== category) return false;
      if (strictness && item.strictness !== strictness) return false;
      return true;
    });

    quests.sort((a, b) => {
      const rank = (src?: string) =>
        src === "hybrid" ? 3 : src === "fts" ? 2 : 1;
      const diff = rank(b.match_source) - rank(a.match_source);
      if (diff !== 0) return diff;
      return (b.similarity_score || 0) - (a.similarity_score || 0);
    });
  } else {
    const clauses: string[] = ["q.status = 'open'"];
    const bindings: unknown[] = [];

    if (category) {
      clauses.push("q.category = ?");
      bindings.push(category);
    }
    if (strictness) {
      clauses.push("q.strictness = ?");
      bindings.push(strictness);
    }

    const sql = `
      SELECT q.*, u.display_name AS buyer_name,
        (SELECT COUNT(*) FROM offers o WHERE o.quest_id = q.id) AS offer_count
      FROM quests q
      LEFT JOIN users u ON u.id = q.buyer_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY q.created_at DESC
      LIMIT 50
    `;

    const res = await env.quest_db
      .prepare(sql)
      .bind(...bindings)
      .all<QuestRecord>();
    quests = res.results || [];
  }

  return {
    quests,
    filters: { q, category, strictness },
    searchDiagnostics,
  };
}

export default function QuestsBoardPage({ loaderData }: Route.ComponentProps) {
  const { quests, filters, searchDiagnostics } = loaderData;
  const [searchParams] = useSearchParams();

  const totalVisibleBountyCents = quests.reduce(
    (sum, item) => sum + (item.max_budget_cents || 0),
    0,
  );

  const buildCategoryUrl = (cat: string) => {
    const next = new URLSearchParams();
    if (filters.q) next.set("q", filters.q);
    if (cat) next.set("category", cat);
    if (filters.strictness) next.set("strictness", String(filters.strictness));
    const qs = next.toString();
    return qs ? `/quests?${qs}` : "/quests";
  };

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      {/* Header & Board Summary */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6 border-b border-stone-200/80 dark:border-stone-800/80">
        <div>
          <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400 block mb-1.5">
            Collector Bounty Board
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
            Active Buying Quests
          </h1>
          <p className="mt-1.5 text-stone-600 dark:text-stone-400 text-sm max-w-2xl">
            Match your personal collection or shop inventory against committed
            buyer requests. Search by model number, ISBN, brand, or aesthetic
            description.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 self-start lg:self-auto">
          <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 py-2 text-xs">
            <span className="uppercase text-[10px] text-stone-400 block font-medium">
              Available Buyer Budgets
            </span>
            <span className="font-bold text-sm text-amber-600 dark:text-amber-400 tabular-nums">
              {formatCents(totalVisibleBountyCents)}{" "}
              <span className="text-stone-400 font-normal">
                ({quests.length} open)
              </span>
            </span>
          </div>
          <Link
            to="/quests/new"
            className="inline-flex items-center justify-center px-4 py-3 rounded-xl bg-stone-900 text-white dark:bg-amber-500 dark:text-stone-950 dark:hover:bg-amber-400 text-xs sm:text-sm font-semibold hover:bg-amber-600 transition-colors shadow-xs"
          >
            + Post a Buying Quest
          </Link>
        </div>
      </div>

      {/* Search & Filter Console */}
      <Form method="get" className="dossier-card p-5 sm:p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6">
            <label
              htmlFor="q"
              className="block text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-1.5"
            >
              Search by Model, ISBN, Brand, or Style
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={filters.q}
              placeholder="e.g., SARB033, first edition, or '70s blue dial field watch..."
              className="w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-4 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
            />
          </div>

          <div className="md:col-span-3">
            <label
              htmlFor="category-select"
              className="block text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-1.5"
            >
              Category
            </label>
            <select
              id="category-select"
              name="category"
              defaultValue={filters.category}
              aria-label="Filter by category"
              className="w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
            >
              <option value="">All Categories</option>
              {QUEST_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="strictness-select"
              className="block text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-1.5"
            >
              Match Preference
            </label>
            <select
              id="strictness-select"
              name="strictness"
              defaultValue={filters.strictness || ""}
              aria-label="Filter by strictness"
              className="w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
            >
              <option value="">Any Match Type</option>
              <option value="1">Exact Match Only</option>
              <option value="2">Close Alternatives</option>
              <option value="3">Open to Curated</option>
            </select>
          </div>

          <div className="md:col-span-1 flex items-end">
            <button
              type="submit"
              className="w-full rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm px-4 py-2.5 transition-colors cursor-pointer"
            >
              Search
            </button>
          </div>
        </div>

        {/* Quick Category Strip */}
        <div className="pt-2 border-t border-stone-100 dark:border-stone-800/80 flex items-center gap-1.5 overflow-x-auto pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mr-1 shrink-0">
            Categories:
          </span>
          <Link
            to={buildCategoryUrl("")}
            className={`shrink-0 text-xs px-3 py-1 rounded-lg transition-colors ${
              !filters.category
                ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-950 font-semibold"
                : "text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
            }`}
          >
            All
          </Link>
          {QUEST_CATEGORIES.map((cat) => {
            const active = filters.category === cat;
            return (
              <Link
                key={cat}
                to={buildCategoryUrl(cat)}
                className={`shrink-0 text-xs px-3 py-1 rounded-lg transition-colors ${
                  active
                    ? "bg-amber-600 text-white font-semibold"
                    : "text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
                }`}
              >
                {cat}
              </Link>
            );
          })}
        </div>

        {(filters.q || filters.category || filters.strictness) && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-stone-200/70 dark:border-stone-800 text-xs">
            <div className="flex flex-wrap items-center gap-2 text-stone-600 dark:text-stone-300">
              {searchDiagnostics.mode === "hybrid" ? (
                <span>
                  Found <strong>{quests.length}</strong> matching Quest
                  {quests.length === 1 ? "" : "s"} for{" "}
                  <strong>&ldquo;{filters.q}&rdquo;</strong>
                </span>
              ) : (
                <span>
                  Showing <strong>{quests.length}</strong> filtered Quest
                  {quests.length === 1 ? "" : "s"}
                </span>
              )}
              {filters.category && (
                <span className="px-2.5 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 font-medium">
                  {filters.category}
                </span>
              )}
              {filters.strictness && (
                <span className="px-2.5 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 font-medium">
                  {STRICTNESS_LEVELS[filters.strictness]?.shortLabel}
                </span>
              )}
            </div>
            <Link
              to="/quests"
              className="text-amber-700 dark:text-amber-400 hover:underline font-semibold"
            >
              ✕ Clear filters
            </Link>
          </div>
        )}
      </Form>

      {/* Results Grid */}
      {quests.length === 0 ? (
        <div className="dossier-card border-dashed p-12 text-center">
          <span className="text-xs font-semibold uppercase tracking-widest text-stone-400">
            No Matching Requests
          </span>
          <h2 className="mt-2 text-xl font-bold text-stone-900 dark:text-stone-100">
            {searchParams.toString()
              ? "No open Quests matched your search"
              : "No active Quests posted yet"}
          </h2>
          <p className="mt-1.5 text-sm text-stone-600 dark:text-stone-400 max-w-md mx-auto">
            Looking for a rare or discontinued piece yourself? Post a Quest and
            let verified collectors and shops bring offers to you.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Link
              to="/quests/new"
              className="px-5 py-2.5 rounded-xl bg-stone-900 text-white dark:bg-amber-500 dark:text-stone-950 text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              + Post a Quest
            </Link>
            {searchParams.toString() && (
              <Link
                to="/quests"
                className="px-5 py-2.5 rounded-xl border border-stone-300 dark:border-stone-700 text-sm font-medium hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
              >
                Reset Search
              </Link>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {quests.map((quest) => {
            const strictInfo =
              STRICTNESS_LEVELS[quest.strictness] || STRICTNESS_LEVELS[1];
            const estSellerNetCents = Math.round(quest.max_budget_cents * 0.9);

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
                          Collector Bounty
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
                    {quest.match_source && (
                      <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-stone-950/90 text-amber-300 border border-amber-500/30">
                        {quest.match_source === "hybrid"
                          ? "Top Match"
                          : quest.match_source === "fts"
                            ? "Exact Keyword Match"
                            : "Similar Style"}
                      </span>
                    )}
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

                    <h2 className="mt-1.5 font-bold text-base text-stone-900 dark:text-stone-100 group-hover:text-amber-700 dark:group-hover:text-amber-400 transition-colors line-clamp-2 leading-snug">
                      {quest.title}
                    </h2>

                    {(quest.brand ||
                      quest.model_or_isbn ||
                      quest.size_or_spec) && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {quest.brand && (
                          <span className="text-xs px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 font-medium">
                            {quest.brand}
                          </span>
                        )}
                        {quest.model_or_isbn && (
                          <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
                            {quest.model_or_isbn}
                          </span>
                        )}
                        {quest.size_or_spec && (
                          <span className="text-xs px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
                            {quest.size_or_spec}
                          </span>
                        )}
                      </div>
                    )}

                    <p className="mt-2.5 text-xs text-stone-600 dark:text-stone-400 line-clamp-2 leading-relaxed">
                      {quest.description}
                    </p>
                  </div>

                  <div className="mt-4 pt-3.5 border-t border-stone-100 dark:border-stone-800/80 space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-stone-400">
                      <span>Est. Seller Payout (90%)</span>
                      <span className="text-stone-700 dark:text-stone-300 font-semibold tabular-nums">
                        {formatCents(estSellerNetCents)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-stone-500 dark:text-stone-400 truncate">
                        By {quest.buyer_name || "Collector"}
                      </span>
                      <span className="font-semibold text-amber-700 dark:text-amber-400 shrink-0 group-hover:translate-x-0.5 transition-transform">
                        {quest.offer_count || 0} offer
                        {quest.offer_count === 1 ? "" : "s"} →
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
