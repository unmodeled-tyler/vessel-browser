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
  type IconProps,
} from "lucide-solid";
import { useAI } from "../../stores/ai";
import { useUI } from "../../stores/ui";
import { BUNDLED_KITS, renderKitPrompt } from "../../lib/automation-kits";
import type { AutomationKit, ScheduleConfig, ScheduledJob, ScheduleType } from "../../../../shared/types";

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

const BUNDLED_KIT_IDS = new Set(BUNDLED_KITS.map((k) => k.id));

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

interface AutomationTabProps {
  /** Called after launching a kit so the parent can switch to the supervisor tab */
  onRun: () => void;
}

const AutomationTab: Component<AutomationTabProps> = (props) => {
  const { query, isStreaming } = useAI();
  const { openSettings } = useUI();
  const [selectedKit, setSelectedKit] = createSignal<AutomationKit | null>(null);
  const [fieldValues, setFieldValues] = createSignal<Record<string, string>>({});
  const [installError, setInstallError] = createSignal<string | null>(null);

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

  onMount(() => {
    void window.vessel.schedule.getAll().then(setScheduledJobs);
    const cleanup = window.vessel.schedule.onJobsUpdate(setScheduledJobs);
    onCleanup(cleanup);
  });

  const [premiumData] = createResource(() =>
    window.vessel.premium.getState().catch(() => ({ status: "free" as const })),
  );

  const isPremium = () => {
    const s = premiumData()?.status;
    return s === "active" || s === "trialing";
  };

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
    setSelectedKit(null);
    props.onRun();
    await query(prompt);
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
      await window.vessel.schedule.create({
        kitId: kit.id,
        kitName: kit.name,
        kitIcon: kit.icon,
        renderedPrompt: prompt,
        schedule,
        enabled: true,
      });
      setSelectedKit(null);
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : "Failed to create schedule.");
    }
  };

  const handleInstall = async () => {
    setInstallError(null);
    const result = await window.vessel.automation.installFromFile();
    if (!result.ok) {
      if (result.error !== "canceled") {
        setInstallError(result.error ?? "Installation failed.");
      }
      return;
    }
    void refetchInstalled();
  };

  const handleUninstall = async (e: MouseEvent, id: string) => {
    e.stopPropagation();
    const result = await window.vessel.automation.uninstall(id);
    if (!result.ok) {
      setInstallError(result.error ?? "Could not remove kit.");
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
            Automation Kits are a premium feature. Upgrade to unlock pre-built
            workflows you can launch with one click.
          </p>
          <button
            class="agent-primary-button kit-upsell-btn"
            type="button"
            onClick={() => void openSettings()}
          >
            Upgrade to Premium
          </button>
        </div>
      </Show>

      {/* ── Kit list ── */}
      <Show when={isPremium() && selectedKit() === null}>
        <div class="kit-list-header">
          <span class="agent-panel-title">Automation Kits</span>
          <div class="kit-list-header-actions">
            <span class="kit-list-count">{allKits().length} kits</span>
            <button
              class="kit-install-btn"
              type="button"
              title="Install a kit from a .kit.json file"
              onClick={() => void handleInstall()}
            >
              + Install
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
                    <svg
                      class="kit-card-caret"
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M5 3l4 4-4 4"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  }
                >
                  <button
                    class="kit-remove-btn"
                    type="button"
                    title={`Remove ${kit.name}`}
                    onClick={(e) => void handleUninstall(e, kit.id)}
                    aria-label={`Remove ${kit.name}`}
                  >
                    ×
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>

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
                <div class="kit-sched-card" classList={{ "kit-sched-disabled": !job.enabled }}>
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
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* ── Kit form ── */}
      <Show when={isPremium() && selectedKit() !== null}>
        <>
          <div class="kit-form-header">
            <button
              class="kit-back-btn"
              type="button"
              onClick={() => setSelectedKit(null)}
              title="Back to kits"
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
              Run Kit
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
                  Schedules run while Vessel is open.
                </p>

                <button
                  class="agent-primary-button kit-schedule-btn"
                  type="button"
                  disabled={!canSchedule()}
                  onClick={() => void handleSchedule()}
                >
                  Schedule Kit
                </button>
              </div>
            </Show>
          </div>
        </>
      </Show>
    </section>
  );
};

export default AutomationTab;
