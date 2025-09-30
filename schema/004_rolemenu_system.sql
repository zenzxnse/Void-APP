-- [ROLE MENU SYSTEM]
-- This table stores configuration for role menus in guilds.
CREATE TABLE IF NOT EXISTS guild_rolemenu_config (
    guild_id                BIGINT PRIMARY KEY,
    channel_id              BIGINT NOT NULL,
    message_id              BIGINT NOT NULL,
    is_active               BOOLEAN DEFAULT TRUE,
    roles                   TEXT[] NOT NULL -- Array of role IDs
);