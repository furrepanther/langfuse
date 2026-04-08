import { InvalidRequestError, UnauthorizedError } from "@langfuse/shared";
import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import {
  buildTraceExport,
  type TraceExportSession,
} from "@/src/features/traces/server/buildTraceExport";
import { getServerAuthSession } from "@/src/server/auth";
import { z } from "zod";

const querySchema = z.object({
  traceId: z.string().min(1),
  projectId: z.string().min(1),
});

function assertTraceExportSession(
  session: Awaited<ReturnType<typeof getServerAuthSession>>,
): asserts session is TraceExportSession {
  if (
    !session?.user ||
    typeof session.user.email !== "string" ||
    !Array.isArray(session.user.organizations)
  ) {
    throw new UnauthorizedError("Unauthorized");
  }
}

export default withMiddlewares({
  GET: async (req, res) => {
    const session = await getServerAuthSession({ req, res });
    assertTraceExportSession(session);

    const result = querySchema.safeParse({
      traceId: req.query.traceId,
      projectId: req.query.projectId,
    });

    if (!result.success) {
      throw new InvalidRequestError(result.error.message);
    }

    const payload = await buildTraceExport({
      ...result.data,
      session,
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="trace-${result.data.traceId}.json"`,
    );

    return res.status(200).send(JSON.stringify(payload, null, 2));
  },
});
