import type { SqlStorage } from "@workspace/runtime/worker";

export function createGmailTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_channel_state (
      channel_id TEXT PRIMARY KEY,
      history_id TEXT,
      email_address TEXT,
      credential_id TEXT,
      poll_interval_ms INTEGER NOT NULL,
      last_sync_at INTEGER,
      last_error TEXT,
      setup_status TEXT NOT NULL DEFAULT 'needs-user-preferences',
      setup_prompted_at INTEGER,
      configured_at INTEGER,
      setup_summary TEXT,
      sync_state TEXT NOT NULL DEFAULT 'ok',
      rate_limited_until INTEGER,
      backoff_ms INTEGER,
      last_setup_json TEXT,
      people_api_status TEXT,
      watch_expiration INTEGER
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_threads (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      snippet TEXT NOT NULL,
      unread INTEGER NOT NULL,
      in_inbox INTEGER NOT NULL,
      actionable INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id)
    )
  `);
  // Natural-language attention preferences (replaces the old rule store).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_prefs (
      channel_id TEXT PRIMARY KEY,
      preferences_text TEXT NOT NULL,
      known_sender_shortcut INTEGER NOT NULL DEFAULT 1,
      triage_model TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_hits (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      directive_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      matched_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_replied_senders (
      channel_id TEXT NOT NULL,
      email TEXT NOT NULL,
      display TEXT,
      first_replied_at INTEGER NOT NULL,
      last_replied_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY(channel_id, email)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_turns (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_queue (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL,
      reason TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_wake_turns (
      channel_id TEXT NOT NULL,
      started_at INTEGER NOT NULL
    )
  `);
  // Candidates awaiting the batched LLM triage pass (metadata only).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_triage_queue (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      category TEXT,
      prior_reply INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id, thread_id, message_id)
    )
  `);
  // Cost-control bookkeeping for triage LLM runs.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_triage_runs (
      channel_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      candidates INTEGER NOT NULL,
      outcome TEXT NOT NULL
    )
  `);
  // Snoozed-thread reminders (durable user data; fire via the worker alarm).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_reminders (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      remind_at INTEGER NOT NULL,
      note TEXT,
      subject TEXT,
      from_addr TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_people (
      channel_id TEXT,
      email TEXT,
      display_name TEXT,
      sent_to_count INTEGER DEFAULT 0,
      received_from_count INTEGER DEFAULT 0,
      last_interaction_at INTEGER,
      you_replied INTEGER DEFAULT 0,
      PRIMARY KEY (channel_id, email)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_push_targets (
      email_address TEXT NOT NULL,
      source TEXT NOT NULL,
      class_name TEXT NOT NULL,
      object_key TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      PRIMARY KEY(email_address, source, class_name, object_key)
    )
  `);
}

export const DEFAULT_ATTENTION_PREFERENCES =
  "Surface unread inbox mail from people I have replied to before. " +
  "Ignore promotions, social updates, and newsletters unless they look urgent or time-sensitive.";
