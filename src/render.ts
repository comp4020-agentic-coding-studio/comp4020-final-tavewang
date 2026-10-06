import { readFileSync } from "node:fs";
import { marked } from "marked";

// README.md is the student's own writing, not user input, so rendering it
// straight to HTML (rather than escaping it) is the intended behaviour here —
// unlike anything a fridge member types, which always goes through hono/html's
// auto-escaping `html` tag in src/views/.
export function renderReadmeHtml(): string {
  const source = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  return marked.parse(source, { async: false }) as string;
}
