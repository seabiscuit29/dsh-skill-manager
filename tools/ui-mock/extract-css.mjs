// Extract the browser half's stylesheet out of lib/client.js.
//
// The UI mockup renders the REAL CSS, so the design image in the README cannot
// drift from the shipped page. Written to tools/ui-mock/app.css (gitignored —
// it is generated, never edited by hand).
//
// Usage: node tools/ui-mock/extract-css.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "..", "lib", "client.js");
const out = join(here, "app.css");

const source = readFileSync(bundle, "utf8");
const fence = String.fromCharCode(96); // backtick, kept out of shell quoting
const marker = `const css = ${fence}`;
const start = source.indexOf(marker);
if (start === -1) throw new Error(`stylesheet declaration not found in ${bundle}`);
const from = start + marker.length;
const end = source.indexOf(`${fence};`, from);
if (end === -1) throw new Error("stylesheet terminator not found");
const css = source.slice(from, end);
if (css.length < 500) throw new Error(`extracted stylesheet looks too short: ${css.length} chars`);

writeFileSync(out, css, "utf8");
const classes = new Set([...css.matchAll(/\.(dshsm_[A-Za-z0-9_]+)/g)].map((match) => match[1]));
console.log(`extracted ${css.length} chars, ${classes.size} classes -> ${out}`);
