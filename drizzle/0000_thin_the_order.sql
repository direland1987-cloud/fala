CREATE TABLE `lesson_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_session_at` ON `lesson_events` (`session_id`,`at`);--> statement-breakpoint
CREATE TABLE `notebooks` (
	`owner` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`minutes` integer NOT NULL,
	`started` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`ended` integer,
	`call_id` text,
	`snapshot` text NOT NULL,
	`summary_status` text DEFAULT 'pending' NOT NULL,
	`summary` text,
	`error` text,
	`control_connected` integer DEFAULT 0 NOT NULL,
	`usage_incomplete` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_owner_started` ON `voice_sessions` (`owner`,`started`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_active` ON `voice_sessions` (`owner`) WHERE "voice_sessions"."status" IN ('starting','active','finishing');--> statement-breakpoint
CREATE TABLE `settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`owner` text NOT NULL,
	`model` text NOT NULL,
	`category` text NOT NULL,
	`usd` real NOT NULL,
	`details` text NOT NULL,
	`at` integer NOT NULL,
	`pricing_version` text NOT NULL,
	`incomplete` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_owner_at` ON `usage_events` (`owner`,`at`);--> statement-breakpoint
CREATE INDEX `usage_session` ON `usage_events` (`session_id`);