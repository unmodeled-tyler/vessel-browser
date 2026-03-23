import {
  createSignal,
  createEffect,
  createMemo,
  onCleanup,
  For,
  Show,
} from "solid-js";

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
}

interface DropdownSelectProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  class?: string;
  ariaLabel?: string;
}

const DropdownSelect = (props: DropdownSelectProps) => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;

  const selectedLabel = createMemo(
    () =>
      props.options.find((option) => option.value === props.value)?.label ||
      props.options[0]?.label ||
      "",
  );

  createEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  return (
    <div class={`dropdown-select ${props.class || ""}`} ref={rootRef}>
      <button
        class="dropdown-select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={props.ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span class="dropdown-select-value">{selectedLabel()}</span>
        <span
          class="dropdown-select-caret"
          classList={{ open: open() }}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      <Show when={open()}>
        <div class="dropdown-select-menu" role="listbox">
          <For each={props.options}>
            {(option) => (
              <button
                class="dropdown-select-option"
                classList={{ selected: option.value === props.value }}
                type="button"
                role="option"
                aria-selected={option.value === props.value}
                onClick={() => {
                  props.onChange(option.value);
                  setOpen(false);
                }}
              >
                <span class="dropdown-select-option-copy">
                  <span class="dropdown-select-option-label">
                    {option.label}
                  </span>
                  <Show when={option.description}>
                    <span class="dropdown-select-option-description">
                      {option.description}
                    </span>
                  </Show>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default DropdownSelect;
