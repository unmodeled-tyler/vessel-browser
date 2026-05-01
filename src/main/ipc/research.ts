import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { createLogger } from "../../shared/logger";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";
import { renderReportAsMarkdown } from "../agent/research/export";
import { isToolGated } from "../premium/manager";

const logger = createLogger("ResearchIPC");

export function registerResearchHandlers(
  getOrchestrator: () => ResearchOrchestrator,
): void {
  ipcMain.handle(Channels.RESEARCH_STATE_GET, () => {
    return getOrchestrator().getState();
  });

  ipcMain.handle(
    Channels.RESEARCH_START_BRIEF,
    async (_event, query: string) => {
      try {
        if (getOrchestrator().getState().phase !== "idle") {
          return { accepted: false, reason: "busy" as const };
        }
        await getOrchestrator().startBrief(query);
        return { accepted: true };
      } catch (err) {
        logger.error("RESEARCH_START_BRIEF failed", err);
        return { accepted: false, reason: "error" as const };
      }
    },
  );

  ipcMain.handle(Channels.RESEARCH_CONFIRM_BRIEF, () => {
    if (isToolGated("research_confirm_brief")) {
      return { accepted: false, reason: "premium" as const };
    }
    getOrchestrator().confirmBrief();
    return { accepted: true };
  });

  ipcMain.handle(
    Channels.RESEARCH_APPROVE_OBJECTIVES,
    (
      _event,
      options: {
        supervisionMode?: "walk-away" | "interactive";
        includeTraces?: boolean;
      },
    ) => {
      try {
        if (isToolGated("research_approve_objectives")) {
          return { accepted: false, reason: "premium" as const };
        }
        getOrchestrator().approveObjectives(
          options.supervisionMode,
          options.includeTraces,
        );
        // Fire off sub-agent execution in background
        getOrchestrator().executeSubAgents().catch((err) => {
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
    (_event, mode: "walk-away" | "interactive") => {
      getOrchestrator().setSupervisionMode(mode);
    },
  );

  ipcMain.handle(
    Channels.RESEARCH_SET_TRACES,
    (_event, include: boolean) => {
      getOrchestrator().setIncludeTraces(include);
    },
  );

  ipcMain.handle(Channels.RESEARCH_CANCEL, () => {
    getOrchestrator().cancel();
  });

  ipcMain.handle(Channels.RESEARCH_EXPORT_REPORT, () => {
    try {
      if (isToolGated("research_export_report")) {
        return { accepted: false, reason: "premium" as const };
      }
      const state = getOrchestrator().getState();
      return {
        accepted: true,
        report: state.report
          ? renderReportAsMarkdown(
              state.report,
              state.includeTraces ? state.subAgentTraces : undefined,
            )
          : null,
        format: "markdown" as const,
      };
    } catch (err) {
      logger.error("RESEARCH_EXPORT_REPORT failed", err);
      return { accepted: false, reason: "error" as const };
    }
  });
}
