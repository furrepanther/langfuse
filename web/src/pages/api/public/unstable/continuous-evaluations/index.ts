import { auditLog } from "@/src/features/audit-logs/auditLog";
import {
  createPublicContinuousEvaluation,
  listPublicContinuousEvaluations,
} from "@/src/features/evals/server/unstable-public-api";
import {
  createUnstablePublicEvalsRoute,
  withUnstablePublicEvalsMiddlewares,
} from "@/src/features/public-api/server/unstable-public-evals-route";
import {
  GetUnstableContinuousEvaluationsQuery,
  GetUnstableContinuousEvaluationsResponse,
  PostUnstableContinuousEvaluationBody,
  PostUnstableContinuousEvaluationResponse,
} from "@/src/features/public-api/types/unstable-continuous-evaluations";

export default withUnstablePublicEvalsMiddlewares({
  GET: createUnstablePublicEvalsRoute({
    name: "List Unstable Continuous Evaluations",
    querySchema: GetUnstableContinuousEvaluationsQuery,
    responseSchema: GetUnstableContinuousEvaluationsResponse,
    fn: async ({ query, auth }) =>
      listPublicContinuousEvaluations({
        projectId: auth.scope.projectId,
        page: query.page,
        limit: query.limit,
      }),
  }),
  POST: createUnstablePublicEvalsRoute({
    name: "Create Unstable Continuous Evaluation",
    bodySchema: PostUnstableContinuousEvaluationBody,
    responseSchema: PostUnstableContinuousEvaluationResponse,
    fn: async ({ body, auth }) => {
      const continuousEvaluation = await createPublicContinuousEvaluation({
        projectId: auth.scope.projectId,
        input: body,
      });

      await auditLog({
        action: "create",
        resourceType: "job",
        resourceId: continuousEvaluation.id,
        projectId: auth.scope.projectId,
        orgId: auth.scope.orgId,
        apiKeyId: auth.scope.apiKeyId,
        after: continuousEvaluation,
      });

      return continuousEvaluation;
    },
  }),
});
