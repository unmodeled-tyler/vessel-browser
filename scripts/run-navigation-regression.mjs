import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

require("tsx/cjs");
require("../tests/navigation-regression.ts");
