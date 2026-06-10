import type { AutomationKit } from "../../../shared/types";
import { createLogger } from "../../../shared/logger";

const logger = createLogger("AutomationKits");

export const BUNDLED_KITS: AutomationKit[] = [];

export interface SkillSlashInvocation {
  kit: AutomationKit;
  task: string;
}

export function normalizeSkillCommandToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getSkillCommandTokens(kit: AutomationKit): string[] {
  return Array.from(
    new Set([
      normalizeSkillCommandToken(kit.name),
      normalizeSkillCommandToken(kit.id),
    ].filter(Boolean)),
  );
}

export function parseSkillSlashInvocation(
  value: string,
  kits: AutomationKit[],
): SkillSlashInvocation | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return null;

  const [rawCommand = "", ...rest] = trimmed.split(/\s+/);
  const command = normalizeSkillCommandToken(rawCommand);
  let skillToken = command;
  let task = rest.join(" ").trim();

  if (command === "skill") {
    const [rawSkillToken = "", ...skillRest] = rest;
    skillToken = normalizeSkillCommandToken(rawSkillToken);
    task = skillRest.join(" ").trim();
  }

  if (!skillToken) return null;
  const kit = kits.find((candidate) =>
    getSkillCommandTokens(candidate).includes(skillToken),
  );
  return kit ? { kit, task } : null;
}

export function getSkillSlashSuggestionQuery(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\n")) return null;
  const withoutSlash = value.slice(1);
  if (/^\S+\s+\S/.test(withoutSlash) && !withoutSlash.startsWith("skill ")) {
    return null;
  }

  if (withoutSlash === "skill") return "";
  if (withoutSlash.startsWith("skill ")) {
    const afterSkill = withoutSlash.slice("skill ".length);
    if (afterSkill.includes(" ")) return null;
    return normalizeSkillCommandToken(afterSkill);
  }

  if (withoutSlash.includes(" ")) return null;
  return normalizeSkillCommandToken(withoutSlash);
}

export function getSkillSlashSuggestions(
  value: string,
  kits: AutomationKit[],
  limit = 6,
): AutomationKit[] {
  const query = getSkillSlashSuggestionQuery(value);
  if (query === null) return [];

  return kits
    .map((kit) => ({
      kit,
      tokens: getSkillCommandTokens(kit),
      normalizedName: normalizeSkillCommandToken(kit.name),
    }))
    .filter(({ tokens, normalizedName }) =>
      query
        ? tokens.some((token) => token.includes(query)) ||
          normalizedName.includes(query)
        : true,
    )
    .sort((left, right) => {
      if (!query) return left.kit.name.localeCompare(right.kit.name);
      const leftStarts = left.tokens.some((token) => token.startsWith(query));
      const rightStarts = right.tokens.some((token) => token.startsWith(query));
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.kit.name.localeCompare(right.kit.name);
    })
    .slice(0, limit)
    .map(({ kit }) => kit);
}

export function buildSlashSkillValues(
  kit: AutomationKit,
  task: string,
): { values: Record<string, string>; missingLabels: string[] } {
  const values: Record<string, string> = {};
  for (const input of kit.inputs) {
    values[input.key] = input.defaultValue ?? "";
  }

  const targetInput =
    kit.inputs.find((input) => input.key === "task") ??
    kit.inputs.find((input) => input.type === "textarea") ??
    kit.inputs.find((input) => input.required) ??
    kit.inputs[0];

  if (targetInput) {
    values[targetInput.key] = task;
  }

  const missingLabels = kit.inputs
    .filter((input) => input.required)
    .filter((input) => !values[input.key]?.trim())
    .map((input) => input.label);

  return { values, missingLabels };
}

/**
 * Render a kit's prompt template by substituting {{key}} placeholders
 * with the values the user filled in.
 */
export function renderKitPrompt(
  kit: AutomationKit,
  values: Record<string, string>,
): string {
  for (const input of kit.inputs) {
    if (input.required && !values[input.key]?.trim()) {
      logger.warn(
        `Required field "${input.key}" is empty for kit "${kit.id}".`,
      );
    }
  }
  return kit.promptTemplate.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => values[key] ?? "",
  );
}
