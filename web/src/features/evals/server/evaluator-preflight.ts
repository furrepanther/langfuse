import {
  compilePersistedEvalOutputDefinition,
  PersistedEvalOutputDefinitionSchema,
} from "@langfuse/shared";
import {
  DefaultEvalModelService,
  testModelCall,
} from "@langfuse/shared/src/server";

export type EvaluatorPreflightDefinition = {
  name: string;
  provider?: string | null;
  model?: string | null;
  modelParams?: unknown;
  outputDefinition: unknown;
};

export async function getEvaluatorDefinitionPreflightError(params: {
  projectId: string;
  template: EvaluatorPreflightDefinition;
}): Promise<string | null> {
  const modelConfig = await DefaultEvalModelService.fetchValidModelConfig(
    params.projectId,
    params.template.provider ?? undefined,
    params.template.model ?? undefined,
    params.template.modelParams,
  );

  if (!modelConfig.valid) {
    return `No valid LLM model found for evaluator "${params.template.name}". ${modelConfig.error}`;
  }

  try {
    const parsedOutputDefinition = PersistedEvalOutputDefinitionSchema.parse(
      params.template.outputDefinition,
    );
    const compiledOutputDefinition = compilePersistedEvalOutputDefinition(
      parsedOutputDefinition,
    );

    await testModelCall({
      provider: modelConfig.config.provider,
      model: modelConfig.config.model,
      apiKey: modelConfig.config.apiKey,
      modelConfig: modelConfig.config.modelParams,
      structuredOutputSchema: compiledOutputDefinition.outputResultSchema,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return `Model configuration not valid for evaluator "${params.template.name}". ${message}`;
  }

  return null;
}
