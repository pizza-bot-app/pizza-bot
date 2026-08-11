import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
await chmod(bin, 0o755);
