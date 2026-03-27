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

function stripLeadingComments(statement: string): string {
  let trimmed = statement.trimStart();
  while (true) {
    if (trimmed.startsWith("//")) {
      const newlineIndex = trimmed.indexOf("\n");
      trimmed = newlineIndex >= 0 ? trimmed.slice(newlineIndex + 1).trimStart() : "";
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const endIndex = trimmed.indexOf("*/");
      trimmed = endIndex >= 0 ? trimmed.slice(endIndex + 2).trimStart() : "";
      continue;
    }
    return trimmed;
  }
}

function listRuntimePluginSdkImportStatements(source: string): string[] {
  return source
    .split(/;\s*\n/g)
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes(`from "openclaw/plugin-sdk`))
    .filter((statement) => !stripLeadingComments(statement).startsWith("import type "));
}

describe("OpenClaw SDK runtime compatibility", () => {
  it("ignores import type statements preceded by comments", () => {
    expect(
      listRuntimePluginSdkImportStatements(`
        // local compatibility note
        import type { ReplyPayload } from "openclaw/plugin-sdk";
      `),
    ).toEqual([]);
  });

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
