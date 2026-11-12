INSERT OR IGNORE INTO users (id, email, display_name) VALUES
  ('user_demo_1', 'demo@quest.market', 'Demo Collector'),
  ('user_seller_1', 'seller@quest.market', 'Vault Vintage Studio');

INSERT OR IGNORE INTO seller_reputations (
  id, user_id, platform, external_handle, verification_code, verified, rating_score, review_count, verified_at
) VALUES
  ('rep_demo_discogs', 'user_seller_1', 'discogs', 'vault_vintage_audio', 'QUEST-VERIFY-DC998A', 1, 4.99, 428, unixepoch() - 86400),
  ('rep_demo_grailed', 'user_seller_1', 'grailed', 'vault_archive_ny', 'QUEST-VERIFY-GR497B', 1, 4.97, 114, unixepoch() - 43200);
