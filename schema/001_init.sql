-- ============================================================================
-- Void Bot Database Schema - Production Ready
-- PostgreSQL 16+
-- Single idempotent file with all fixes applied
-- ============================================================================

-- 0) Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- Trigram searches
-- Removed btree_gin (not used)

-- 1) Dedicated schema
CREATE SCHEMA IF NOT EXISTS void;
SET search_path = void, public;

-- ============================================================================
-- TABLES
-- ============================================================================

-- 2) Guild Configurations
CREATE TABLE IF NOT EXISTS guild_config (
    guild_id                TEXT PRIMARY KEY,
    prefix                  TEXT DEFAULT '!',
    log_channel_id          TEXT,
    report_channel_id       TEXT,
    appeal_channel_id       TEXT,
    mute_role_id            TEXT,
    warn_decay_days         INTEGER DEFAULT 30 CHECK (warn_decay_days >= 0),
    max_warns               INTEGER DEFAULT 3 CHECK (max_warns > 0),
    auto_mod_enabled        BOOLEAN DEFAULT TRUE,
    spam_threshold          INTEGER DEFAULT 5 CHECK (spam_threshold > 0),
    caps_threshold          NUMERIC(3,2) DEFAULT 0.70 CHECK (caps_threshold BETWEEN 0 AND 1),
    invite_filter_enabled   BOOLEAN DEFAULT TRUE,
    link_filter_enabled     BOOLEAN DEFAULT FALSE,
    profanity_filter_level  INTEGER DEFAULT 1 CHECK (profanity_filter_level BETWEEN 0 AND 2),
    dm_on_action            BOOLEAN DEFAULT TRUE,
    timeout_renewal         BOOLEAN DEFAULT TRUE,
    welcome_channel_id      TEXT,
    goodbye_channel_id      TEXT,
    verification_role_id    TEXT,
    bot_role_id             TEXT,
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- 3) Warn Thresholds
CREATE TABLE IF NOT EXISTS warn_thresholds (
    guild_id            TEXT NOT NULL,
    threshold           INTEGER NOT NULL CHECK (threshold > 0),
    action              TEXT NOT NULL CHECK (action IN ('none', 'timeout', 'mute', 'kick', 'ban', 'softban')),
    duration_seconds    INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
    PRIMARY KEY (guild_id, threshold),
    FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id) ON DELETE CASCADE
);

-- 4) Infractions
CREATE TABLE IF NOT EXISTS infractions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id            TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL,
    moderator_id        TEXT NOT NULL,
    type                TEXT NOT NULL CHECK (type IN (
                            'note', 'warn', 'timeout', 'mute', 'kick', 'ban', 'softban',
                            'unmute', 'untimeout', 'unban', 'pardon'
                        )),
    reason              TEXT,
    duration_seconds    INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at          TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    revoker_id          TEXT,
    replaced_by         UUID REFERENCES infractions(id),
    context             JSONB DEFAULT '{}'::JSONB CHECK (jsonb_typeof(context) = 'object'),
    evidence            TEXT[],
    appeal_status       TEXT CHECK (appeal_status IN ('none', 'pending', 'approved', 'denied')),
    appeal_reason       TEXT,
    -- Duration constraints
    CONSTRAINT duration_required_for_temp CHECK (
        (type IN ('timeout', 'mute', 'softban') AND duration_seconds IS NOT NULL) OR
        (type NOT IN ('timeout', 'mute', 'softban'))
    ),
    -- Revocation integrity
    CONSTRAINT revoked_integrity CHECK (
        (revoked_at IS NULL AND revoker_id IS NULL) OR
        (revoked_at IS NOT NULL AND revoker_id IS NOT NULL)
    )
);

-- 5) Infraction Evidence (normalized from TEXT[] for scalability)
CREATE TABLE IF NOT EXISTS infraction_evidence (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    infraction_id   UUID NOT NULL REFERENCES infractions(id) ON DELETE CASCADE,
    evidence_type   TEXT NOT NULL CHECK (evidence_type IN ('message', 'image', 'link', 'file')),
    content         TEXT NOT NULL,
    metadata        JSONB DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 6) Scheduled Jobs
CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type            TEXT NOT NULL CHECK (type IN (
                        'untimeout', 'unmute', 'unban', 'reapply_timeout',
                        'cleanup_expired', 'slowmode_end', 'lockdown_end',
                        'purge_old_logs', 'user_prune', 'cleanup_components'
                    )),
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    user_id         TEXT,
    channel_id      TEXT,
    infraction_id   UUID REFERENCES infractions(id) ON DELETE CASCADE,
    run_at          TIMESTAMPTZ NOT NULL,
    priority        SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error      TEXT,
    locked_at       TIMESTAMPTZ,
    locked_by       TEXT,
    data            JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Lock integrity
    CONSTRAINT lock_integrity CHECK (
        (locked_at IS NULL AND locked_by IS NULL) OR
        (locked_at IS NOT NULL AND locked_by IS NOT NULL)
    )
);

-- 7) Auto-Moderation Rules
CREATE TABLE IF NOT EXISTS auto_mod_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id            TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    type                TEXT NOT NULL CHECK (type IN ('keyword', 'regex', 'spam', 'caps', 'invite', 'link', 'mention_spam')),
    pattern             TEXT,
    action              TEXT NOT NULL CHECK (action IN ('delete', 'warn', 'mute', 'timeout', 'kick', 'ban')),
    duration_seconds    INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
    exempt_roles        TEXT[],
    exempt_channels     TEXT[],
    enabled             BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (guild_id, name)
);

-- 8) User Reports
CREATE TABLE IF NOT EXISTS user_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    reporter_id     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('user', 'message')),
    reason          TEXT NOT NULL,
    status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed', 'actioned')),
    reviewed_by     TEXT,
    reviewed_at     TIMESTAMPTZ,
    context         JSONB DEFAULT '{}'::JSONB CHECK (jsonb_typeof(context) = 'object'),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    -- Review integrity
    CONSTRAINT review_integrity CHECK (
        (reviewed_at IS NULL AND reviewed_by IS NULL) OR
        (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    )
);

-- 9) Appeals
CREATE TABLE IF NOT EXISTS appeals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    infraction_id   UUID NOT NULL REFERENCES infractions(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,
    status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
    reviewed_by     TEXT,
    reviewed_at     TIMESTAMPTZ,
    decision_note   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    -- Review integrity
    CONSTRAINT appeal_review_integrity CHECK (
        (reviewed_at IS NULL AND reviewed_by IS NULL) OR
        (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    )
);

-- 10) Channel Configurations
CREATE TABLE IF NOT EXISTS channel_config (
    channel_id          TEXT PRIMARY KEY,
    guild_id            TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    slowmode_seconds    INTEGER DEFAULT 0 CHECK (slowmode_seconds >= 0 AND slowmode_seconds <= 21600),
    lockdown_enabled    BOOLEAN DEFAULT FALSE,
    auto_mod_overrides  JSONB DEFAULT '{}'::JSONB CHECK (jsonb_typeof(auto_mod_overrides) = 'object'),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 11) User Notes
CREATE TABLE IF NOT EXISTS user_notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    moderator_id    TEXT NOT NULL,
    note            TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 12) Audit Logs - Consider SET NULL instead of CASCADE to preserve history
CREATE TABLE IF NOT EXISTS audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    action_type     TEXT NOT NULL,
    actor_id        TEXT,
    target_id       TEXT,
    details         JSONB NOT NULL CHECK (jsonb_typeof(details) = 'object'),
    timestamp       TIMESTAMPTZ DEFAULT NOW()
);

-- 13) Keyword Lists
CREATE TABLE IF NOT EXISTS keyword_lists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    keyword         TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('profanity', 'whitelist', 'blacklist')),
    severity        INTEGER DEFAULT 1 CHECK (severity BETWEEN 1 AND 5),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (guild_id, keyword, type)  -- Allow same keyword in different lists
);

-- 14) Role Permissions Overrides
CREATE TABLE IF NOT EXISTS role_permissions (
    role_id         TEXT NOT NULL,
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    can_warn        BOOLEAN DEFAULT FALSE,
    can_mute        BOOLEAN DEFAULT FALSE,
    can_kick        BOOLEAN DEFAULT FALSE,
    can_ban         BOOLEAN DEFAULT FALSE,
    can_manage_rules BOOLEAN DEFAULT FALSE,
    max_duration    INTEGER CHECK (max_duration IS NULL OR max_duration > 0),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (guild_id, role_id)
);

-- 15) Config Snapshots
CREATE TABLE IF NOT EXISTS config_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    snapshot_data   JSONB NOT NULL CHECK (jsonb_typeof(snapshot_data) = 'object'),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    reason          TEXT
);

-- 16) Moderation Statistics
CREATE TABLE IF NOT EXISTS mod_stats (
    id              BIGSERIAL PRIMARY KEY,
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    moderator_id    TEXT NOT NULL,
    action_type     TEXT NOT NULL,
    count           INTEGER DEFAULT 1 CHECK (count > 0),
    period_start    DATE NOT NULL,
    UNIQUE (guild_id, moderator_id, action_type, period_start)
);

-- 17) Temporary Role Assignments
CREATE TABLE IF NOT EXISTS temp_roles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id            TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL,
    role_id             TEXT NOT NULL,
    assigned_by         TEXT NOT NULL,
    duration_seconds    INTEGER NOT NULL CHECK (duration_seconds > 0),
    assigned_at         TIMESTAMPTZ DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    -- Ensure expires_at is after assigned_at
    CONSTRAINT valid_expiry CHECK (expires_at > assigned_at)
);

-- 18) Migration Tracking
CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES (Optimized, no duplicates, no volatile predicates)
-- ============================================================================

-- Guild config
CREATE INDEX IF NOT EXISTS idx_guild_config_updated ON guild_config (updated_at);

-- Warn thresholds
CREATE INDEX IF NOT EXISTS idx_warn_thresholds_action ON warn_thresholds (action);

-- Infractions (removed duplicate idx_infractions_guild_user)
CREATE INDEX IF NOT EXISTS idx_infractions_guc ON infractions (guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_infractions_type_active ON infractions (type, active);
CREATE INDEX IF NOT EXISTS idx_infractions_expires ON infractions (expires_at) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_infractions_context_gin ON infractions USING GIN (context);
CREATE INDEX IF NOT EXISTS idx_infractions_moderator ON infractions (moderator_id);
CREATE INDEX IF NOT EXISTS idx_infractions_created ON infractions (created_at DESC);

-- Unique constraint: one active ban per user per guild
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_ban_per_user
    ON infractions (guild_id, user_id)
    WHERE type = 'ban' AND active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cleanup_components_once
  ON scheduled_jobs (guild_id)
  WHERE type = 'cleanup_components';


-- Infraction evidence
CREATE INDEX IF NOT EXISTS idx_evidence_infraction ON infraction_evidence (infraction_id);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON infraction_evidence (evidence_type);

-- Scheduled jobs (with covering indexes for hot paths)
CREATE INDEX IF NOT EXISTS idx_sj_due 
    ON scheduled_jobs (run_at, priority DESC) 
    WHERE attempts < 5 AND locked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sj_type_run 
    ON scheduled_jobs (type, run_at)
    INCLUDE (data)
    WHERE attempts < 5;

CREATE INDEX IF NOT EXISTS idx_sj_locked 
    ON scheduled_jobs (locked_at) 
    WHERE locked_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sj_guild ON scheduled_jobs (guild_id);

CREATE INDEX IF NOT EXISTS idx_sj_failed 
    ON scheduled_jobs (locked_by) 
    WHERE locked_by = 'failed';

CREATE INDEX IF NOT EXISTS idx_sj_type_channel 
    ON scheduled_jobs (type, channel_id, run_at);

CREATE INDEX IF NOT EXISTS idx_sj_type_user 
    ON scheduled_jobs (type, user_id, run_at);

-- Unique constraints for channel-specific jobs
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lockdown_end_per_channel
    ON scheduled_jobs (channel_id)
    WHERE type = 'lockdown_end' AND locked_at IS NULL AND attempts < 5;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_slowmode_end_per_channel
    ON scheduled_jobs (channel_id)
    WHERE type = 'slowmode_end' AND locked_at IS NULL AND attempts < 5;

-- Auto-mod rules
CREATE INDEX IF NOT EXISTS idx_auto_mod_rules_guild_enabled ON auto_mod_rules (guild_id, enabled);
CREATE INDEX IF NOT EXISTS idx_auto_mod_rules_pattern_trgm ON auto_mod_rules USING GIN (pattern gin_trgm_ops);

-- User reports
CREATE INDEX IF NOT EXISTS idx_user_reports_guild_status ON user_reports (guild_id, status);
CREATE INDEX IF NOT EXISTS idx_user_reports_target ON user_reports (target_id);
CREATE INDEX IF NOT EXISTS idx_user_reports_created ON user_reports (created_at DESC);

-- Appeals (added guild_id and user lookups)
CREATE INDEX IF NOT EXISTS idx_appeals_infraction ON appeals (infraction_id);
CREATE INDEX IF NOT EXISTS idx_appeals_user_status ON appeals (user_id, status);
CREATE INDEX IF NOT EXISTS idx_appeals_guild_status ON appeals (guild_id, status);

-- Channel config
CREATE INDEX IF NOT EXISTS idx_channel_config_guild ON channel_config (guild_id);
CREATE INDEX IF NOT EXISTS idx_channel_config_lockdown ON channel_config (guild_id) WHERE lockdown_enabled = TRUE;

-- User notes
CREATE INDEX IF NOT EXISTS idx_user_notes_guild_user ON user_notes (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_notes_created ON user_notes (created_at DESC);

-- Audit logs (optimized for read patterns)
CREATE INDEX IF NOT EXISTS idx_audit_logs_guild_timestamp ON audit_logs (guild_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_guild_action ON audit_logs (guild_id, action_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs (target_id);
-- BRIN for very large tables
CREATE INDEX IF NOT EXISTS brin_audit_logs_ts ON audit_logs USING BRIN (timestamp);

-- Keyword lists
CREATE INDEX IF NOT EXISTS idx_keyword_lists_guild_type ON keyword_lists (guild_id, type);
CREATE INDEX IF NOT EXISTS idx_keyword_lists_keyword_trgm ON keyword_lists USING GIN (keyword gin_trgm_ops);

-- Role permissions
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions (role_id);

-- Config snapshots
CREATE INDEX IF NOT EXISTS idx_config_snapshots_guild_created ON config_snapshots (guild_id, created_at DESC);

-- Mod stats
CREATE INDEX IF NOT EXISTS idx_mod_stats_guild_period ON mod_stats (guild_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_mod_stats_moderator ON mod_stats (moderator_id, period_start DESC);

-- Temp roles (removed duplicate partial index)
CREATE INDEX IF NOT EXISTS idx_temp_roles_expires ON temp_roles (expires_at);
CREATE INDEX IF NOT EXISTS idx_temp_roles_guild_user ON temp_roles (guild_id, user_id);

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Update timestamp function
CREATE OR REPLACE FUNCTION void_update_timestamp() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure expires_at is valid for infractions (replaces volatile CHECK)
CREATE OR REPLACE FUNCTION void_validate_infraction_expiry() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.active = TRUE AND NEW.expires_at IS NOT NULL AND NEW.expires_at <= NOW() THEN
        RAISE EXCEPTION 'Cannot set expires_at in the past for active infractions';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate triggers for idempotency
DROP TRIGGER IF EXISTS trig_update_guild_config ON guild_config;
CREATE TRIGGER trig_update_guild_config
    BEFORE UPDATE ON guild_config
    FOR EACH ROW EXECUTE FUNCTION void_update_timestamp();

DROP TRIGGER IF EXISTS trig_update_user_notes ON user_notes;
CREATE TRIGGER trig_update_user_notes
    BEFORE UPDATE ON user_notes
    FOR EACH ROW EXECUTE FUNCTION void_update_timestamp();

DROP TRIGGER IF EXISTS trig_update_channel_config ON channel_config;
CREATE TRIGGER trig_update_channel_config
    BEFORE UPDATE ON channel_config
    FOR EACH ROW EXECUTE FUNCTION void_update_timestamp();

DROP TRIGGER IF EXISTS trig_validate_infraction_expiry ON infractions;
CREATE TRIGGER trig_validate_infraction_expiry
    BEFORE INSERT OR UPDATE ON infractions
    FOR EACH ROW EXECUTE FUNCTION void_validate_infraction_expiry();

-- ============================================================================
-- VIEWS (No ORDER BY in views for better query planning)
-- ============================================================================

-- Active infractions summary
CREATE OR REPLACE VIEW active_infractions_summary AS
SELECT 
    guild_id, 
    user_id, 
    type, 
    COUNT(*) AS count
FROM infractions
WHERE active = TRUE
GROUP BY guild_id, user_id, type;

-- Expired temporary roles
CREATE OR REPLACE VIEW expired_temp_roles AS
SELECT * FROM temp_roles 
WHERE expires_at < CURRENT_TIMESTAMP;

-- Due scheduled jobs (removed ORDER BY from view)
CREATE OR REPLACE VIEW due_scheduled_jobs AS
SELECT * FROM scheduled_jobs
WHERE run_at <= CURRENT_TIMESTAMP
  AND attempts < 5
  AND locked_at IS NULL;




-- ============================================================================
-- PERSISTENT COMPONENTS SCHEMA
-- Add to your existing schema.sql
-- ============================================================================

-- Persistent component storage
CREATE TABLE IF NOT EXISTS persistent_components (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id          TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    guild_id            TEXT, -- NULL in DMs; keep a plain index (no FK)
    component_type      TEXT NOT NULL,   -- namespace:action (unversioned)
    component_key       TEXT NOT NULL,   -- stable dedup key per component instance
    component_data      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(component_data) = 'object'),
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_count          INTEGER DEFAULT 0,
    last_used_at        TIMESTAMPTZ,
    last_used_by        TEXT,
    -- One message can host many components as long as their component_key differs
    UNIQUE(message_id, component_key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_persistent_components_expires
  ON persistent_components (expires_at);

CREATE INDEX IF NOT EXISTS idx_persistent_components_guild
  ON persistent_components (guild_id);

CREATE INDEX IF NOT EXISTS idx_persistent_components_channel
  ON persistent_components (channel_id);

CREATE INDEX IF NOT EXISTS idx_persistent_components_message
  ON persistent_components (message_id);

-- Component usage tracking (for analytics)
CREATE TABLE component_usage (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component_id    UUID REFERENCES persistent_components(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    guild_id        TEXT,  -- NULL in DMs
    action          TEXT NOT NULL,
    success         BOOLEAN NOT NULL DEFAULT true,
    error_message   TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_component_usage_component ON component_usage (component_id);
CREATE INDEX IF NOT EXISTS idx_component_usage_user ON component_usage (user_id);
CREATE INDEX IF NOT EXISTS idx_component_usage_executed ON component_usage (executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_component_usage_guild ON component_usage (guild_id);

-- Anti-replay tracking (optional - for Redis alternative)
CREATE TABLE IF NOT EXISTS component_replay_guard (
    replay_key          TEXT PRIMARY KEY,
    guild_id            TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replay_guard_expires 
    ON component_replay_guard (expires_at);

-- Cleanup old entries periodically
CREATE OR REPLACE FUNCTION cleanup_expired_components() RETURNS void AS $$
BEGIN
    -- Delete expired persistent components
    DELETE FROM persistent_components 
    WHERE expires_at < NOW() - INTERVAL '1 day';
    
    -- Delete old replay guards
    DELETE FROM component_replay_guard 
    WHERE expires_at < NOW();
    
    -- Delete old usage data (keep 30 days)
    DELETE FROM component_usage 
    WHERE executed_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- INITIAL MIGRATION RECORD
-- ============================================================================

INSERT INTO _migrations (name) VALUES ('001_schema.sql') ON CONFLICT DO NOTHING;

-- ============================================================================
-- APPLICATION NOTES
-- ============================================================================

-- CRITICAL: Application must ensure guild_config exists before any writes
-- On GUILD_CREATE event or before first write:
-- INSERT INTO void.guild_config (guild_id) VALUES ($1) ON CONFLICT DO NOTHING;

-- Worker job picking pattern (use in transaction):
-- BEGIN;
-- SELECT * FROM scheduled_jobs 
--   WHERE run_at <= NOW() AND attempts < 5 AND locked_at IS NULL
--   ORDER BY priority DESC, run_at ASC
--   LIMIT 1
--   FOR UPDATE SKIP LOCKED;
-- UPDATE scheduled_jobs SET locked_at = NOW(), locked_by = $worker_id WHERE id = $job_id;
-- COMMIT;

-- For production connections:
-- 1. Set search_path: postgres://user:pass@host/voiddb?options=-c%20search_path%3Dvoid%2Cpublic
-- 2. Enable SSL: sslmode=require
-- 3. Consider connection pooling with pgBouncer for high concurrency

-- For very large tables (100M+ rows), consider:
-- 1. Partitioning audit_logs by month: CREATE TABLE audit_logs_2025_01 PARTITION OF audit_logs FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
-- 2. Using TimescaleDB for time-series data
-- 3. Setting table-specific autovacuum settings for hot tables