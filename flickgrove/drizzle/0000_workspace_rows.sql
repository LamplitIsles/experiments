CREATE TABLE `deliveries` (
	`session_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`attempt_id` text,
	`turn_id` text,
	`at` integer NOT NULL,
	`error` text,
	`images` text,
	`report` text NOT NULL,
	PRIMARY KEY(`session_id`, `operation_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_status` ON `deliveries` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `deliveries_order` ON `deliveries` (`session_id`,`position`);--> statement-breakpoint
CREATE TABLE `delivery_questions` (
	`session_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`answer` text,
	PRIMARY KEY(`session_id`, `operation_id`, `position`),
	FOREIGN KEY (`session_id`,`operation_id`) REFERENCES `deliveries`(`session_id`,`operation_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`,`question_id`) REFERENCES `questions`(`session_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`position` integer NOT NULL,
	`item_id` text NOT NULL,
	`item_index` integer NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`options` text NOT NULL,
	`state` text NOT NULL,
	`answer` text,
	`at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `questions_item` ON `questions` (`session_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `questions_state` ON `questions` (`session_id`,`state`);--> statement-breakpoint
CREATE TABLE `session_config` (
	`session_id` text PRIMARY KEY NOT NULL,
	`captured` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`owner_id` text,
	`thread_id` text,
	`title` text NOT NULL,
	`token` text NOT NULL,
	`closed` integer NOT NULL,
	`state` text NOT NULL,
	`project` text NOT NULL,
	`settings` text NOT NULL,
	`recovery` text NOT NULL,
	`task` text NOT NULL,
	`diagnostics` text NOT NULL,
	`tree_fast` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_thread_id_unique` ON `sessions` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_open` ON `sessions` (`closed`);--> statement-breakpoint
CREATE INDEX `sessions_owner` ON `sessions` (`owner_id`);
--> statement-breakpoint
-- One-time conversion. An empty legacy table also makes a fresh install valid.
CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
--> statement-breakpoint
-- Fail closed on malformed legacy containers instead of dropping unreadable data.
CREATE TEMP TABLE legacy_shape_guard (valid INTEGER NOT NULL CHECK(valid=1));
--> statement-breakpoint
INSERT INTO legacy_shape_guard SELECT CASE WHEN json_valid(value) AND json_type(value,'$.agents')='array' THEN 1 ELSE 0 END FROM workspace;
--> statement-breakpoint
DROP TABLE legacy_shape_guard;
--> statement-breakpoint
INSERT INTO sessions (id,role,owner_id,thread_id,title,token,closed,state,project,settings,recovery,task,diagnostics,tree_fast)
SELECT json_extract(a.value,'$.id'),json_extract(a.value,'$.role'),json_extract(a.value,'$.ownerId'),json_extract(a.value,'$.threadId'),json_extract(a.value,'$.title'),json_extract(a.value,'$.token'),json_extract(a.value,'$.closed'),json_extract(a.value,'$.state'),json_extract(a.value,'$.project'),json_object('model',json_extract(a.value,'$.model'),'effort',json_extract(a.value,'$.effort'),'serviceTier',json_extract(a.value,'$.serviceTier')),json_object('turnId',json_extract(a.value,'$.turnId'),'turnEnded',json(CASE json_extract(a.value,'$.turnEnded') WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE 'null' END),'stop',json_extract(a.value,'$.stop'),'closeRequest',json_extract(a.value,'$.closeRequest')),json_object('reviewTarget',json_extract(a.value,'$.reviewTarget'),'researchQuestion',json_extract(a.value,'$.researchQuestion')),json_object('error',json_extract(a.value,'$.error'),'execution',json_extract(a.value,'$.execution'),'treeFastError',json_extract(a.value,'$.treeFastError')),json_extract(a.value,'$.treeFast') FROM workspace w, json_each(w.value,'$.agents') a;
--> statement-breakpoint
INSERT INTO session_config SELECT json_extract(a.value,'$.id'),json_object('orcPromptSnapshot',json_extract(a.value,'$.orcPromptSnapshot'),'reviewerSnapshot',json_extract(a.value,'$.reviewerSnapshot'),'researcherSnapshot',json_extract(a.value,'$.researcherSnapshot'),'workerDefaults',json_extract(a.value,'$.workerDefaults')) FROM workspace w,json_each(w.value,'$.agents') a;
--> statement-breakpoint
INSERT INTO deliveries (session_id,operation_id,position,text,source,status,attempt_id,turn_id,at,error,images,report)
SELECT json_extract(a.value,'$.id'),json_extract(d.value,'$.id'),CAST(d.key AS INTEGER),json_extract(d.value,'$.text'),json_extract(d.value,'$.source'),json_extract(d.value,'$.status'),json_extract(d.value,'$.attemptId'),json_extract(d.value,'$.turnId'),json_extract(d.value,'$.at'),json_extract(d.value,'$.error'),json_extract(d.value,'$.images'),json_object('reportingWorkerId',json_extract(d.value,'$.reportingWorkerId'),'reportingReviewerId',json_extract(d.value,'$.reportingReviewerId'),'reportingResearcherId',json_extract(d.value,'$.reportingResearcherId'),'reviewTarget',json_extract(d.value,'$.reviewTarget'),'researchQuestion',json_extract(d.value,'$.researchQuestion')) FROM workspace w,json_each(w.value,'$.agents') a,json_each(a.value,'$.deliveries') d;
--> statement-breakpoint
INSERT INTO questions SELECT json_extract(a.value,'$.id'),json_extract(q.value,'$.id'),CAST(q.key AS INTEGER),json_extract(q.value,'$.itemId'),json_extract(q.value,'$.index'),json_extract(q.value,'$.title'),json_extract(q.value,'$.text'),json_extract(q.value,'$.options'),json_extract(q.value,'$.state'),json_extract(q.value,'$.answer'),json_extract(q.value,'$.at') FROM workspace w,json_each(w.value,'$.agents') a,json_each(a.value,'$.questions') q;
--> statement-breakpoint
INSERT INTO delivery_questions SELECT json_extract(a.value,'$.id'),json_extract(d.value,'$.id'),q.value,CAST(q.key AS INTEGER),(SELECT json_extract(ans.value,'$.answer') FROM json_each(d.value,'$.answers') ans WHERE json_extract(ans.value,'$.questionId')=q.value) FROM workspace w,json_each(w.value,'$.agents') a,json_each(a.value,'$.deliveries') d,json_each(d.value,'$.questionIds') q;
--> statement-breakpoint
DROP TABLE workspace;
