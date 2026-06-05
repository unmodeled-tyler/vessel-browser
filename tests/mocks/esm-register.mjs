import { register } from "node:module";

register(
  new URL("./electron-resolver.mjs", import.meta.url).href,
  import.meta.url,
);
