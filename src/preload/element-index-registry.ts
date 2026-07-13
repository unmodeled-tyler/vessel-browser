export interface ElementIndexRegistry<T extends object> {
  nextIndex: number;
  readonly indexes: WeakMap<T, number>;
  readonly selectors: Record<number, string>;
  readonly refs: Record<number, T>;
}

export function createElementIndexRegistry<T extends object>(): ElementIndexRegistry<T> {
  return {
    nextIndex: 0,
    indexes: new WeakMap<T, number>(),
    selectors: {},
    refs: {},
  };
}

export function beginElementIndexSnapshot<T extends object>(
  registry: ElementIndexRegistry<T>,
): void {
  Object.keys(registry.selectors).forEach((key) => {
    delete registry.selectors[Number(key)];
  });
  Object.keys(registry.refs).forEach((key) => {
    delete registry.refs[Number(key)];
  });
}

export function assignElementIndex<T extends object>(
  registry: ElementIndexRegistry<T>,
  element: T,
  selector: string,
): number {
  const existing = registry.indexes.get(element);
  if (existing != null) {
    registry.selectors[existing] = selector;
    registry.refs[existing] = element;
    return existing;
  }

  registry.nextIndex += 1;
  const index = registry.nextIndex;
  registry.indexes.set(element, index);
  registry.selectors[index] = selector;
  registry.refs[index] = element;
  return index;
}
