const mockUrl = new URL("./electron.mjs", import.meta.url).href;
const dompurifyUrl = new URL("./dompurify.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") {
    return { url: mockUrl, shortCircuit: true };
  }
  if (specifier === "dompurify") {
    return { url: dompurifyUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
