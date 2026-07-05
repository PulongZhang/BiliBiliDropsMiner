import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 加载 Python 真值向量（gen_vectors.py 生成）。 */
export function loadVectors() {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "vectors.json"), "utf8"),
  );
}
