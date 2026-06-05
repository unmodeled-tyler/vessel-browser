const mockUrl = new URL("./electron.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") {
    return { url: mockUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
