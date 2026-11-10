/** Keep a bounded number of clean screens. Unsaved legacy editors are pinned
 * until they have moved their intent into the independent session draft store. */
export function retainedViews(current:string, recent:readonly string[], pinned:ReadonlySet<string>, limit:number) {
  const ordered=[...new Set([current,...recent])];
  const clean=ordered.filter(key=>!pinned.has(key));
  const retained=new Set([...pinned,...clean.slice(0,Math.max(1,limit))]);
  retained.add(current);
  return ordered.filter(key=>retained.has(key));
}
