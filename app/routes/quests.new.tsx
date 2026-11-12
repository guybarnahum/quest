import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/quests.new";
import {
  ensureDemoUsers,
  formatCents,
  QUEST_CATEGORIES,
  STRICTNESS_LEVELS,
  type StrictnessLevel,
} from "../lib/quest-types";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Post a Buying Quest · Quest Reverse Marketplace" },
    {
      name: "description",
      content:
        "Post a bounty for rare, out-of-print, vintage, or discontinued items.",
    },
  ];
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();

  const title = String(formData.get("title") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const category = String(formData.get("category") || "").trim();
  const brand = String(formData.get("brand") || "").trim() || null;
  const modelOrIsbn =
    String(formData.get("model_or_isbn") || "").trim() || null;
  const sizeOrSpec = String(formData.get("size_or_spec") || "").trim() || null;
  const strictnessRaw = Number(formData.get("strictness") || 1);
  const maxBudgetDollars = Number(formData.get("max_budget") || 0);
  const referenceImage = formData.get("reference_image");

  if (!title || title.length < 5) {
    return {
      error: "Please provide a descriptive quest title (at least 5 characters).",
    };
  }
  if (!description || description.length < 15) {
    return {
      error:
        "Please provide a detailed description of condition, provenance, or specs (at least 15 characters).",
    };
  }
  if (!category) {
    return { error: "Please select a category." };
  }
  if (![1, 2, 3].includes(strictnessRaw)) {
    return { error: "Invalid match preference." };
  }
  if (Number.isNaN(maxBudgetDollars) || maxBudgetDollars < 5) {
    return { error: "Maximum budget must be at least $5." };
  }

  const maxBudgetCents = Math.round(maxBudgetDollars * 100);
  const questId = `quest_${crypto.randomUUID().slice(0, 12)}`;

  await ensureDemoUsers(env.quest_db);

  let referenceImageKey: string | null = null;
  if (referenceImage instanceof File && referenceImage.size > 0) {
    if (referenceImage.size > 10 * 1024 * 1024) {
      return { error: "Reference image must be 10MB or smaller." };
    }
    const safeFilename = referenceImage.name
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 80);
    referenceImageKey = `quests/${questId}/${Date.now()}-${safeFilename}`;
    await env.quest_assets.put(referenceImageKey, referenceImage.stream(), {
      httpMetadata: {
        contentType: referenceImage.type || "application/octet-stream",
      },
    });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  await env.quest_db
    .prepare(
      `INSERT INTO quests (
        id, buyer_id, title, description, category, brand, model_or_isbn,
        size_or_spec, strictness, max_budget_cents, status, reference_image_key, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .bind(
      questId,
      "user_demo_1",
      title,
      description,
      category,
      brand,
      modelOrIsbn,
      sizeOrSpec,
      strictnessRaw,
      maxBudgetCents,
      referenceImageKey,
      expiresAt,
    )
    .run();

  const semanticPassage = [
    `Title: ${title}`,
    `Category: ${category}`,
    brand ? `Brand: ${brand}` : "",
    modelOrIsbn ? `Model/ISBN: ${modelOrIsbn}` : "",
    sizeOrSpec ? `Size/Spec: ${sizeOrSpec}` : "",
    `Details: ${description}`,
  ]
    .filter(Boolean)
    .join(" | ");

  try {
    const embeddingResponse = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
      text: [semanticPassage],
    });
    const vector =
      "data" in embeddingResponse && embeddingResponse.data?.[0]
        ? embeddingResponse.data[0]
        : null;

    if (vector && vector.length === 384) {
      await env.VECTORIZE.upsert([
        {
          id: questId,
          values: vector,
          metadata: {
            category,
            strictness: strictnessRaw,
            status: "open",
          },
        },
      ]);
    }
  } catch (err) {
    console.error("Failed to generate or upsert quest embedding:", err);
  }

  return redirect(`/quests/${questId}`);
}

export default function NewQuestPage({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(QUEST_CATEGORIES[0]);
  const [maxBudget, setMaxBudget] = useState<string>("450");
  const [brand, setBrand] = useState("");
  const [modelOrIsbn, setModelOrIsbn] = useState("");
  const [sizeOrSpec, setSizeOrSpec] = useState("");
  const [strictness, setStrictness] = useState<StrictnessLevel>(1);
  const [description, setDescription] = useState("");
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  const parsedBudgetCents = Math.max(
    0,
    Math.round((Number(maxBudget) || 0) * 100),
  );
  const buyerEscrowFeeCents = Math.round(parsedBudgetCents * 0.025);
  const sellerNetCents = Math.round(parsedBudgetCents * 0.9);
  const activeStrictInfo = STRICTNESS_LEVELS[strictness] || STRICTNESS_LEVELS[1];

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8 pb-6 border-b border-stone-200/80 dark:border-stone-800/80 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <Link
            to="/quests"
            className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500 hover:text-stone-900 dark:hover:text-white transition-colors"
          >
            <span>←</span>
            <span>Back to Quest Board</span>
          </Link>
          <h1 className="mt-2 text-3xl sm:text-4xl font-extrabold tracking-tight">
            Post a Buying Quest
          </h1>
          <p className="mt-1.5 text-sm text-stone-600 dark:text-stone-400 max-w-2xl">
            Describe the rare, discontinued, or vintage piece you are hunting
            for and set your maximum budget. Verified collectors and dealers
            with matching inventory will come to you with offers.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs text-stone-500">
          <span className="px-2.5 py-1 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 font-medium">
            Active for 30 Days
          </span>
          <span className="px-2.5 py-1 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 font-medium">
            Free to Post
          </span>
        </div>
      </div>

      {actionData?.error && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/40 p-4 text-sm text-rose-800 dark:text-rose-200 flex items-center gap-3">
          <span className="font-bold text-xs px-2 py-0.5 rounded bg-rose-200/70 dark:bg-rose-900 text-rose-900 dark:text-rose-100">
            Notice
          </span>
          <span>{actionData.error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <Form
          method="post"
          encType="multipart/form-data"
          className="lg:col-span-7 space-y-8 dossier-card p-6 sm:p-8"
        >
          {/* Section 01 */}
          <div className="space-y-5">
            <div className="flex items-center justify-between pb-2 border-b border-stone-100 dark:border-stone-800">
              <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                1. What You&apos;re Looking For &amp; Budget
              </span>
              <span className="text-[11px] text-stone-400">* Required</span>
            </div>

            <div>
              <label
                htmlFor="title"
                className="block text-sm font-semibold text-stone-900 dark:text-stone-100"
              >
                Quest Title *
              </label>
              <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                Include the brand, model or edition, colorway, and key details.
              </p>
              <input
                id="title"
                name="title"
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Seiko SARB033 Mechanical Spirit Black Dial Full Kit"
                className="mt-2 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50/70 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:bg-white dark:focus:bg-stone-900 focus:outline-none transition-colors"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="category"
                  className="block text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  Category *
                </label>
                <select
                  id="category"
                  name="category"
                  required
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50/70 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:outline-none"
                >
                  {QUEST_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="max_budget"
                  className="block text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  Maximum Budget (USD) *
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-stone-400 text-sm">
                    $
                  </span>
                  <input
                    id="max_budget"
                    name="max_budget"
                    type="number"
                    min="5"
                    step="1"
                    required
                    value={maxBudget}
                    onChange={(e) => setMaxBudget(e.target.value)}
                    placeholder="450"
                    className="w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50/70 dark:bg-stone-950 pl-8 pr-3.5 py-2.5 text-sm font-semibold tabular-nums focus:border-amber-600 focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 02 */}
          <div className="space-y-4">
            <div className="pb-2 border-b border-stone-100 dark:border-stone-800">
              <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                2. Item Specifications (Optional)
              </span>
              <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                Helps sellers with matching reference numbers, ISBNs, or sizes
                find your request faster.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label
                  htmlFor="brand"
                  className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                >
                  Brand / Maker
                </label>
                <input
                  id="brand"
                  name="brand"
                  type="text"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="e.g., Seiko, Taschen"
                  className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50/70 dark:bg-stone-950 px-3.5 py-2 text-sm focus:border-amber-600 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="model_or_isbn"
                  className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                >
                  Model / Reference / ISBN
                </label>
                <input
                  id="model_or_isbn"
                  name="model_or_isbn"
                  type="text"
                  value={modelOrIsbn}
                  onChange={(e) => setModelOrIsbn(e.target.value)}
                  placeholder="e.g., SARB033"
                  className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50/70 dark:bg-stone-950 px-3.5 py-2 text-sm font-mono focus:border-amber-600 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="size_or_spec"
                  className="block text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300"
                >
                  Size / Edition / Spec
                </label>
                <input
                  id="size_or_spec"
                  name="size_or_spec"
                  type="text"
                  value={sizeOrSpec}
                  onChange={(e) => setSizeOrSpec(e.target.value)}
                  placeholder="e.g., 38mm / 1st Ed"
                  className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50/70 dark:bg-stone-950 px-3.5 py-2 text-sm focus:border-amber-600 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section 03 */}
          <fieldset className="space-y-3">
            <div className="pb-2 border-b border-stone-100 dark:border-stone-800">
              <legend className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                3. Match Preference *
              </legend>
              <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                Choose whether sellers can offer close alternatives or only the
                exact piece you specify.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 pt-1">
              {([1, 2, 3] as const).map((lvl) => {
                const info = STRICTNESS_LEVELS[lvl];
                return (
                  <label
                    key={lvl}
                    className="relative flex cursor-pointer items-start gap-3.5 rounded-xl border border-stone-200 dark:border-stone-800 p-4 hover:border-amber-500/70 transition-colors has-[:checked]:border-amber-600 has-[:checked]:bg-amber-50/40 dark:has-[:checked]:bg-amber-950/20"
                  >
                    <input
                      type="radio"
                      name="strictness"
                      value={lvl}
                      checked={strictness === lvl}
                      onChange={() => setStrictness(lvl)}
                      className="mt-1 h-4 w-4 accent-amber-600"
                    />
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-stone-900 dark:text-stone-100">
                          {info.name}
                        </span>
                        <span
                          className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${info.badgeClass}`}
                        >
                          {info.shortLabel}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-stone-600 dark:text-stone-400 leading-relaxed">
                        {info.description}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* Section 04 */}
          <div className="space-y-5">
            <div className="pb-2 border-b border-stone-100 dark:border-stone-800">
              <span className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                4. Condition Details &amp; Reference Photo
              </span>
            </div>

            <div>
              <label
                htmlFor="description"
                className="block text-sm font-semibold text-stone-900 dark:text-stone-100"
              >
                Condition Requirements &amp; Notes *
              </label>
              <textarea
                id="description"
                name="description"
                rows={4}
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe acceptable condition grades (e.g., unpolished case, original bracelet, dust jacket intact), included accessories, or provenance details..."
                className="mt-1.5 w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50/70 dark:bg-stone-950 px-3.5 py-2.5 text-sm focus:border-amber-600 focus:bg-white dark:focus:bg-stone-900 focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="reference_image"
                className="block text-sm font-semibold text-stone-900 dark:text-stone-100"
              >
                Reference Photo (Optional)
              </label>
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                Upload a catalog photo, archival image, or cover scan (up to
                10MB) to help sellers confirm they have the right item.
              </p>
              <div className="mt-2 rounded-xl border border-dashed border-stone-300 dark:border-stone-700 bg-stone-50/60 dark:bg-stone-950/60 p-4">
                <input
                  id="reference_image"
                  name="reference_image"
                  type="file"
                  accept="image/*"
                  onChange={(e) =>
                    setSelectedFileName(e.target.files?.[0]?.name || null)
                  }
                  className="block w-full text-xs text-stone-600 dark:text-stone-400 file:mr-4 file:rounded-lg file:border-0 file:bg-stone-900 file:text-white dark:file:bg-stone-800 dark:file:text-stone-200 file:px-3.5 file:py-2 file:text-xs file:font-semibold hover:file:bg-amber-600 file:transition-colors file:cursor-pointer"
                />
                {selectedFileName && (
                  <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    ✓ Selected photo: {selectedFileName}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="pt-4 flex items-center justify-end gap-3 border-t border-stone-200 dark:border-stone-800">
            <Link
              to="/quests"
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-3 rounded-xl text-sm font-semibold bg-stone-900 text-white hover:bg-amber-600 dark:bg-amber-500 dark:text-stone-950 dark:hover:bg-amber-400 disabled:opacity-50 transition-colors shadow-xs cursor-pointer"
            >
              {isSubmitting ? "Publishing Quest..." : "Publish Buying Quest →"}
            </button>
          </div>
        </Form>

        {/* Sticky Right Column: Live Preview & Escrow Breakdown */}
        <aside className="lg:col-span-5 sticky top-24 space-y-6">
          <div className="dossier-card p-6 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-stone-100 dark:border-stone-800">
              <span className="text-xs font-semibold uppercase tracking-widest text-stone-400">
                Live Request Preview
              </span>
              <span
                className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${activeStrictInfo.badgeClass}`}
              >
                {activeStrictInfo.shortLabel}
              </span>
            </div>

            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-xs font-medium text-stone-500">
                    {category}
                  </span>
                  <h2 className="mt-0.5 font-bold text-lg text-stone-900 dark:text-stone-100 leading-snug">
                    {title.trim() || "Your Quest Title..."}
                  </h2>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-[10px] uppercase text-stone-400 block font-medium">
                    Max Budget
                  </span>
                  <span className="text-2xl font-extrabold text-amber-600 dark:text-amber-400 tabular-nums">
                    {formatCents(parsedBudgetCents)}
                  </span>
                </div>
              </div>

              {(brand || modelOrIsbn || sizeOrSpec) && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {brand && (
                    <span className="text-xs px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 font-medium">
                      {brand}
                    </span>
                  )}
                  {modelOrIsbn && (
                    <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
                      {modelOrIsbn}
                    </span>
                  )}
                  {sizeOrSpec && (
                    <span className="text-xs px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
                      {sizeOrSpec}
                    </span>
                  )}
                </div>
              )}

              <p className="text-xs text-stone-600 dark:text-stone-400 leading-relaxed line-clamp-3">
                {description.trim() ||
                  "Your condition requirements, included accessories, and provenance notes will appear here."}
              </p>
            </div>

            <div className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800 p-4 space-y-2.5 text-xs">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 block">
                Estimated Breakdown (At Max Budget)
              </span>
              <div className="flex items-center justify-between text-stone-600 dark:text-stone-300">
                <span>Maximum Item Price</span>
                <span className="font-semibold tabular-nums">
                  {formatCents(parsedBudgetCents)}
                </span>
              </div>
              <div className="flex items-center justify-between text-stone-600 dark:text-stone-300">
                <span>Buyer Escrow Protection (2.5%)</span>
                <span className="tabular-nums">
                  +{formatCents(buyerEscrowFeeCents)}
                </span>
              </div>
              <div className="flex items-center justify-between text-stone-500 pt-2 border-t border-stone-200/70 dark:border-stone-800">
                <span>Seller Net Payout (after 10% commission)</span>
                <span className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                  {formatCents(sellerNetCents)}
                </span>
              </div>
            </div>
          </div>

          <div className="dossier-card p-6 space-y-3 text-xs text-stone-600 dark:text-stone-400">
            <h3 className="font-semibold uppercase tracking-wider text-stone-900 dark:text-stone-100">
              Buyer Protection Guarantee
            </h3>
            <p className="leading-relaxed">
              • <strong>No charge until you accept an offer:</strong> Posting a
              Quest is free. You only fund escrow after reviewing a
              seller&apos;s photos and accepting their offer.
            </p>
            <p className="leading-relaxed">
              • <strong>5-Business-Day Shipping Guarantee:</strong> If the
              seller does not ship using the prepaid label within 5 business
              days, your payment is automatically refunded.
            </p>
            <p className="leading-relaxed">
              • <strong>72-Hour Inspection Window:</strong> After delivery, you
              have 72 hours to inspect the item and confirm it matches the
              description before funds are released.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
