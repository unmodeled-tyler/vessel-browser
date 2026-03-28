import type {
  AutomationActivityEntry,
  AutomationActivityStatus,
} from "../../../shared/types";

export const MAX_AUTOMATION_ACTIVITY_ENTRIES = 8;

function trimActivities(
  entries: AutomationActivityEntry[],
  limit = MAX_AUTOMATION_ACTIVITY_ENTRIES,
): AutomationActivityEntry[] {
  return entries.length > limit ? entries.slice(0, limit) : entries;
}

export function startAutomationActivity(
  entries: AutomationActivityEntry[],
  activity: Omit<AutomationActivityEntry, "output"> & { output?: string },
): AutomationActivityEntry[] {
  const next = [
    {
      ...activity,
      output: activity.output ?? "",
    },
    ...entries.filter((entry) => entry.id !== activity.id),
  ];
  return trimActivities(next);
}

export function appendAutomationActivityChunk(
  entries: AutomationActivityEntry[],
  id: string,
  chunk: string,
): AutomationActivityEntry[] {
  return entries.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          output: entry.output + chunk,
        }
      : entry,
  );
}

export function finishAutomationActivity(
  entries: AutomationActivityEntry[],
  id: string,
  status: AutomationActivityStatus,
  finishedAt: string,
): AutomationActivityEntry[] {
  return entries.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          status,
          finishedAt,
        }
      : entry,
  );
}
