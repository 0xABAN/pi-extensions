import { readFileSync } from "node:fs";
export const LEARN_MODE_PROMPT = readFileSync(new URL("./prompts/learn.md", import.meta.url), "utf8");
