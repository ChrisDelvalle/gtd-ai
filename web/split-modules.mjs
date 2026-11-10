import { readFile, writeFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

// Chromium caches rejected module fetches for the document's lifetime. Check
// optional code through the HTTP cache before importing it so an interrupted
// transfer never poisons the module map. Only code absent from the startup graph
// needs this guard. Successful immutable responses are reused by native import.
const guard = `const __gtdChecked=new Map();function __gtdChunk(path,deps){return Promise.all(deps.map(p=>{const u=new URL(p,import.meta.url).href;let pending=__gtdChecked.get(u);if(!pending){pending=fetch(u,{cache:"force-cache"}).then(r=>{if(!r.ok)throw Error("Could not load view");return r.arrayBuffer()}).then(()=>{}).catch(e=>{__gtdChecked.delete(u);throw e});__gtdChecked.set(u,pending)}return pending})).then(()=>import(new URL(path,import.meta.url).href))}\n`;

export async function guardSplitModules(metafile, initial) {
  const files = new Map();
  function dependencies(path, seen = new Set()) {
    if (initial.has(path) || seen.has(path)) return seen;
    seen.add(path);
    for (const item of metafile.outputs[path]?.imports || [])
      if (!item.external && item.kind === "import-statement") dependencies(item.path, seen);
    return seen;
  }
  for (const [path, entry] of Object.entries(metafile.outputs)) {
    if (!path.endsWith('.js')) continue;
    let code = await readFile(path, 'utf8'), guarded = false;
    const processed = new Set();
    for (const item of entry.imports) {
      if (item.external || item.kind !== 'dynamic-import' || processed.has(item.path)) continue;
      processed.add(item.path);
      const relative = './' + basename(item.path);
      const call = `import(${JSON.stringify(relative)})`;
      if (!code.includes(call)) throw Error(`Missing generated dynamic import: ${path} ${relative}`);
      const deps = [...dependencies(item.path)].map(p => './' + basename(p));
      code = code.replaceAll(call, `__gtdChunk(${JSON.stringify(relative)},${JSON.stringify(deps)})`);
      guarded = true;
    }
    files.set(path, (guarded ? guard : '') + code);
  }
  // Postprocessing must never change bytes under an existing immutable URL.
  // One graph fingerprint also handles cyclic imports without recursive hashes.
  const fingerprint = createHash('sha256').update(JSON.stringify([...files])).digest('hex').slice(0,16);
  const names = new Map([...files.keys()].map(p=>[p,p.replace(/\.js$/,`-${fingerprint}.js`)]));
  for (const [path, original] of files) {
    let code=original;
    for (const [old, next] of names) code=code.replaceAll(basename(old),basename(next));
    await writeFile(path,code);
    await rename(path,names.get(path));
  }
  return names;
}
