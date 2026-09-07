import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the public DJ package includes its runtime without tests, media, or local files", () => {
  const manifest = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
  expect(manifest.name).toBe("@0xaban/pi-dj");
  expect(manifest.private).not.toBe(true);
  expect(manifest.publishConfig.access).toBe("public");
  expect(manifest.keywords).toContain("pi-package");
  expect(manifest.pi.extensions).toEqual(["./index.ts"]);
  expect(manifest.pi.image).toStartWith("https://");
  expect(manifest.dependencies["proper-lockfile"]).toBeDefined();

  // Inspect npm's actual allowlist output without publishing or contacting Spotify.
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const expected = [
    "package.json",
    "README.md",
    "LICENSE",
    "index.ts",
    ...readdirSync(`${root}src`).map((name) => `src/${name}`),
  ];
  expect(packed.files.map((file: { path: string }) => file.path).sort()).toEqual(expected.sort());
}, 30_000);
