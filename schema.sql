PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_connect_account_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS seller_reputations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ebay', 'etsy', 'grailed', 'poshmark', 'discogs')),
  external_handle TEXT NOT NULL,
  verification_code TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  rating_score REAL,
  review_count INTEGER DEFAULT 0,
  verified_at INTEGER,
  UNIQUE(user_id, platform)
);

CREATE TABLE IF NOT EXISTS quests (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT,
  model_or_isbn TEXT,
  size_or_spec TEXT,
  strictness INTEGER NOT NULL CHECK (strictness IN (1, 2, 3)),
  max_budget_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'fulfilled', 'cancelled', 'expired')),
  reference_image_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS quests_fts USING fts5(
  quest_id UNINDEXED,
  title,
  description,
  category,
  brand,
  model_or_isbn
);

CREATE TRIGGER IF NOT EXISTS quests_ai AFTER INSERT ON quests BEGIN
  INSERT INTO quests_fts(quest_id, title, description, category, brand, model_or_isbn)
  VALUES (new.id, new.title, new.description, new.category, new.brand, new.model_or_isbn);
END;

CREATE TRIGGER IF NOT EXISTS quests_ad AFTER DELETE ON quests BEGIN
  DELETE FROM quests_fts WHERE quest_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS quests_au AFTER UPDATE ON quests BEGIN
  UPDATE quests_fts
  SET title = new.title,
      description = new.description,
      category = new.category,
      brand = new.brand,
      model_or_isbn = new.model_or_isbn
  WHERE quest_id = new.id;
END;

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL REFERENCES users(id),
  match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'alternative', 'curated')),
  item_price_cents INTEGER NOT NULL,
  shipping_estimate_cents INTEGER NOT NULL,
  condition_grade TEXT NOT NULL,
  notes TEXT NOT NULL,
  proof_image_keys TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS escrows (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL UNIQUE REFERENCES quests(id),
  offer_id TEXT NOT NULL UNIQUE REFERENCES offers(id),
  buyer_id TEXT NOT NULL REFERENCES users(id),
  seller_id TEXT NOT NULL REFERENCES users(id),
  item_amount_cents INTEGER NOT NULL,
  shipping_amount_cents INTEGER NOT NULL,
  buyer_fee_cents INTEGER NOT NULL,
  seller_fee_cents INTEGER NOT NULL,
  stripe_payment_intent_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'funded' CHECK (
    state IN ('funded', 'label_created', 'in_transit', 'delivered', 'disputed', 'released', 'refunded')
  ),
  tracking_number TEXT,
  carrier TEXT,
  label_r2_key TEXT,
  ship_by_deadline INTEGER NOT NULL,
  delivered_at INTEGER,
  inspection_deadline INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  escrow_id TEXT NOT NULL UNIQUE REFERENCES escrows(id),
  opened_by_user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (reason IN ('not_as_described', 'damaged_in_transit', 'counterfeit', 'wrong_item')),
  description TEXT NOT NULL,
  evidence_r2_keys TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'seller_fault', 'buyer_fault', 'resolved_return')),
  resolution_notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER
);
