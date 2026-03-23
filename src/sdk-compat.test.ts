import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
async function listProductionTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return await listProductionTypeScriptFiles(entryPath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        return [];
      }
      return [entryPath];
    }),
  );
  return files.flat();
}

function listRuntimePluginSdkImportStatements(source: string): string[] {
  return source
    .split(/;\s*\n/g)
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes(`from "openclaw/plugin-sdk`))
    .filter((statement) => !statement.startsWith("import type "));
}

describe("OpenClaw SDK runtime compatibility", () => {
  it("avoids runtime plugin-sdk imports in production sources", async () => {
    const files = [
      path.join(pluginRoot, "index.ts"),
      ...(await listProductionTypeScriptFiles(path.join(pluginRoot, "src"))),
    ];
    const offenders: string[] = [];

    for (const filePath of files) {
      const source = await fs.readFile(filePath, "utf8");
      if (listRuntimePluginSdkImportStatements(source).length > 0) {
        offenders.push(path.relative(pluginRoot, filePath));
      }
    }

    expect(offenders).toEqual([]);
  });
});
