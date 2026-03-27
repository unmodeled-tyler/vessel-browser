export type AIStreamSource = "manual" | "scheduled";

let activeSource: AIStreamSource | null = null;
const idleListeners = new Set<() => void>();

export function tryBeginAIStream(source: AIStreamSource): boolean {
  if (activeSource !== null) return false;
  activeSource = source;
  return true;
}

export function endAIStream(source: AIStreamSource): void {
  if (activeSource !== source) return;
  activeSource = null;
  for (const listener of idleListeners) {
    listener();
  }
}

export function isAIStreamActive(): boolean {
  return activeSource !== null;
}

export function onAIStreamIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => idleListeners.delete(listener);
}
