import { z } from "zod";
import {
  ExperimentContinuousEvaluationFilter,
  ExperimentContinuousEvaluationMapping,
  ObservationContinuousEvaluationFilter,
  ObservationContinuousEvaluationMapping,
  PublicContinuousEvaluationFilter,
  PublicContinuousEvaluationEvaluator,
  PublicContinuousEvaluationEvaluatorReference,
  PublicContinuousEvaluationMapping,
  PublicContinuousEvaluationStatus,
  PublicContinuousEvaluationTarget,
  UnstablePublicApiPaginationQuery,
  UnstablePublicApiPaginationResponse,
} from "@/src/features/public-api/types/unstable-public-evals-contract";

export const APIContinuousEvaluation = z
  .object({
    id: z.string(),
    name: z.string(),
    evaluator: PublicContinuousEvaluationEvaluator,
    target: PublicContinuousEvaluationTarget,
    enabled: z.boolean(),
    status: PublicContinuousEvaluationStatus,
    pausedReason: z.string().nullable(),
    pausedMessage: z.string().nullable(),
    sampling: z.number().gt(0).lte(1),
    filter: z.array(PublicContinuousEvaluationFilter),
    mapping: z.array(PublicContinuousEvaluationMapping),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();

export const GetUnstableContinuousEvaluationsQuery =
  UnstablePublicApiPaginationQuery;

export const GetUnstableContinuousEvaluationsResponse = z
  .object({
    data: z.array(APIContinuousEvaluation),
    meta: UnstablePublicApiPaginationResponse,
  })
  .strict();

export const GetUnstableContinuousEvaluationQuery = z.object({
  continuousEvaluationId: z.string(),
});

export const GetUnstableContinuousEvaluationResponse = APIContinuousEvaluation;

const ContinuousEvaluationCreateBase = {
  name: z.string().min(1),
  evaluator: PublicContinuousEvaluationEvaluatorReference,
  enabled: z.boolean(),
  sampling: z.number().gt(0).lte(1).default(1),
};

export const PostUnstableContinuousEvaluationBody = z.discriminatedUnion(
  "target",
  [
    z.object({
      ...ContinuousEvaluationCreateBase,
      target: z.literal("observation"),
      filter: z.array(ObservationContinuousEvaluationFilter).default([]),
      mapping: z.array(ObservationContinuousEvaluationMapping),
    }),
    z.object({
      ...ContinuousEvaluationCreateBase,
      target: z.literal("experiment"),
      filter: z.array(ExperimentContinuousEvaluationFilter).default([]),
      mapping: z.array(ExperimentContinuousEvaluationMapping),
    }),
  ],
);
export type PostUnstableContinuousEvaluationBodyType = z.infer<
  typeof PostUnstableContinuousEvaluationBody
>;

export const PostUnstableContinuousEvaluationResponse = APIContinuousEvaluation;

export const PatchUnstableContinuousEvaluationQuery =
  GetUnstableContinuousEvaluationQuery;

const ContinuousEvaluationPatchBase = {
  name: z.string().min(1).optional(),
  evaluator: PublicContinuousEvaluationEvaluatorReference.optional(),
  enabled: z.boolean().optional(),
  sampling: z.number().gt(0).lte(1).optional(),
};

const UntargetedContinuousEvaluationPatch = z.object({
  ...ContinuousEvaluationPatchBase,
  target: z.undefined().optional(),
  filter: z.undefined().optional(),
  mapping: z.undefined().optional(),
});

const ObservationContinuousEvaluationPatch = z.object({
  ...ContinuousEvaluationPatchBase,
  target: z.literal("observation"),
  filter: z.array(ObservationContinuousEvaluationFilter).optional(),
  mapping: z.array(ObservationContinuousEvaluationMapping).optional(),
});

const ExperimentContinuousEvaluationPatch = z.object({
  ...ContinuousEvaluationPatchBase,
  target: z.literal("experiment"),
  filter: z.array(ExperimentContinuousEvaluationFilter).optional(),
  mapping: z.array(ExperimentContinuousEvaluationMapping).optional(),
});

export const PatchUnstableContinuousEvaluationBody = z
  .union([
    ObservationContinuousEvaluationPatch,
    ExperimentContinuousEvaluationPatch,
    UntargetedContinuousEvaluationPatch,
  ])
  .refine((data) => Object.keys(data).length > 0, {
    message:
      "Request body cannot be empty. At least one field must be provided for update.",
  });
export type PatchUnstableContinuousEvaluationBodyType = z.infer<
  typeof PatchUnstableContinuousEvaluationBody
>;

export const PatchUnstableContinuousEvaluationResponse =
  APIContinuousEvaluation;

export const DeleteUnstableContinuousEvaluationQuery =
  GetUnstableContinuousEvaluationQuery;

export const DeleteUnstableContinuousEvaluationResponse = z
  .object({
    message: z.literal("Continuous evaluation successfully deleted"),
  })
  .strict();
