import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
  },
];

function TopNav() {
  const location = useLocation();
  const pathname = location.pathname;

  const isActive = (target: string) => {
    if (target === "/") return pathname === "/";
    if (target === "/quests") {
      return (
        pathname === "/quests" ||
        (pathname.startsWith("/quests/") && pathname !== "/quests/new")
      );
    }
    return pathname.startsWith(target);
  };

  return (
    <header className="sticky top-0 z-40 border-b border-stone-200/80 dark:border-stone-800/80 bg-[#FAF8F5]/90 dark:bg-[#0C0B0A]/90 backdrop-blur-md">
      <div className="border-b border-stone-200/60 dark:border-stone-800/60 bg-stone-900 text-stone-300 dark:bg-stone-950 text-[11px] font-medium">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-8 flex items-center justify-between gap-4 overflow-x-auto whitespace-nowrap">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-amber-400 font-semibold">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Escrow-Protected Collector Exchange
            </span>
            <span className="text-stone-600">·</span>
            <span>72-Hour Post-Delivery Inspection Window</span>
            <span className="hidden md:inline text-stone-600">·</span>
            <span className="hidden md:inline text-stone-400">
              Prepaid Address-Protected Shipping
            </span>
          </div>
          <div className="hidden sm:flex items-center gap-4 text-stone-400">
            <Link
              to="/sellers/reputation"
              className="hover:text-amber-300 transition-colors"
            >
              Seller Verification ↗
            </Link>
            <span className="text-stone-700">|</span>
            <span className="text-stone-400">USD ($)</span>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <div className="flex items-center gap-8">
          <Link to="/" className="flex items-center gap-3 group">
            <span className="relative inline-flex items-center justify-center w-9 h-9 rounded-xl bg-stone-900 dark:bg-amber-500 text-amber-400 dark:text-stone-950 font-display text-2xl italic leading-none shadow-xs group-hover:bg-amber-600 group-hover:text-white transition-colors">
              Q
            </span>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight text-stone-900 dark:text-stone-100 leading-none">
                  Quest
                </span>
                <span className="hidden sm:inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-500/20">
                  Reverse Marketplace
                </span>
              </div>
              <span className="text-[11px] text-stone-500 dark:text-stone-400 hidden sm:block mt-0.5">
                Rare, Vintage &amp; Out-of-Print Goods
              </span>
            </div>
          </Link>

          <nav
            aria-label="Main Navigation"
            className="hidden md:flex items-center gap-1 text-sm font-medium"
          >
            <Link
              to="/quests"
              className={`px-3.5 py-2 rounded-lg transition-colors ${
                isActive("/quests")
                  ? "bg-stone-200/70 dark:bg-stone-800/80 text-stone-900 dark:text-white font-semibold"
                  : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-stone-900"
              }`}
            >
              Browse Quests
            </Link>
            <Link
              to="/quests/new"
              className={`px-3.5 py-2 rounded-lg transition-colors ${
                isActive("/quests/new")
                  ? "bg-stone-200/70 dark:bg-stone-800/80 text-stone-900 dark:text-white font-semibold"
                  : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-stone-900"
              }`}
            >
              Post a Quest
            </Link>
            <Link
              to="/sellers/reputation"
              className={`px-3.5 py-2 rounded-lg transition-colors ${
                isActive("/sellers/reputation")
                  ? "bg-stone-200/70 dark:bg-stone-800/80 text-stone-900 dark:text-white font-semibold"
                  : "text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-stone-900"
              }`}
            >
              Seller Trust
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-2.5">
          <Link
            to="/sellers/reputation"
            className="hidden lg:inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl border border-stone-300/80 dark:border-stone-800 bg-white/80 dark:bg-stone-900/80 text-stone-700 dark:text-stone-300 hover:border-emerald-500/60 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Verify Storefront
          </Link>
          <Link
            to="/quests"
            className="text-xs sm:text-sm font-medium px-3 py-2 rounded-xl text-stone-700 dark:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-900 transition-colors"
          >
            Explore Bounties
          </Link>
          <Link
            to="/quests/new"
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold px-4 py-2.5 rounded-xl bg-stone-900 text-white hover:bg-amber-600 dark:bg-amber-500 dark:text-stone-950 dark:hover:bg-amber-400 transition-colors shadow-xs"
          >
            <span>+ New Quest</span>
          </Link>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-stone-200/80 dark:border-stone-800/80 bg-white/60 dark:bg-stone-950/60 mt-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 pb-10 border-b border-stone-200/70 dark:border-stone-800/70">
          <div className="md:col-span-5 space-y-3">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-stone-900 dark:bg-amber-500 text-amber-400 dark:text-stone-950 font-display text-xl italic leading-none">
                Q
              </span>
              <span className="font-bold text-base tracking-tight">
                Quest Collector Exchange
              </span>
            </div>
            <p className="text-xs text-stone-600 dark:text-stone-400 leading-relaxed max-w-sm">
              A buyer-first marketplace for out-of-print editions, discontinued
              timepieces, archival garments, and rare optics. Post what you are
              searching for and let verified collectors come to you.
            </p>
            <div className="flex flex-wrap gap-2 pt-1 text-[11px] text-stone-500">
              <span className="px-2.5 py-0.5 rounded-md bg-stone-100 dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
                2.5% Buyer Protection
              </span>
              <span className="px-2.5 py-0.5 rounded-md bg-stone-100 dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
                10% Seller Commission
              </span>
              <span className="px-2.5 py-0.5 rounded-md bg-stone-100 dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
                5-Day Shipping Guarantee
              </span>
            </div>
          </div>

          <div className="md:col-span-3 space-y-2.5 text-xs">
            <h3 className="uppercase tracking-wider text-stone-400 font-semibold">
              Marketplace
            </h3>
            <ul className="space-y-2 text-stone-600 dark:text-stone-400">
              <li>
                <Link
                  to="/quests"
                  className="hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                >
                  Browse Active Quests
                </Link>
              </li>
              <li>
                <Link
                  to="/quests/new"
                  className="hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                >
                  Post a Buying Quest
                </Link>
              </li>
              <li>
                <Link
                  to="/sellers/reputation"
                  className="hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                >
                  Verify Your Storefront
                </Link>
              </li>
            </ul>
          </div>

          <div className="md:col-span-4 space-y-2.5 text-xs">
            <h3 className="uppercase tracking-wider text-stone-400 font-semibold">
              Escrow &amp; Authenticity Guarantee
            </h3>
            <p className="text-stone-600 dark:text-stone-400 leading-relaxed">
              Every accepted offer locks payment in escrow before the seller
              ships. Sellers receive a prepaid, address-protected shipping
              label, and buyers get a full 72 hours after delivery to inspect
              condition and authenticity before funds are released.
            </p>
          </div>
        </div>

        <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-stone-500">
          <p>
            © {new Date().getFullYear()} Quest Marketplace. Every transaction
            protected by 72-hour inspection escrow.
          </p>
          <div className="flex items-center gap-4 text-[11px]">
            <span>Verified Storefronts</span>
            <span>·</span>
            <span>Prepaid Insured Labels</span>
            <span>·</span>
            <span>72-Hour Buyer Inspection</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen flex flex-col bg-[#FAF8F5] text-stone-900 dark:bg-[#0C0B0A] dark:text-stone-100 antialiased">
        <TopNav />
        <div className="flex-1">{children}</div>
        <Footer />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let status = "Error";
  let title = "Something went wrong";
  let details = "Please return to the Quest Board or try your action again.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    status = String(error.status);
    title =
      error.status === 404
        ? "Page Not Found"
        : `Unable to Complete Request (${error.status})`;
    details =
      error.status === 404
        ? "The Quest or page you are looking for does not exist or has been removed."
        : error.statusText || String(error.data || details);
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-20">
      <div className="dossier-card p-8 sm:p-12 text-center space-y-5">
        <span className="inline-block text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60">
          {status}
        </span>
        <h1 className="font-display text-4xl sm:text-5xl text-stone-900 dark:text-stone-100">
          {title}
        </h1>
        <p className="text-sm text-stone-600 dark:text-stone-400 max-w-md mx-auto leading-relaxed">
          {details}
        </p>
        <div className="pt-2 flex items-center justify-center gap-3">
          <Link
            to="/quests"
            className="px-5 py-2.5 rounded-xl bg-stone-900 text-white dark:bg-amber-500 dark:text-stone-950 text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Browse Quests
          </Link>
          <Link
            to="/"
            className="px-5 py-2.5 rounded-xl border border-stone-300 dark:border-stone-700 text-sm font-medium hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
          >
            Return Home
          </Link>
        </div>
        {stack && (
          <pre className="mt-6 text-left text-xs font-mono bg-stone-950 text-stone-200 p-4 rounded-xl overflow-x-auto border border-stone-800">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
  );
}
