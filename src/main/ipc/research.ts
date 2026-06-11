import { ipcMain, dialog } from "electron";
import { writeFile } from "fs/promises";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { createLogger } from "../../shared/logger";
import { assertTrustedIpcSender, parseIpc } from "./common";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";
import { renderReportAsMarkdown } from "../agent/research/export";
import { isToolGated } from "../premium/manager";

const logger = createLogger("ResearchIPC");

const QuerySchema = z.string().min(1).trim();
const SupervisionModeSchema = z.enum(["walk-away", "interactive"]);
const ApproveObjectivesOptionsSchema = z.object({
  supervisionMode: SupervisionModeSchema.optional(),
  includeTraces: z.boolean().optional(),
});
const BooleanSchema = z.boolean();

export function registerResearchHandlers(
  getOrchestrator: () => ResearchOrchestrator,
): void {
  ipcMain.handle(Channels.RESEARCH_STATE_GET, (event) => {
    assertTrustedIpcSender(event);
    return getOrchestrator().getState();
  });

  ipcMain.handle(
    Channels.RESEARCH_START_BRIEF,
    async (event, query: unknown) => {
      assertTrustedIpcSender(event);
      try {
        const trimmedQuery = parseIpc(QuerySchema, query, "query");
        if (!trimmedQuery) {
          return { accepted: false, reason: "error" as const };
        }
        if (getOrchestrator().getState().phase !== "idle") {
          return { accepted: false, reason: "busy" as const };
        }
        await getOrchestrator().startBrief(trimmedQuery);
        return { accepted: true };
      } catch (err) {
        logger.error("RESEARCH_START_BRIEF failed", err);
        return { accepted: false, reason: "error" as const };
      }
    },
  );

  ipcMain.handle(Channels.RESEARCH_CONFIRM_BRIEF, (event) => {
    assertTrustedIpcSender(event);
    try {
      if (isToolGated("research_confirm_brief")) {
        return { accepted: false, reason: "premium" as const };
      }
      const orchestrator = getOrchestrator();
      if (orchestrator.getState().phase !== "briefing") {
        return { accepted: false, reason: "error" as const };
      }
      orchestrator.confirmBrief();
      return { accepted: true };
    } catch (err) {
      logger.error("RESEARCH_CONFIRM_BRIEF failed", err);
      return { accepted: false, reason: "error" as const };
    }
  });

  ipcMain.handle(
    Channels.RESEARCH_APPROVE_OBJECTIVES,
    (
      event,
      options: unknown,
    ) => {
      assertTrustedIpcSender(event);
      try {
        const validatedOptions = parseIpc(ApproveObjectivesOptionsSchema, options ?? {}, "options");
        if (isToolGated("research_approve_objectives")) {
          return { accepted: false, reason: "premium" as const };
        }
        const orchestrator = getOrchestrator();
        const state = orchestrator.getState();
        if (state.phase !== "awaiting_approval" || !state.objectives) {
          return { accepted: false, reason: "error" as const };
        }
        orchestrator.approveObjectives(
          validatedOptions.supervisionMode,
          validatedOptions.includeTraces,
        );
        // Fire off sub-agent execution in background
        orchestrator.executeSubAgents().catch((err) => {
          logger.error("Background sub-agent execution failed", err);
        });
        return { accepted: true };
      } catch (err) {
        logger.error("RESEARCH_APPROVE_OBJECTIVES failed", err);
        return { accepted: false, reason: "error" as const };
      }
    },
  );

  ipcMain.handle(
    Channels.RESEARCH_SET_MODE,
    (event, mode: unknown) => {
      assertTrustedIpcSender(event);
      const validatedMode = parseIpc(SupervisionModeSchema, mode, "mode");
      getOrchestrator().setSupervisionMode(validatedMode);
    },
  );

  ipcMain.handle(
    Channels.RESEARCH_SET_TRACES,
    (event, include: unknown) => {
      assertTrustedIpcSender(event);
      const validatedInclude = parseIpc(BooleanSchema, include, "include");
      getOrchestrator().setIncludeTraces(validatedInclude);
    },
  );

  ipcMain.handle(Channels.RESEARCH_CANCEL, (event) => {
    assertTrustedIpcSender(event);
    getOrchestrator().cancel();
  });

  ipcMain.handle(Channels.RESEARCH_STOP_AND_SYNTHESIZE, (event) => {
    assertTrustedIpcSender(event);
    getOrchestrator().stopAndSynthesizeCurrentFindings();
  });

  ipcMain.handle(Channels.RESEARCH_EXPORT_REPORT, async (event) => {
    assertTrustedIpcSender(event);
    try {
      if (isToolGated("research_export_report")) {
        return { accepted: false, reason: "premium" as const };
      }
      const state = getOrchestrator().getState();
      if (!state.report) {
        return { accepted: false, reason: "error" as const, error: "No report to export" };
      }

      const markdown = renderReportAsMarkdown(
        state.report,
        state.includeTraces ? state.subAgentTraces : undefined,
      );

      const { filePath, canceled } = await dialog.showSaveDialog({
        title: "Export Research Report",
        defaultPath: `${state.report.title.replace(/[^a-zA-Z0-9 _-]/g, "")}.md`,
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (canceled || !filePath) {
        return { accepted: false, reason: "cancelled" as const };
      }

      await writeFile(filePath, markdown, "utf-8");
      return { accepted: true, savedPath: filePath };
    } catch (err) {
      logger.error("RESEARCH_EXPORT_REPORT failed", err);
      return { accepted: false, reason: "error" as const };
    }
  });
}
