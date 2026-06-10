import {
  createResource,
  createSignal,
  For,
  Show,
  createMemo,
  onMount,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";
import {
  BookOpen,
  Tag,
  ClipboardList,
  Search,
  Globe,
  Download,
  Star,
  Zap,
  Clock,
  ChevronRight,
  Eye,
  Pencil,
  Plus,
  Trash2,
  Upload,
  type IconProps,
} from "lucide-solid";
import { BUNDLED_KIT_IDS } from "../../../../shared/automation-kit-constants";
import { useAI } from "../../stores/ai";
import { useUI } from "../../stores/ui";
import { BUNDLED_KITS, renderKitPrompt } from "../../lib/automation-kits";
import { isPremiumStatus } from "../../lib/premium";
import type {
  AutomationActivityEntry,
  AutomationKit,
  ScheduleConfig,
  ScheduledJob,
  ScheduleType,
} from "../../../../shared/types";

type LucideComponent = (props: IconProps) => JSX.Element;

const ICON_MAP: Record<string, LucideComponent> = {
  BookOpen,
  Tag,
  ClipboardList,
  Search,
  Globe,
  Download,
  Star,
  Zap,
  Clock,
};

const KitIcon = (props: { name: string; size?: number; class?: string }) => {
  const Icon = ICON_MAP[props.name] ?? Zap;
  return <Icon size={props.size ?? 18} class={props.class} />;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatScheduleLabel(job: ScheduledJob): string {
  const { schedule } = job;
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (schedule.type) {
    case "once":
      return `Once · ${new Date(schedule.runAt!).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    case "hourly":
      return "Every hour";
    case "daily":
      return `Daily at ${pad(schedule.hour!)}:${pad(schedule.minute!)}`;
    case "weekly":
      return `${DAY_NAMES[schedule.dayOfWeek!]}s at ${pad(schedule.hour!)}:${pad(schedule.minute!)}`;
  }
}

function formatNextRun(isoStr: string): string {
  return new Date(isoStr).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatActivityTime(isoStr: string): string {
  return new Date(isoStr).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatActivityStatus(activity: AutomationActivityEntry): string {
  if (activity.status === "running") return "Running";
  if (activity.status === "failed") return "Failed";
  return "Completed";
}

function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function createSkillId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `custom-${slug}` : `custom-skill-${Date.now()}`;
}

const SIMPLE_TASK_PROMPT_SUFFIX = "\n\nTask:\n{{task}}";

function isSimpleTaskSkill(kit: AutomationKit): boolean {
  return (
    kit.inputs.length === 1 &&
    kit.inputs[0]?.key === "task" &&
    kit.inputs[0]?.type === "textarea"
  );
}

function getEditableInstructions(kit: AutomationKit): string {
  if (isSimpleTaskSkill(kit) && kit.promptTemplate.endsWith(SIMPLE_TASK_PROMPT_SUFFIX)) {
    return kit.promptTemplate.slice(0, -SIMPLE_TASK_PROMPT_SUFFIX.length);
  }
  return kit.promptTemplate;
}

function buildSkillDraft(
  name: string,
  description: string,
  instructions: string,
  existing?: AutomationKit,
): AutomationKit {
  const simpleTaskSkill = !existing || isSimpleTaskSkill(existing);
  return {
    id: existing?.id ?? createSkillId(name),
    name,
    description: description || "Custom agent skill.",
    category: existing?.category ?? "productivity",
    icon: existing?.icon ?? "Zap",
    estimatedMinutes: existing?.estimatedMinutes ?? 3,
    inputs: simpleTaskSkill
      ? [
          {
            key: "task",
            label: "Task",
            type: "textarea",
            placeholder: "What should the agent do with this skill?",
            required: true,
          },
        ]
      : existing.inputs,
    promptTemplate: simpleTaskSkill
      ? `${instructions}${SIMPLE_TASK_PROMPT_SUFFIX}`
      : instructions,
  };
}

interface AutomationTabProps {
  /** Called after launching a skill so the parent can switch to the supervisor tab */
  onRun: () => void;
}

const AutomationTab: Component<AutomationTabProps> = (props) => {
  const { runAutomationPrompt, isStreaming, automationActivities } = useAI();
  const { openSettings } = useUI();
  const [selectedKit, setSelectedKit] = createSignal<AutomationKit | null>(null);
  const [fieldValues, setFieldValues] = createSignal<Record<string, string>>({});
  const [installError, setInstallError] = createSignal<string | null>(null);
  const [createEditorOpen, setCreateEditorOpen] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createDescription, setCreateDescription] = createSignal("");
  const [createInstructions, setCreateInstructions] = createSignal("");
  const [createError, setCreateError] = createSignal<string | null>(null);
  const [savingSkill, setSavingSkill] = createSignal(false);
  const [editingSkill, setEditingSkill] = createSignal<AutomationKit | null>(null);

  // Schedule form state
  const [scheduleEnabled, setScheduleEnabled] = createSignal(false);
  const [schedType, setSchedType] = createSignal<ScheduleType>("daily");
  const [schedHour, setSchedHour] = createSignal(9);
  const [schedMinute, setSchedMinute] = createSignal(0);
  const [schedDayOfWeek, setSchedDayOfWeek] = createSignal(1);
  const [schedRunAt, setSchedRunAt] = createSignal("");
  const [scheduleError, setScheduleError] = createSignal<string | null>(null);

  // Scheduled jobs
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>([]);

  // Context menu state — tracks which job's menu is open by id
  const [openMenuJobId, setOpenMenuJobId] = createSignal<string | null>(null);

  // Tracks a job being fully re-edited (task fields + schedule); null = creating new
  const [editingTaskJobId, setEditingTaskJobId] = createSignal<string | null>(null);

  // Edit schedule modal state
  const [editingJob, setEditingJob] = createSignal<ScheduledJob | null>(null);
  const [editType, setEditType] = createSignal<ScheduleType>("daily");
  const [editHour, setEditHour] = createSignal(9);
  const [editMinute, setEditMinute] = createSignal(0);
  const [editDayOfWeek, setEditDayOfWeek] = createSignal(1);
  const [editRunAt, setEditRunAt] = createSignal("");
  const [editError, setEditError] = createSignal<string | null>(null);

  onMount(() => {
    void window.vessel.schedule.getAll().then(setScheduledJobs);
    const cleanup = window.vessel.schedule.onJobsUpdate(setScheduledJobs);
    onCleanup(cleanup);

    const closeMenu = () => setOpenMenuJobId(null);
    document.addEventListener("click", closeMenu);
    onCleanup(() => document.removeEventListener("click", closeMenu));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenMenuJobId(null);
        setEditingJob(null);
        closeCreateEditor();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  const [premiumData] = createResource(() =>
    window.vessel.premium.getState().catch(() => ({ status: "free" as const })),
  );

  const isPremium = () => isPremiumStatus(premiumData()?.status);

  const [installedKits, { refetch: refetchInstalled }] = createResource(
    () => isPremium(),
    (active) =>
      active
        ? window.vessel.automation.getInstalled().catch(() => [])
        : Promise.resolve([]),
  );

  const allKits = createMemo(() => [
    ...BUNDLED_KITS,
    ...(installedKits() ?? []),
  ]);

  const selectKit = (kit: AutomationKit) => {
    const defaults: Record<string, string> = {};
    for (const input of kit.inputs) {
      defaults[input.key] = input.defaultValue ?? "";
    }
    setFieldValues(defaults);
    setSelectedKit(kit);
    setScheduleEnabled(false);
    setSchedType("daily");
    setSchedHour(9);
    setSchedMinute(0);
    setSchedDayOfWeek(1);
    setSchedRunAt("");
    setScheduleError(null);
    setEditingTaskJobId(null);
  };

  const setField = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const requiredFieldsFilled = () => {
    const kit = selectedKit();
    if (!kit) return false;
    return kit.inputs
      .filter((i) => i.required)
      .every((i) => fieldValues()[i.key]?.trim());
  };

  const canRun = () => !selectedKit() || isStreaming() ? false : requiredFieldsFilled();

  const canSchedule = () => {
    if (!selectedKit() || !scheduleEnabled()) return false;
    if (!requiredFieldsFilled()) return false;
    if (schedType() === "once" && !schedRunAt()) return false;
    return true;
  };

  const handleRun = async () => {
    const kit = selectedKit();
    if (!kit || !canRun()) return;
    const prompt = renderKitPrompt(kit, fieldValues());
    const activityId = `adhoc:${kit.id}:${Date.now()}`;
    const result = await runAutomationPrompt(prompt, {
      id: activityId,
      title: kit.name,
      icon: kit.icon,
    });
    if (result === "rejected") return;
    setSelectedKit(null);
    props.onRun();
  };

  const handleSchedule = async () => {
    const kit = selectedKit();
    if (!kit || !canSchedule()) return;
    setScheduleError(null);

    const prompt = renderKitPrompt(kit, fieldValues());

    const schedule: ScheduleConfig = { type: schedType() };
    if (schedType() === "once") {
      const d = new Date(schedRunAt());
      if (isNaN(d.getTime())) {
        setScheduleError("Please enter a valid date and time.");
        return;
      }
      if (d <= new Date()) {
        setScheduleError("Scheduled time must be in the future.");
        return;
      }
      schedule.runAt = d.toISOString();
    } else if (schedType() === "daily" || schedType() === "weekly") {
      schedule.hour = schedHour();
      schedule.minute = schedMinute();
      if (schedType() === "weekly") schedule.dayOfWeek = schedDayOfWeek();
    }

    try {
      const existingId = editingTaskJobId();
      if (existingId) {
        await window.vessel.schedule.update(existingId, {
          renderedPrompt: prompt,
          fieldValues: fieldValues(),
          schedule,
        });
        setEditingTaskJobId(null);
      } else {
        await window.vessel.schedule.create({
          kitId: kit.id,
          kitName: kit.name,
          kitIcon: kit.icon,
          renderedPrompt: prompt,
          fieldValues: fieldValues(),
          schedule,
          enabled: true,
        });
      }
      setSelectedKit(null);
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : "Failed to save schedule.");
    }
  };

  const handleInstall = async () => {
    setInstallError(null);
    setCreateError(null);
    const result = await window.vessel.automation.installFromFile();
    if (!result.ok) {
      if (result.error !== "canceled") {
        setInstallError(result.error ?? "Installation failed.");
      }
      return;
    }
    void refetchInstalled();
  };

  const openCreateEditor = () => {
    setInstallError(null);
    setCreateError(null);
    setSavingSkill(false);
    setEditingSkill(null);
    setCreateName("");
    setCreateDescription("");
    setCreateInstructions("");
    setCreateEditorOpen(true);
  };

  const closeCreateEditor = () => {
    setCreateEditorOpen(false);
    setCreateError(null);
    setSavingSkill(false);
    setEditingSkill(null);
  };

  const clearCreateDraft = () => {
    setCreateName("");
    setCreateDescription("");
    setCreateInstructions("");
  };

  const resetCreateDraft = () => {
    const skill = editingSkill();
    setCreateName(skill?.name ?? "");
    setCreateDescription(skill?.description ?? "");
    setCreateInstructions(skill ? getEditableInstructions(skill) : "");
    setCreateError(null);
  };

  const handleOpenEditSkill = (e: MouseEvent, kit: AutomationKit) => {
    e.stopPropagation();
    if (BUNDLED_KIT_IDS.has(kit.id)) return;
    setInstallError(null);
    setCreateError(null);
    setEditingSkill(kit);
    setCreateName(kit.name);
    setCreateDescription(kit.description);
    setCreateInstructions(getEditableInstructions(kit));
    setCreateEditorOpen(true);
  };

  const handleSaveSkill = async () => {
    if (savingSkill()) return;
    setInstallError(null);
    setCreateError(null);
    const name = createName().trim();
    const instructions = createInstructions().trim();
    if (!name || !instructions) {
      setCreateError("Add a skill name and instructions before saving.");
      return;
    }

    const existing = editingSkill() ?? undefined;
    const skill = buildSkillDraft(
      name,
      createDescription().trim(),
      instructions,
      existing,
    );

    setSavingSkill(true);
    try {
      const source = JSON.stringify(skill);
      const automationApi = window.vessel.automation as typeof window.vessel.automation & {
        updateFromText?: (
          id: string,
          source: string,
        ) => Promise<{ ok: boolean; kit?: AutomationKit; error?: string }>;
      };
      const result = existing && automationApi.updateFromText
        ? await automationApi.updateFromText(existing.id, source)
        : await window.vessel.automation.createFromText(source);

      if (!result.ok) {
        setCreateError(result.error ?? "Could not save skill.");
        return;
      }

      setCreateEditorOpen(false);
      setEditingSkill(null);
      clearCreateDraft();
      void refetchInstalled();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not save skill.");
    } finally {
      setSavingSkill(false);
    }
  };

  const handleUninstall = async (e: MouseEvent, id: string) => {
    e.stopPropagation();
    const result = await window.vessel.automation.uninstall(id);
    if (!result.ok) {
      setInstallError(result.error ?? "Could not remove skill.");
      return;
    }
    void refetchInstalled();
  };

  const handleToggleJob = async (e: MouseEvent, job: ScheduledJob) => {
    e.stopPropagation();
    await window.vessel.schedule.update(job.id, { enabled: !job.enabled });
  };

  const handleDeleteJob = async (e: MouseEvent, id: string) => {
    e.stopPropagation();
    await window.vessel.schedule.delete(id);
  };

  const handleOpenEditTask = (job: ScheduledJob) => {
    const kit = allKits().find((k) => k.id === job.kitId);
    if (!kit) return;
    selectKit(kit); // resets all form state to defaults
    // Restore stored field values if available, otherwise keep defaults
    if (job.fieldValues) setFieldValues(job.fieldValues);
    // Pre-fill schedule so the user can adjust timing too
    setScheduleEnabled(true);
    setSchedType(job.schedule.type);
    setSchedHour(job.schedule.hour ?? 9);
    setSchedMinute(job.schedule.minute ?? 0);
    setSchedDayOfWeek(job.schedule.dayOfWeek ?? 1);
    setSchedRunAt(job.schedule.runAt ? toLocalDateTimeInput(job.schedule.runAt) : "");
    setEditingTaskJobId(job.id);
    setOpenMenuJobId(null);
  };

  const handleOpenEditSchedule = (job: ScheduledJob) => {
    setEditingJob(job);
    setEditType(job.schedule.type);
    setEditHour(job.schedule.hour ?? 9);
    setEditMinute(job.schedule.minute ?? 0);
    setEditDayOfWeek(job.schedule.dayOfWeek ?? 1);
    setEditRunAt(job.schedule.runAt ? toLocalDateTimeInput(job.schedule.runAt) : "");
    setEditError(null);
    setOpenMenuJobId(null);
  };

  const handleSaveEditSchedule = async () => {
    const job = editingJob();
    if (!job) return;
    const schedule: ScheduleConfig = { type: editType() };
    if (editType() === "once") {
      const d = new Date(editRunAt());
      if (isNaN(d.getTime())) { setEditError("Please enter a valid date and time."); return; }
      if (d <= new Date()) { setEditError("Scheduled time must be in the future."); return; }
      schedule.runAt = d.toISOString();
    } else if (editType() === "daily" || editType() === "weekly") {
      schedule.hour = editHour();
      schedule.minute = editMinute();
      if (editType() === "weekly") schedule.dayOfWeek = editDayOfWeek();
    }
    try {
      await window.vessel.schedule.update(job.id, { schedule });
      setEditingJob(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update schedule.");
    }
  };

  const editTimeValue = () =>
    `${String(editHour()).padStart(2, "0")}:${String(editMinute()).padStart(2, "0")}`;

  const parseEditTimeInput = (val: string) => {
    const [h, m] = val.split(":").map(Number);
    setEditHour(isNaN(h) ? 0 : h);
    setEditMinute(isNaN(m) ? 0 : m);
  };

  const parseTimeInput = (val: string) => {
    const [h, m] = val.split(":").map(Number);
    setSchedHour(isNaN(h) ? 0 : h);
    setSchedMinute(isNaN(m) ? 0 : m);
  };

  const timeValue = () =>
    `${String(schedHour()).padStart(2, "0")}:${String(schedMinute()).padStart(2, "0")}`;

  return (
    <section class="automation-panel">
      {/* ── Premium gate ── */}
      <Show when={!premiumData.loading && !isPremium()}>
        <div class="kit-upsell">
          <div class="kit-upsell-icon" aria-hidden="true">
            <Zap size={24} />
          </div>
          <p class="kit-upsell-title">Vessel Premium</p>
          <p class="kit-upsell-body">
            Skills are a premium feature. Upgrade to import, inspect, and run
            reusable agent capabilities.
          </p>
          <button
            class="agent-primary-button kit-upsell-btn"
            type="button"
            onClick={() => void openSettings()}
          >
            Start 7-day free trial — $5.99/mo after
          </button>
        </div>
      </Show>

      {/* ── Skill list ── */}
      <Show when={isPremium() && selectedKit() === null}>
        <div class="kit-list-header">
          <span class="agent-panel-title">Skills</span>
          <div class="kit-list-header-actions">
            <span class="kit-list-count">{allKits().length} skills</span>
            <button
              class="kit-install-btn"
              type="button"
              title="Create a skill from text"
              onClick={openCreateEditor}
              aria-label="Create skill"
            >
              <Plus size={12} aria-hidden="true" />
              Create
            </button>
            <button
              class="kit-install-btn"
              type="button"
              title="Import a skill from a .skill.json file"
              onClick={() => void handleInstall()}
              aria-label="Import skill"
            >
              <Upload size={12} aria-hidden="true" />
              Import
            </button>
          </div>
        </div>

        <Show when={installError() !== null}>
          <div class="kit-install-error">
            <span>{installError()}</span>
            <button
              class="kit-install-error-dismiss"
              type="button"
              onClick={() => setInstallError(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </Show>

        <Show when={createEditorOpen()}>
          <div class="kit-create-panel">
            <div class="kit-create-header">
              <span class="kit-create-title">
                {editingSkill() ? "Edit Skill" : "Create Skill"}
              </span>
              <button
                class="kit-install-error-dismiss"
                type="button"
                onClick={closeCreateEditor}
                aria-label="Close create skill"
              >
                ×
              </button>
            </div>
            <input
              class="kit-form-input"
              type="text"
              placeholder="Skill name"
              value={createName()}
              onInput={(e) => setCreateName(e.currentTarget.value)}
            />
            <input
              class="kit-form-input"
              type="text"
              placeholder="Short description"
              value={createDescription()}
              onInput={(e) => setCreateDescription(e.currentTarget.value)}
            />
            <textarea
              class="kit-create-textarea"
              placeholder="Write the skill instructions the agent should follow. Example: Research the topic carefully, compare trustworthy sources, then summarize the answer with links."
              value={createInstructions()}
              onInput={(e) => setCreateInstructions(e.currentTarget.value)}
            />
            <Show when={createError() !== null}>
              <div class="kit-install-error">
                <span>{createError()}</span>
                <button
                  class="kit-install-error-dismiss"
                  type="button"
                  onClick={() => setCreateError(null)}
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            </Show>
            <div class="kit-create-actions">
              <button
                class="kit-back-btn"
                type="button"
                onClick={resetCreateDraft}
              >
                Reset
              </button>
              <button
                class="kit-back-btn"
                type="button"
                onClick={closeCreateEditor}
              >
                Cancel
              </button>
              <button
                class="agent-primary-button kit-create-save"
                type="button"
                disabled={savingSkill()}
                onClick={() => void handleSaveSkill()}
              >
                {savingSkill()
                  ? "Saving..."
                  : editingSkill()
                    ? "Save Changes"
                    : "Save Skill"}
              </button>
            </div>
          </div>
        </Show>

        <Show
          when={allKits().length > 0}
          fallback={
            <div class="kit-empty-state">
              <div class="kit-empty-title">No skills imported</div>
              <p class="kit-empty-copy">
                Import a skill definition to make it available to the agent.
              </p>
              <div class="kit-empty-actions">
                <button
                  class="kit-install-btn"
                  type="button"
                  onClick={openCreateEditor}
                >
                  <Plus size={12} aria-hidden="true" />
                  Create
                </button>
                <button
                  class="kit-install-btn"
                  type="button"
                  onClick={() => void handleInstall()}
                >
                  <Upload size={12} aria-hidden="true" />
                  Import
                </button>
              </div>
            </div>
          }
        >
          <div class="kit-list">
            <For each={allKits()}>
              {(kit) => (
                <div
                  class="kit-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => selectKit(kit)}
                  onKeyDown={(e) => e.key === "Enter" && selectKit(kit)}
                >
                  <span class="kit-card-icon" aria-hidden="true">
                    <KitIcon name={kit.icon} size={18} />
                  </span>
                  <div class="kit-card-body">
                    <div class="kit-card-name">{kit.name}</div>
                    <div class="kit-card-desc">{kit.description}</div>
                    <Show when={kit.estimatedMinutes !== undefined}>
                      <div class="kit-card-meta">~{kit.estimatedMinutes} min</div>
                    </Show>
                  </div>
                  <Show
                    when={!BUNDLED_KIT_IDS.has(kit.id)}
                    fallback={
                      <ChevronRight
                        class="kit-card-caret"
                        size={14}
                        aria-hidden="true"
                      />
                    }
                  >
                    <button
                      class="kit-card-action-btn"
                      type="button"
                      title={`Edit ${kit.name}`}
                      onClick={(e) => handleOpenEditSkill(e, kit)}
                      aria-label={`Edit ${kit.name}`}
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                    <button
                      class="kit-card-action-btn"
                      type="button"
                      title={`View ${kit.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectKit(kit);
                      }}
                      aria-label={`View ${kit.name}`}
                    >
                      <Eye size={13} aria-hidden="true" />
                    </button>
                    <button
                      class="kit-remove-btn"
                      type="button"
                      title={`Delete ${kit.name}`}
                      onClick={(e) => void handleUninstall(e, kit.id)}
                      aria-label={`Delete ${kit.name}`}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* ── Scheduled jobs section ── */}
        <Show when={scheduledJobs().length > 0}>
          <div class="kit-sched-section">
            <Clock size={12} />
            <span>Scheduled</span>
            <span class="kit-list-count">{scheduledJobs().length}</span>
          </div>
          <div class="kit-sched-list">
            <For each={scheduledJobs()}>
              {(job) => (
                <div
                  class="kit-sched-card"
                  classList={{ "kit-sched-disabled": !job.enabled }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpenMenuJobId(job.id);
                  }}
                >
                  <span class="kit-card-icon kit-sched-icon" aria-hidden="true">
                    <KitIcon name={job.kitIcon} size={14} />
                  </span>
                  <div class="kit-sched-body">
                    <div class="kit-sched-name">{job.kitName}</div>
                    <div class="kit-sched-meta">{formatScheduleLabel(job)}</div>
                    <Show when={job.enabled}>
                      <div class="kit-sched-next">Next: {formatNextRun(job.nextRunAt)}</div>
                    </Show>
                  </div>
                  <div class="kit-sched-actions">
                    <button
                      class="kit-sched-toggle"
                      type="button"
                      title={job.enabled ? "Pause schedule" : "Resume schedule"}
                      onClick={(e) => void handleToggleJob(e, job)}
                      aria-label={job.enabled ? "Pause" : "Resume"}
                    >
                      {job.enabled ? "⏸" : "▶"}
                    </button>
                    <button
                      class="kit-remove-btn"
                      type="button"
                      title="Delete schedule"
                      onClick={(e) => void handleDeleteJob(e, job.id)}
                      aria-label="Delete schedule"
                    >
                      ×
                    </button>
                  </div>
                  <Show when={openMenuJobId() === job.id}>
                    <div class="sched-context-menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        class="sched-ctx-item"
                        type="button"
                        onClick={() => handleOpenEditTask(job)}
                      >
                        Edit task
                      </button>
                      <button
                        class="sched-ctx-item"
                        type="button"
                        onClick={() => handleOpenEditSchedule(job)}
                      >
                        Edit schedule
                      </button>
                      <div class="sched-ctx-divider" />
                      <button
                        class="sched-ctx-item"
                        type="button"
                        onClick={(e) => {
                          void handleToggleJob(e, job);
                          setOpenMenuJobId(null);
                        }}
                      >
                        {job.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        class="sched-ctx-item sched-ctx-danger"
                        type="button"
                        onClick={(e) => {
                          void handleDeleteJob(e, job.id);
                          setOpenMenuJobId(null);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={automationActivities().length > 0}>
          <div class="kit-sched-section">
            <Zap size={12} />
            <span>Recent Activity</span>
            <span class="kit-list-count">{automationActivities().length}</span>
          </div>
          <div class="kit-activity-list">
            <For each={automationActivities()}>
              {(activity) => (
                <div
                  class="kit-activity-card"
                  classList={{
                    "kit-activity-running": activity.status === "running",
                    "kit-activity-failed": activity.status === "failed",
                  }}
                >
                  <div class="kit-activity-header">
                    <div class="kit-activity-title">
                      <span class="kit-card-icon kit-sched-icon" aria-hidden="true">
                        <KitIcon name={activity.icon ?? "Zap"} size={14} />
                      </span>
                      <div class="kit-activity-title-copy">
                        <div class="kit-sched-name">{activity.title}</div>
                        <div class="kit-activity-time">
                          {formatActivityTime(activity.startedAt)}
                        </div>
                      </div>
                    </div>
                    <span class="kit-activity-badge">
                      {formatActivityStatus(activity)}
                    </span>
                  </div>
                  <Show
                    when={activity.output.trim().length > 0}
                    fallback={
                      <div class="kit-activity-output kit-activity-placeholder">
                        {activity.status === "running"
                          ? "Waiting for output..."
                          : "No output captured."}
                      </div>
                    }
                  >
                    <div class="kit-activity-output">{activity.output.trim()}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* ── Skill form ── */}
      <Show when={isPremium() && selectedKit() !== null}>
        <>
          <div class="kit-form-header">
            <button
              class="kit-back-btn"
              type="button"
              onClick={() => { setSelectedKit(null); setEditingTaskJobId(null); }}
              title="Back to skills"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M9 11L5 7l4-4"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              Back
            </button>
            <div class="kit-form-title">
              <KitIcon name={selectedKit()!.icon} size={14} />
              {selectedKit()!.name}
            </div>
          </div>

          <p class="kit-form-desc">{selectedKit()!.description}</p>

          <div class="kit-form-fields">
            <For each={selectedKit()!.inputs}>
              {(input) => (
                <div class="kit-form-field">
                  <label class="kit-form-label">
                    {input.label}
                    <Show when={input.required}>
                      <span class="kit-form-required" aria-hidden="true">
                        *
                      </span>
                    </Show>
                  </label>
                  <Show
                    when={input.type === "textarea"}
                    fallback={
                      <input
                        class="kit-form-input"
                        type={
                          input.type === "url"
                            ? "url"
                            : input.type === "number"
                              ? "number"
                              : "text"
                        }
                        placeholder={input.placeholder ?? ""}
                        value={fieldValues()[input.key] ?? ""}
                        onInput={(e) =>
                          setField(input.key, e.currentTarget.value)
                        }
                      />
                    }
                  >
                    <textarea
                      class="kit-form-textarea"
                      placeholder={input.placeholder ?? ""}
                      rows={3}
                      value={fieldValues()[input.key] ?? ""}
                      onInput={(e) =>
                        setField(input.key, e.currentTarget.value)
                      }
                    />
                  </Show>
                  <Show when={input.hint}>
                    <p class="kit-form-hint">{input.hint}</p>
                  </Show>
                </div>
              )}
            </For>
          </div>

          <Show when={selectedKit()!.estimatedMinutes !== undefined}>
            <p class="kit-form-estimate">
              Estimated run time: ~{selectedKit()!.estimatedMinutes} min
            </p>
          </Show>

          <button
            class="agent-primary-button kit-run-btn"
            type="button"
            disabled={!canRun()}
            onClick={() => void handleRun()}
          >
            <Show
              when={!isStreaming()}
              fallback={
                <>
                  <span class="kit-run-spinner" aria-hidden="true" />
                  Agent busy…
                </>
              }
            >
              Run Skill
            </Show>
          </button>

          {/* ── Schedule section ── */}
          <div class="kit-schedule-section">
            <label class="kit-schedule-toggle">
              <input
                type="checkbox"
                checked={scheduleEnabled()}
                onChange={(e) => setScheduleEnabled(e.currentTarget.checked)}
              />
              <Clock size={13} />
              Schedule for later
            </label>

            <Show when={scheduleEnabled()}>
              <div class="kit-schedule-form">
                <div class="kit-schedule-types">
                  <For each={["once", "hourly", "daily", "weekly"] as ScheduleType[]}>
                    {(type) => (
                      <label class="kit-schedule-type-option">
                        <input
                          type="radio"
                          name="sched-type"
                          value={type}
                          checked={schedType() === type}
                          onChange={() => setSchedType(type)}
                        />
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </label>
                    )}
                  </For>
                </div>

                <Show when={schedType() === "once"}>
                  <div class="kit-schedule-row">
                    <label class="kit-form-label">Date &amp; time</label>
                    <input
                      class="kit-form-input"
                      type="datetime-local"
                      value={schedRunAt()}
                      onInput={(e) => setSchedRunAt(e.currentTarget.value)}
                    />
                  </div>
                </Show>

                <Show when={schedType() === "daily"}>
                  <div class="kit-schedule-row">
                    <label class="kit-form-label">Time of day</label>
                    <input
                      class="kit-form-input kit-schedule-time"
                      type="time"
                      value={timeValue()}
                      onInput={(e) => parseTimeInput(e.currentTarget.value)}
                    />
                  </div>
                </Show>

                <Show when={schedType() === "weekly"}>
                  <div class="kit-schedule-row">
                    <label class="kit-form-label">Day</label>
                    <select
                      class="kit-form-input"
                      value={schedDayOfWeek()}
                      onChange={(e) => setSchedDayOfWeek(Number(e.currentTarget.value))}
                    >
                      <For each={DAY_NAMES}>
                        {(day, i) => <option value={i()}>{day}</option>}
                      </For>
                    </select>
                  </div>
                  <div class="kit-schedule-row">
                    <label class="kit-form-label">Time</label>
                    <input
                      class="kit-form-input kit-schedule-time"
                      type="time"
                      value={timeValue()}
                      onInput={(e) => parseTimeInput(e.currentTarget.value)}
                    />
                  </div>
                </Show>

                <Show when={scheduleError() !== null}>
                  <p class="kit-schedule-error">{scheduleError()}</p>
                </Show>

                <p class="kit-schedule-note">
                  Schedules run only while Vessel is open. Missed runs are skipped.
                </p>

                <button
                  class="agent-primary-button kit-schedule-btn"
                  type="button"
                  disabled={!canSchedule()}
                  onClick={() => void handleSchedule()}
                >
                  {editingTaskJobId() ? "Save Changes" : "Schedule Skill"}
                </button>
              </div>
            </Show>
          </div>
        </>
      </Show>

      {/* ── Edit schedule modal ── */}
      <Show when={editingJob() !== null}>
        <div class="sched-edit-backdrop" onClick={() => setEditingJob(null)}>
          <div class="sched-edit-panel" onClick={(e) => e.stopPropagation()}>
            <div class="sched-edit-header">
              <span class="sched-edit-title">Edit schedule</span>
              <span class="sched-edit-job-name">{editingJob()!.kitName}</span>
            </div>

            <div class="kit-schedule-types">
              <For each={["once", "hourly", "daily", "weekly"] as ScheduleType[]}>
                {(t) => (
                  <label class="kit-schedule-type-option">
                    <input
                      type="radio"
                      name="edit-sched-type"
                      value={t}
                      checked={editType() === t}
                      onChange={() => setEditType(t)}
                    />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </label>
                )}
              </For>
            </div>

            <Show when={editType() === "once"}>
              <div class="kit-schedule-row">
                <label>Run at</label>
                <input
                  type="datetime-local"
                  class="kit-form-input kit-schedule-time"
                  value={editRunAt()}
                  onInput={(e) => setEditRunAt(e.currentTarget.value)}
                />
              </div>
            </Show>
            <Show when={editType() === "daily" || editType() === "weekly"}>
              <Show when={editType() === "weekly"}>
                <div class="kit-schedule-row">
                  <label>Day</label>
                  <select
                    class="kit-form-input kit-schedule-time"
                    value={editDayOfWeek()}
                    onChange={(e) => setEditDayOfWeek(Number(e.currentTarget.value))}
                  >
                    <For each={DAY_NAMES}>
                      {(name, i) => <option value={i()}>{name}</option>}
                    </For>
                  </select>
                </div>
              </Show>
              <div class="kit-schedule-row">
                <label>Time</label>
                <input
                  type="time"
                  class="kit-form-input kit-schedule-time"
                  value={editTimeValue()}
                  onInput={(e) => parseEditTimeInput(e.currentTarget.value)}
                />
              </div>
            </Show>

            <Show when={editError()}>
              <p class="kit-schedule-error">{editError()}</p>
            </Show>

            <div class="sched-edit-actions">
              <button
                class="kit-back-btn"
                type="button"
                onClick={() => setEditingJob(null)}
              >
                Cancel
              </button>
              <button
                class="agent-primary-button"
                type="button"
                onClick={() => void handleSaveEditSchedule()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
};

export default AutomationTab;
