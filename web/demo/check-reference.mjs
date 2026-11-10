// Compare a freshly generated Rust oracle without retaining database state.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const path = process.argv[2];
if (!path)
  throw Error("Pass the output of the guarded demo_reference Rust example.");
assert.deepEqual(
  JSON.parse(await readFile(path)),
  JSON.parse(await readFile(new URL("./reference.json", import.meta.url))),
);
console.log(
  "Rust demo reference matches committed rankings, queries, history, and charts.",
);
