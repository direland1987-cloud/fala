import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const notebooks = sqliteTable('notebooks', {
  owner: text('owner').primaryKey(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
});
export const settings = sqliteTable('settings', {
  owner: text('owner').primaryKey(),
  data: text('data').notNull(),
});
export const sessions = sqliteTable(
  'voice_sessions',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    status: text('status').notNull(),
    model: text('model').notNull(),
    minutes: integer('minutes').notNull(),
    started: integer('started').notNull(),
    lastSeen: integer('last_seen').notNull(),
    ended: integer('ended'),
    callId: text('call_id'),
    snapshot: text('snapshot').notNull(),
    summaryStatus: text('summary_status').notNull().default('pending'),
    summary: text('summary'),
    error: text('error'),
    controlConnected: integer('control_connected').notNull().default(0),
    usageIncomplete: integer('usage_incomplete').notNull().default(0),
  },
  (t) => [
    index('sessions_owner_started').on(t.owner, t.started),
    uniqueIndex('sessions_one_active')
      .on(t.owner)
      .where(sql`${t.status} IN ('starting','active','finishing')`),
  ],
);
export const events = sqliteTable(
  'lesson_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('events_session_at').on(t.sessionId, t.at)],
);
export const usage = sqliteTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    owner: text('owner').notNull(),
    model: text('model').notNull(),
    category: text('category').notNull(),
    usd: real('usd').notNull(),
    details: text('details').notNull(),
    at: integer('at').notNull(),
    pricingVersion: text('pricing_version').notNull(),
    incomplete: integer('incomplete').notNull().default(0),
  },
  (t) => [index('usage_owner_at').on(t.owner, t.at), index('usage_session').on(t.sessionId)],
);
