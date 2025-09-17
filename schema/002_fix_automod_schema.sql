-- Database migration: Add missing fields and fix constraints
-- File: src/core/db/migrations/002_fix_automod_schema.sql
SET search_path = void, public;
BEGIN;

-- Add missing threshold and data fields to auto_mod_rules
ALTER TABLE auto_mod_rules 
ADD COLUMN IF NOT EXISTS threshold INTEGER CHECK (threshold > 0),
ADD COLUMN IF NOT EXISTS rule_data JSONB DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rule_data) = 'object'),
ADD COLUMN IF NOT EXISTS priority SMALLINT DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
ADD COLUMN IF NOT EXISTS error_count INTEGER DEFAULT 0 CHECK (error_count >= 0),
ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS quarantined BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- Add rule_key for stable identification (keeping name for display)
ALTER TABLE auto_mod_rules 
ADD COLUMN IF NOT EXISTS rule_key TEXT;

-- Generate rule_keys for existing rules (idempotent)
UPDATE auto_mod_rules 
SET rule_key = LOWER(REGEXP_REPLACE(type || '_' || COALESCE(threshold::text, 'default'), '[^a-z0-9_]', '_', 'g'))
WHERE rule_key IS NULL;

-- Make rule_key NOT NULL after populating
ALTER TABLE auto_mod_rules 
ALTER COLUMN rule_key SET NOT NULL;

-- Update uniqueness constraint to use rule_key instead of name
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'auto_mod_rules_guild_id_name_key'
    ) THEN
        ALTER TABLE auto_mod_rules DROP CONSTRAINT auto_mod_rules_guild_id_name_key;
    END IF;
END $$;

-- Add new unique constraint on rule_key
ALTER TABLE auto_mod_rules 
ADD CONSTRAINT auto_mod_rules_guild_id_rule_key_key UNIQUE (guild_id, rule_key);

-- Update indexes for performance
DROP INDEX IF EXISTS idx_auto_mod_rules_guild_enabled;
CREATE INDEX IF NOT EXISTS idx_auto_mod_rules_lookup 
ON auto_mod_rules (guild_id, enabled, priority DESC, rule_key) 
WHERE enabled = TRUE AND quarantined = FALSE;

CREATE INDEX IF NOT EXISTS idx_auto_mod_rules_quarantined 
ON auto_mod_rules (quarantined, last_error_at DESC) 
WHERE quarantined = TRUE;

-- Add version tracking for optimistic concurrency
CREATE INDEX IF NOT EXISTS idx_auto_mod_rules_version 
ON auto_mod_rules (guild_id, version);

-- Action deduplication table for complex scenarios
CREATE TABLE IF NOT EXISTS automod_action_locks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    action_type     TEXT NOT NULL,
    locked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    locked_by_shard TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    UNIQUE (guild_id, user_id, action_type)
);

CREATE INDEX IF NOT EXISTS idx_automod_locks_expires 
ON automod_action_locks (expires_at);

-- Function to clean expired locks
CREATE OR REPLACE FUNCTION cleanup_automod_locks() RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM automod_action_locks 
    WHERE expires_at < NOW();
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Auto-moderation violation tracking for analytics
CREATE TABLE IF NOT EXISTS automod_violations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    rule_id         UUID NOT NULL REFERENCES auto_mod_rules(id) ON DELETE CASCADE,
    message_id      TEXT,
    channel_id      TEXT NOT NULL,
    violation_type  TEXT NOT NULL,
    action_taken    TEXT NOT NULL,
    violation_data  JSONB DEFAULT '{}'::jsonb,
    success         BOOLEAN NOT NULL DEFAULT TRUE,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for violation analytics
CREATE INDEX IF NOT EXISTS idx_automod_violations_guild_time 
ON automod_violations (guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automod_violations_user 
ON automod_violations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automod_violations_rule 
ON automod_violations (rule_id, success, created_at DESC);

-- BRIN index for time-series data
CREATE INDEX IF NOT EXISTS brin_automod_violations_time 
ON automod_violations USING BRIN (created_at);

-- Validation function for rule configuration
CREATE OR REPLACE FUNCTION validate_automod_rule() RETURNS TRIGGER AS $$
BEGIN
    -- Validate threshold requirements
    IF NEW.type IN ('spam', 'mention_spam', 'caps', 'channel_spam') THEN
        IF NEW.threshold IS NULL THEN
            RAISE EXCEPTION 'Rule type % requires a threshold', NEW.type;
        END IF;
        
        -- Type-specific threshold limits
        IF NEW.type = 'caps' AND (NEW.threshold < 1 OR NEW.threshold > 100) THEN
            RAISE EXCEPTION 'Caps threshold must be between 1 and 100 (percentage)';
        END IF;
        
        IF NEW.type IN ('spam', 'mention_spam', 'channel_spam') AND (NEW.threshold < 1 OR NEW.threshold > 50) THEN
            RAISE EXCEPTION 'Spam threshold must be between 1 and 50';
        END IF;
    END IF;
    
    -- Validate pattern requirements
    IF NEW.type IN ('keyword', 'regex') THEN
        IF NEW.pattern IS NULL OR LENGTH(TRIM(NEW.pattern)) = 0 THEN
            RAISE EXCEPTION 'Rule type % requires a pattern', NEW.type;
        END IF;
        
        -- Basic regex validation
        IF NEW.type = 'regex' THEN
            BEGIN
                PERFORM regexp_replace('test', NEW.pattern, '', 'g');
            EXCEPTION WHEN invalid_regular_expression THEN
                RAISE EXCEPTION 'Invalid regex pattern: %', NEW.pattern;
            END;
        END IF;
    END IF;
    
    -- Validate action-duration combinations
    IF NEW.action IN ('timeout', 'mute', 'ban') AND NEW.duration_seconds IS NULL THEN
        RAISE EXCEPTION 'Action % requires a duration', NEW.action;
    END IF;
    
    -- Auto-generate rule_key if not provided
    IF NEW.rule_key IS NULL THEN
        NEW.rule_key := LOWER(REGEXP_REPLACE(
            NEW.type || '_' || COALESCE(NEW.threshold::text, 'default'),
            '[^a-z0-9_]', '_', 'g'
        ));
    END IF;
    
    -- Reset quarantine on update if rule is being fixed
    IF TG_OP = 'UPDATE' AND OLD.quarantined = TRUE AND NEW.quarantined IS NOT DISTINCT FROM OLD.quarantined THEN
        NEW.quarantined := FALSE;
        NEW.error_count := 0;
        NEW.last_error_at := NULL;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply validation trigger
DROP TRIGGER IF EXISTS trig_validate_automod_rule ON auto_mod_rules;
CREATE TRIGGER trig_validate_automod_rule
    BEFORE INSERT OR UPDATE ON auto_mod_rules
    FOR EACH ROW EXECUTE FUNCTION validate_automod_rule();

-- Function to quarantine problematic rules
CREATE OR REPLACE FUNCTION quarantine_automod_rule(rule_uuid UUID, error_msg TEXT) RETURNS BOOLEAN AS $$
DECLARE
    updated_count INTEGER;
BEGIN
    UPDATE auto_mod_rules 
    SET quarantined = TRUE,
        error_count = error_count + 1,
        last_error_at = NOW()
    WHERE id = rule_uuid 
      AND enabled = TRUE 
      AND quarantined = FALSE;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    
    IF updated_count > 0 THEN
        -- Log quarantine event
        INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details)
        SELECT guild_id, 'automod_rule_quarantined', 'system', rule_uuid::text,
               jsonb_build_object(
                   'rule_name', name,
                   'rule_type', type,
                   'error_message', error_msg,
                   'error_count', error_count
               )
        FROM auto_mod_rules 
        WHERE id = rule_uuid;
        
        RETURN TRUE;
    END IF;
    
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- Update the cleanup function to handle new tables
CREATE OR REPLACE FUNCTION cleanup_expired_components() RETURNS void AS $$
BEGIN
    -- Original component cleanup
    DELETE FROM persistent_components 
    WHERE expires_at < NOW() - INTERVAL '1 day';
    
    -- New automod cleanup
    PERFORM cleanup_automod_locks();
    
    -- Cleanup old violation records (keep 90 days)
    DELETE FROM automod_violations 
    WHERE created_at < NOW() - INTERVAL '90 days';
    
    -- Un-quarantine rules that haven't errored recently (24 hours)
    UPDATE auto_mod_rules 
    SET quarantined = FALSE, 
        error_count = 0, 
        last_error_at = NULL
    WHERE quarantined = TRUE 
      AND (last_error_at IS NULL OR last_error_at < NOW() - INTERVAL '24 hours')
      AND error_count < 10; -- Don't auto-restore frequently broken rules
END;
$$ LANGUAGE plpgsql;

COMMIT;