-- ══════════════════════════════════════════════════════════
-- NEXUS Advanced — Supabase Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════════

-- Enable pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── PRODUCTS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  brand        TEXT NOT NULL,
  category     TEXT NOT NULL,
  price        NUMERIC(10,2) NOT NULL,
  old_price    NUMERIC(10,2),
  rating       NUMERIC(3,2) DEFAULT 0,
  review_count INT DEFAULT 0,
  emoji        TEXT,
  badge        TEXT,
  description  TEXT,
  tags         TEXT[],
  in_stock     BOOLEAN DEFAULT true,
  image_url    TEXT,
  embedding    VECTOR(1536),   -- OpenAI/Cohere text-embedding-3-small
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON products USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
CREATE INDEX ON products (category);
CREATE INDEX ON products (brand);
CREATE INDEX ON products (price);

-- ─── USERS (extends Supabase auth.users) ─────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  preferred_categories TEXT[],
  preferred_brands     TEXT[],
  price_sensitivity    TEXT DEFAULT 'mid',  -- budget | mid | premium
  ab_variant           TEXT DEFAULT 'control', -- control | treatment
  total_sessions       INT DEFAULT 0,
  total_purchases      INT DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ─── EVENTS (behavioural signals) ────────────────────────
CREATE TABLE IF NOT EXISTS user_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  product_id   UUID REFERENCES products(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  -- view | dwell_30s | add_cart | add_wish | purchase | quick_exit | search | filter_use
  dwell_ms     INT,
  search_query TEXT,
  ab_variant   TEXT,
  metadata     JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON user_events (user_id, created_at DESC);
CREATE INDEX ON user_events (session_id);
CREATE INDEX ON user_events (product_id);
CREATE INDEX ON user_events (event_type);

-- ─── RECOMMENDATIONS LOG (A/B testing) ───────────────────
CREATE TABLE IF NOT EXISTS recommendation_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  ab_variant      TEXT NOT NULL,   -- control | treatment
  strategy        TEXT NOT NULL,   -- claude | collaborative | hybrid
  recommended_ids UUID[],
  clicked_ids     UUID[],
  purchased_ids   UUID[],
  shown_at        TIMESTAMPTZ DEFAULT NOW(),
  ctr             NUMERIC(5,4),    -- computed later
  conversion_rate NUMERIC(5,4)
);

CREATE INDEX ON recommendation_logs (ab_variant);
CREATE INDEX ON recommendation_logs (shown_at DESC);

-- ─── WISHLIST ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wishlists (
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

-- ─── CART ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS carts (
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  qty        INT DEFAULT 1,
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

-- ─── ORDERS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id   TEXT,
  ab_variant   TEXT,
  items        JSONB NOT NULL,   -- [{product_id, qty, price}]
  total        NUMERIC(10,2) NOT NULL,
  status       TEXT DEFAULT 'placed',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ANALYTICS SUMMARY (materialised daily) ──────────────
CREATE TABLE IF NOT EXISTS analytics_daily (
  date                DATE PRIMARY KEY,
  total_sessions      INT DEFAULT 0,
  total_events        INT DEFAULT 0,
  total_orders        INT DEFAULT 0,
  total_revenue       NUMERIC(12,2) DEFAULT 0,
  ai_recommendations  INT DEFAULT 0,
  ai_clicks           INT DEFAULT 0,
  ai_ctr              NUMERIC(5,4) DEFAULT 0,
  control_ctr         NUMERIC(5,4) DEFAULT 0,
  treatment_ctr       NUMERIC(5,4) DEFAULT 0,
  top_category        TEXT,
  top_product_id      UUID
);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────
ALTER TABLE user_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlists         ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_logs ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their own data
CREATE POLICY "own_profile"  ON user_profiles     FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own_events"   ON user_events       FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own_wishlist" ON wishlists         FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own_cart"     ON carts             FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own_orders"   ON orders            FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own_reclogs"  ON recommendation_logs FOR ALL USING (auth.uid() = user_id);

-- Products are public
CREATE POLICY "products_public" ON products FOR SELECT USING (true);

-- ─── VECTOR SEARCH FUNCTION ───────────────────────────────
CREATE OR REPLACE FUNCTION match_products(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count     INT   DEFAULT 10
)
RETURNS TABLE (id UUID, name TEXT, brand TEXT, category TEXT,
               price NUMERIC, emoji TEXT, similarity FLOAT)
LANGUAGE SQL STABLE AS $$
  SELECT
    p.id, p.name, p.brand, p.category, p.price, p.emoji,
    1 - (p.embedding <=> query_embedding) AS similarity
  FROM products p
  WHERE 1 - (p.embedding <=> query_embedding) > match_threshold
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ─── PROFILE AUTO-CREATE ON SIGNUP ────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, ab_variant)
  VALUES (
    NEW.id,
    CASE WHEN (extract(epoch FROM NOW())::INT % 2 = 0)
         THEN 'control' ELSE 'treatment' END
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
