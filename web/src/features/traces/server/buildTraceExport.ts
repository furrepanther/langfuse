import { LangfuseNotFoundError, UnauthorizedError } from "@langfuse/shared";
import {
  getTraceById,
  getScoresAndCorrectionsForTraces,
  getObservationsCountFromEventsTable,
  getObservationsForTraceFromEventsTable,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { sendAdminAccessWebhook } from "@/src/server/adminAccessWebhook";
import { TRACE_DOWNLOAD_OMIT_LARGE_FIELDS_THRESHOLD } from "../shared/traceDownloadConfig";
import { toDomainArrayWithStringifiedMetadata } from "@/src/utils/clientSideDomainTypes";

export type TraceExportSession = {
  user: {
    email: string;
    admin?: boolean;
    organizations: Array<{
      projects: Array<{
        id: string;
      }>;
    }>;
  };
};

export type TraceExportAccessSession = TraceExportSession | null;

const getDurationSeconds = (
  startTime: Date,
  endTime: Date | null,
): number | null => {
  if (!endTime) {
    return null;
  }

  return (endTime.getTime() - startTime.getTime()) / 1000;
};

const hasProjectAccess = (
  session: TraceExportAccessSession,
  projectId: string,
) =>
  session?.user.organizations.some((organization) =>
    organization.projects.some((project) => project.id === projectId),
  ) ?? false;

const getObservationRecordsForTrace = async (params: {
  traceId: string;
  projectId: string;
  omitLargeFields: boolean;
}) => {
  const { traceId, projectId, omitLargeFields } = params;

  return getObservationsForTraceFromEventsTable({
    traceId,
    projectId,
    selectIOAndMetadata: !omitLargeFields,
    selectToolData: !omitLargeFields,
  });
};

const getObservationRecordCountForTrace = async (params: {
  traceId: string;
  projectId: string;
}) => {
  const { traceId, projectId } = params;

  return getObservationsCountFromEventsTable({
    projectId,
    filter: [
      { type: "string", operator: "=", column: "traceId", value: traceId },
    ],
  });
};

async function getAuthorizedTrace(params: {
  traceId: string;
  projectId: string;
  session: TraceExportAccessSession;
}) {
  const { traceId, projectId, session } = params;

  const clickhouseTrace = await getTraceById({
    traceId,
    projectId,
    renderingProps: {
      truncated: false,
      shouldJsonParse: false,
    },
    clickhouseFeatureTag: "tracing-download",
    excludeInputOutput: true,
    excludeMetadata: true,
  });

  if (!clickhouseTrace) {
    throw new LangfuseNotFoundError("Trace not found");
  }

  const traceSession = clickhouseTrace.sessionId
    ? await prisma.traceSession.findFirst({
        where: {
          id: clickhouseTrace.sessionId,
          projectId,
        },
        select: {
          public: true,
        },
      })
    : null;

  const isSessionPublic = traceSession?.public === true;
  const isAdmin = session?.user.admin === true;
  const canReadTrace =
    clickhouseTrace.public ||
    isSessionPublic ||
    isAdmin ||
    hasProjectAccess(session, projectId);

  if (!canReadTrace) {
    throw new UnauthorizedError(
      "User is not a member of this project and this trace is not public",
    );
  }

  if (isAdmin) {
    await sendAdminAccessWebhook({
      email: session.user.email,
      projectId,
    });
  }

  return clickhouseTrace;
}

export async function buildTraceExport({
  traceId,
  projectId,
  session,
}: {
  traceId: string;
  projectId: string;
  session: TraceExportAccessSession;
}) {
  const trace = await getAuthorizedTrace({
    traceId,
    projectId,
    session,
  });

  const observationRecordCount = await getObservationRecordCountForTrace({
    traceId,
    projectId,
  });
  const omitLargeFields =
    observationRecordCount >= TRACE_DOWNLOAD_OMIT_LARGE_FIELDS_THRESHOLD;
  const { observations: observationRecords } =
    await getObservationRecordsForTrace({
      traceId,
      projectId,
      omitLargeFields,
    });

  const scoreRecords = await getScoresAndCorrectionsForTraces({
    projectId,
    traceIds: [traceId],
    timestamp: trace.timestamp,
  });

  const scores = toDomainArrayWithStringifiedMetadata(scoreRecords).map(
    (score) => ({
      ...score,
      stringValue: score.stringValue ?? null,
      metadata: score.metadata ?? null,
      createdAt: score.createdAt.toISOString(),
      updatedAt: score.updatedAt.toISOString(),
      timestamp: score.timestamp.toISOString(),
    }),
  );

  const observations = observationRecords.map((record) => {
    return {
      id: record.id,
      traceId: record.traceId ?? traceId,
      userId: record.userId ?? null,
      sessionId: record.sessionId ?? null,
      projectId: record.projectId,
      startTime: record.startTime.toISOString(),
      endTime: record.endTime?.toISOString() ?? null,
      parentObservationId: record.parentObservationId ?? null,
      type: record.type,
      environment: record.environment,
      name: record.name ?? null,
      level: record.level ?? null,
      traceName: record.traceName ?? trace.name ?? "",
      statusMessage: record.statusMessage ?? null,
      version: record.version ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      model: record.model ?? null,
      modelParameters: record.modelParameters
        ? JSON.stringify(record.modelParameters)
        : null,
      internalModelId: record.internalModelId ?? null,
      completionStartTime: record.completionStartTime?.toISOString() ?? null,
      promptId: record.promptId ?? null,
      promptName: record.promptName ?? null,
      promptVersion: record.promptVersion ?? null,
      providedUsageDetails: record.providedUsageDetails,
      latency: getDurationSeconds(record.startTime, record.endTime),
      timeToFirstToken: getDurationSeconds(
        record.startTime,
        record.completionStartTime,
      ),
      usageDetails: record.usageDetails,
      costDetails: record.costDetails,
      providedCostDetails: record.providedCostDetails,
      usagePricingTierId: record.usagePricingTierId ?? null,
      usagePricingTierName: record.usagePricingTierName ?? null,
      toolCallNames: record.toolCallNames ?? [],
      tags: trace.tags,
      bookmarked: trace.bookmarked,
      public: trace.public,
      ...(!omitLargeFields
        ? {
            toolDefinitions: record.toolDefinitions ?? {},
            toolCalls: record.toolCalls ?? [],
            input: record.input ? JSON.stringify(record.input) : null,
            output: record.output ? JSON.stringify(record.output) : null,
            metadata: JSON.stringify(record.metadata ?? {}),
          }
        : {}),
    };
  });

  return {
    observations,
    scores,
  };
}
