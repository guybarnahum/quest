export const QUEST_CATEGORIES = [
  "Watches & Horology",
  "Books & Rare Print",
  "Archive & Vintage Apparel",
  "Vinyl & Audio Gear",
  "Cameras & Optics",
  "Design & Collectibles",
  "Other",
] as const;

export const STRICTNESS_LEVELS = {
  1: {
    level: 1 as const,
    name: "Exact Match Only",
    shortLabel: "Exact Match",
    badgeClass:
      "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800/70",
    description:
      "Only the exact brand, model or edition, size, and specification requested. Substitutes are not accepted.",
    allowedMatchTypes: ["exact"] as const,
  },
  2: {
    level: 2 as const,
    name: "Close Alternatives Welcome",
    shortLabel: "Close Alternatives",
    badgeClass:
      "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800/70",
    description:
      "Exact item preferred, or a close variant such as an adjacent size, alternate colorway, or later edition.",
    allowedMatchTypes: ["exact", "alternative"] as const,
  },
  3: {
    level: 3 as const,
    name: "Open to Curated Finds",
    shortLabel: "Open to Curated",
    badgeClass:
      "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800/70",
    description:
      "Open to pieces that capture the same era, craftsmanship, or aesthetic brief—including rare discoveries.",
    allowedMatchTypes: ["exact", "alternative", "curated"] as const,
  },
} as const;

export type StrictnessLevel = 1 | 2 | 3;
export type OfferMatchType = "exact" | "alternative" | "curated";

export interface QuestRecord {
  id: string;
  buyer_id: string;
  buyer_name?: string;
  title: string;
  description: string;
  category: string;
  brand: string | null;
  model_or_isbn: string | null;
  size_or_spec: string | null;
  strictness: StrictnessLevel;
  max_budget_cents: number;
  status: "open" | "accepted" | "fulfilled" | "cancelled" | "expired";
  reference_image_key: string | null;
  created_at: number;
  expires_at: number | null;
  offer_count?: number;
  similarity_score?: number;
  match_source?: "fts" | "semantic" | "hybrid";
}

export interface OfferRecord {
  id: string;
  quest_id: string;
  seller_id: string;
  seller_name?: string;
  match_type: OfferMatchType;
  item_price_cents: number;
  shipping_estimate_cents: number;
  condition_grade: string;
  notes: string;
  proof_image_keys: string;
  status: "pending" | "accepted" | "rejected" | "withdrawn";
  created_at: number;
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function formatRelativeTime(unixSeconds: number): string {
  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diffSeconds < 60) return "just now";
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function isMatchTypeAllowed(
  strictness: number,
  matchType: string,
): matchType is OfferMatchType {
  if (strictness === 1) {
    return matchType === "exact";
  }
  if (strictness === 2) {
    return matchType === "exact" || matchType === "alternative";
  }
  if (strictness === 3) {
    return (
      matchType === "exact" ||
      matchType === "alternative" ||
      matchType === "curated"
    );
  }
  return false;
}

export async function ensureDemoUsers(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name) VALUES
        ('user_demo_1', 'demo@quest.market', 'Demo Collector'),
        ('user_seller_1', 'seller@quest.market', 'Vault Vintage Studio')`,
    )
    .run();
}
