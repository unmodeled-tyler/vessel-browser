import {
  createResource,
  createSignal,
  For,
  Show,
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
  type IconProps,
} from "lucide-solid";
import { useAI } from "../../stores/ai";
import { useUI } from "../../stores/ui";
import { BUNDLED_KITS, renderKitPrompt } from "../../lib/automation-kits";
import type { AutomationKit } from "../../../../shared/types";

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
};

const KitIcon = (props: { name: string; size?: number; class?: string }) => {
  const Icon = ICON_MAP[props.name] ?? Zap;
  return <Icon size={props.size ?? 18} class={props.class} />;
};

interface AutomationTabProps {
  /** Called after launching a kit so the parent can switch to the supervisor tab */
  onRun: () => void;
}

const AutomationTab: Component<AutomationTabProps> = (props) => {
  const { query, isStreaming } = useAI();
  const { openSettings } = useUI();
  const [selectedKit, setSelectedKit] = createSignal<AutomationKit | null>(
    null,
  );
  const [fieldValues, setFieldValues] = createSignal<Record<string, string>>(
    {},
  );

  const [premiumData] = createResource(() =>
    window.vessel.premium.getState().catch(() => ({ status: "free" as const })),
  );

  const isPremium = () => {
    const s = premiumData()?.status;
    return s === "active" || s === "trialing";
  };

  const selectKit = (kit: AutomationKit) => {
    const defaults: Record<string, string> = {};
    for (const input of kit.inputs) {
      defaults[input.key] = input.defaultValue ?? "";
    }
    setFieldValues(defaults);
    setSelectedKit(kit);
  };

  const setField = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const canRun = () => {
    const kit = selectedKit();
    if (!kit || isStreaming()) return false;
    return kit.inputs
      .filter((i) => i.required)
      .every((i) => fieldValues()[i.key]?.trim());
  };

  const handleRun = async () => {
    const kit = selectedKit();
    if (!kit || !canRun()) return;
    const prompt = renderKitPrompt(kit, fieldValues());
    setSelectedKit(null);
    props.onRun();
    await query(prompt);
  };

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
          <span class="kit-list-count">{BUNDLED_KITS.length} kits</span>
        </div>
        <div class="kit-list">
          <For each={BUNDLED_KITS}>
            {(kit) => (
              <button
                class="kit-card"
                type="button"
                onClick={() => selectKit(kit)}
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
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* ── Kit form ── */}
      <Show when={isPremium() && selectedKit() !== null}>
        {(kit) => (
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
                          type={input.type === "url" ? "url" : input.type === "number" ? "number" : "text"}
                          placeholder={input.placeholder ?? ""}
                          value={fieldValues()[input.key] ?? ""}
                          onInput={(e) => setField(input.key, e.currentTarget.value)}
                        />
                      }
                    >
                      <textarea
                        class="kit-form-textarea"
                        placeholder={input.placeholder ?? ""}
                        rows={3}
                        value={fieldValues()[input.key] ?? ""}
                        onInput={(e) => setField(input.key, e.currentTarget.value)}
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
          </>
        )}
      </Show>
    </section>
  );
};

export default AutomationTab;
