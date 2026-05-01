import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { createLogger } from "../../shared/logger";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";
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
      if (isToolGated("research_start")) {
        return { accepted: false, reason: "premium" as const };
      }
      await getOrchestrator().startBrief(query);
      return { accepted: true };
    },
  );

  ipcMain.handle(Channels.RESEARCH_CONFIRM_BRIEF, () => {
    getOrchestrator().confirmBrief();
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
    if (isToolGated("research_export_report")) {
      return { accepted: false, reason: "premium" as const };
    }
    const state = getOrchestrator().getState();
    return {
      accepted: true,
      report: state.report,
      format: "markdown" as const,
    };
  });
}
