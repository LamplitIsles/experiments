DROP INDEX `sessions_thread_id_unique`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `backend` text DEFAULT 'codex' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_backend_thread` ON `sessions` (`backend`,`thread_id`);--> statement-breakpoint
UPDATE `session_config` SET `captured` = json_set(`captured`, '$.workerDefaults.backend', 'codex') WHERE json_type(`captured`, '$.workerDefaults') = 'object';--> statement-breakpoint
UPDATE `session_config` SET `captured` = json_set(`captured`, '$.reviewerSnapshot.backend', 'codex') WHERE json_type(`captured`, '$.reviewerSnapshot') = 'object';--> statement-breakpoint
UPDATE `session_config` SET `captured` = json_set(`captured`, '$.researcherSnapshot.backend', 'codex') WHERE json_type(`captured`, '$.researcherSnapshot') = 'object';
