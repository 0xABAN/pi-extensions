import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the collection explicitly lists package entry points, never helpers or tests", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(manifest.pi.extensions).toEqual(["inline-skills/index.ts", "dj/index.ts"]);
  for (const entry of manifest.pi.extensions as string[]) {
    const name = entry.split("/")[0];
    const standalone = JSON.parse(readFileSync(join(root, name, "package.json"), "utf8"));
    expect(standalone.pi.extensions).toEqual(["./index.ts"]);
  }
});

test("Pi loads the collection and honors per-extension filtering", async () => {
  for (const filter of [undefined, ["dj/index.ts"]]) {
    const directory = mkdtempSync(join(tmpdir(), "pi-collection-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd: directory, agentDir: directory,
        noSkills: true, noPromptTemplates: true, noThemes: true,
        settingsManager: SettingsManager.inMemory({ packages: [{ source: root, ...(filter ? { extensions: filter } : {}) }] }),
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions).toHaveLength(filter ? 1 : 2);
      expect(loaded.extensions.filter(extension => extension.commands.has("dj"))).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
