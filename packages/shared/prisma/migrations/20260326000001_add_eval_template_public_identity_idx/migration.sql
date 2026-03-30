-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "eval_templates_project_id_evaluator_id_idx"
ON "eval_templates"("project_id", "evaluator_id");
