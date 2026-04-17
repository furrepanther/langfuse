import type {
  EvalTemplate,
  JobConfiguration,
  Prisma as PrismaNamespace,
  prisma,
} from "@langfuse/shared/src/db";
import type {
  PublicContinuousEvaluationEvaluatorReferenceType,
  PublicContinuousEvaluationEvaluatorType,
  PublicContinuousEvaluationFilterType,
  PublicContinuousEvaluationMappingType,
  PublicContinuousEvaluationStatusType,
  PublicContinuousEvaluationTargetType,
  PublicEvaluatorModelConfigType,
  PublicEvaluatorOutputDefinitionType,
  PublicEvaluatorScopeType,
} from "@/src/features/public-api/types/unstable-public-evals-contract";

export type PrismaClientLike =
  | typeof prisma
  | PrismaNamespace.TransactionClient;

export type ApiEvaluatorRecord = {
  id: string;
  name: string;
  version: number;
  scope: PublicEvaluatorScopeType;
  type: "llm_as_judge";
  prompt: string;
  variables: string[];
  outputDefinition: PublicEvaluatorOutputDefinitionType;
  modelConfig: PublicEvaluatorModelConfigType | null;
  continuousEvaluationCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ApiContinuousEvaluationRecord = {
  id: string;
  name: string;
  evaluator: PublicContinuousEvaluationEvaluatorType;
  target: PublicContinuousEvaluationTargetType;
  enabled: boolean;
  status: PublicContinuousEvaluationStatusType;
  pausedReason: string | null;
  pausedMessage: string | null;
  sampling: number;
  filter: PublicContinuousEvaluationFilterType[];
  mapping: PublicContinuousEvaluationMappingType[];
  createdAt: Date;
  updatedAt: Date;
};

export type ContinuousEvaluationEvaluatorFamilyReference =
  PublicContinuousEvaluationEvaluatorReferenceType;

export type StoredPublicEvaluatorTemplate = Pick<
  EvalTemplate,
  | "id"
  | "projectId"
  | "name"
  | "version"
  | "prompt"
  | "partner"
  | "provider"
  | "model"
  | "modelParams"
  | "vars"
  | "outputDefinition"
  | "createdAt"
  | "updatedAt"
>;

export type StoredPublicContinuousEvaluationConfig = Pick<
  JobConfiguration,
  | "id"
  | "projectId"
  | "evalTemplateId"
  | "scoreName"
  | "targetObject"
  | "filter"
  | "variableMapping"
  | "sampling"
  | "status"
  | "blockedAt"
  | "blockReason"
  | "blockMessage"
  | "createdAt"
  | "updatedAt"
> & {
  evalTemplate: Pick<
    EvalTemplate,
    "id" | "projectId" | "name" | "vars" | "prompt"
  > | null;
};
