-- migrations/009_ai_system.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- AI settings per guild/channel
CREATE TABLE IF NOT EXISTS ai_settings (
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  channel_key TEXT GENERATED ALWAYS AS (COALESCE(channel_id, '')) STORED,
  enabled BOOLEAN DEFAULT FALSE,
  model TEXT DEFAULT 'llama-3.1-70b-versatile',
  temperature NUMERIC(3,2) DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 2048,
  require_allowlist BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (guild_id, channel_key),
  FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
);


-- AI access control with unique partial index
CREATE TABLE IF NOT EXISTS ai_access (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'allowed',
  reason TEXT,
  expires_at TIMESTAMPTZ,
  warned_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
);

-- AI conversation sessions
CREATE TABLE IF NOT EXISTS ai_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  memo TEXT, -- Compressed summary of older messages
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
);

-- Message history for context
CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usage tracking for rate limits
CREATE TABLE IF NOT EXISTS ai_usage (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  requests INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, date),
  FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_ai_sessions_lookup ON ai_sessions(guild_id, channel_id, user_id);
CREATE INDEX idx_ai_messages_session ON ai_messages(session_id, created_at DESC);
CREATE INDEX idx_ai_usage_date ON ai_usage(date);

CREATE UNIQUE INDEX idx_ai_access_banned 
ON ai_access(guild_id, user_id) 
WHERE status = 'banned';

-- Cleanup function
CREATE OR REPLACE FUNCTION cleanup_old_ai_data()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER := 0;
BEGIN
  -- Delete old sessions (30 days)
  DELETE FROM ai_sessions 
  WHERE last_used_at < NOW() - INTERVAL '30 days';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- Delete old usage data (90 days)
  DELETE FROM ai_usage 
  WHERE date < CURRENT_DATE - INTERVAL '90 days';
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;