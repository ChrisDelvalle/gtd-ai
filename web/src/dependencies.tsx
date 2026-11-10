import { useEffect, useState, useRef } from "react";
import { ChevronDown, Check, X } from "lucide-react";
import { type Api, type List, type Task, type Status, day, errorText } from "./api";
import {momentLabel} from "./planning-fields";
import { TaskExpansion } from "./task-expansion";
import { useAppNavigation, useEnvironment } from "./app-context";
import { MetadataField } from "./metadata";

function name(task: import("./api").DependencyLabel) { return task.title + (task.occurrence ? ` · ${day(task.occurrence.scheduled_date)}` : ""); }
function useRecords(api: Api, ids: string[], reload = 0) {
  const [records,setRecords] = useState<Task[]>([]), [error,setError] = useState("");
  const {revision} = useEnvironment();
  const key = JSON.stringify(ids);
  useEffect(() => {
    let active = true;
    setError("");
    if (!ids.length) { setRecords([]); return; }
    void (async () => {
      const rows: Task[] = []; let cursor: string | null | undefined;
      do {
        const r = await api.call<List>("list_items", { task_ids:ids, detail:"summary", limit:50, ...(cursor ? {cursor}: {}) });
        rows.push(...r.items); cursor = r.next_cursor;
      } while (cursor && active);
      if (active) setRecords(rows);
    })().catch(e => { if(active) setError(errorText(e)); });
    return () => { active = false; };
  }, [api,key,revision,reload]);
  return { records,error };
}
export function DependencyFields({api,task,ids,manual,status,onChange,onManual}:{api:Api;task:Task;ids:string[];manual:boolean;status:Status;onChange:(ids:string[])=>void;onManual:(manual:boolean)=>void}) {
  const [open,setOpen] = useState(!!ids.length || manual), [query,setQuery] = useState("");
  const [picking,setPicking] = useState(false);
  const generation = useRef(0);
  const [rows,setRows] = useState<Task[]>([]), [cursor,setCursor] = useState<string|null>(null), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  const { records,error:recordError } = useRecords(api,ids);
  const args = {view:"all", archived:false, detail:"summary", limit:10, ...(query.trim() ? {query:query.trim()} : {})};
  useEffect(() => {
    ++generation.current;
    if (!open || !picking) return;
    let active = true;
    setBusy(true); setError(""); setCursor(null);
    const timer = setTimeout(() => {
      api.call<List>("list_items",args).then(r=> {if(active) {setRows(r.items);setCursor(r.next_cursor || null);}}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setBusy(false);});
    }, 200);
    return ()=> {active=false; clearTimeout(timer);};
  }, [api,open,picking,query,task.id]);
  async function more() {
    if (!cursor || busy) return;
    const token=cursor, gen=generation.current; setBusy(true);
    try { const r=await api.call<List>("list_items",{...args,cursor:token}); if(gen===generation.current) {setRows(p=>[...p,...r.items.filter(t=>!p.some(x=>x.id===t.id))]);setCursor(r.next_cursor||null);} }
    catch(e){if(gen===generation.current)setError(errorText(e));} finally{if(gen===generation.current)setBusy(false);}
  }
  return <div className="dependency-fields">
    <button type="button" className="text-action" aria-expanded={open} onClick={()=>setOpen(!open)}>Blocked by {ids.length ? `(${ids.length})` : ""}<ChevronDown className={open ? "turned" : ""}/></button>
    <TaskExpansion open={open}><div className="dependency-fields-inner">
      {ids.map(id=>{const record=records.find(r=>r.id===id);return <div className="dependency-selection" key={id}><span title={record ? name(record):id}>{record ? name(record):"Loading task…"}</span><button type="button" className="icon-button" aria-label={`Remove prerequisite: ${record?.title || id}`} onClick={()=>onChange(ids.filter(x=>x!==id))}><X/></button></div>;})}
      {recordError && <p role="alert">{recordError}</p>}
      <label><span className="sr-only">Find prerequisite</span><input type="search" aria-label="Find prerequisite" placeholder="Find task" value={query} onFocus={()=>setPicking(true)} onKeyDown={e=>{if(e.key==="Escape" && picking){e.preventDefault();e.stopPropagation();setPicking(false);}}} onChange={e=>{setQuery(e.target.value);setPicking(true);}}/></label>
      <div hidden={!picking} className="dependency-options" aria-label="Prerequisite tasks" aria-busy={busy}>
        {rows.filter(r=>r.id!==task.id && !ids.includes(r.id)).map(r=><button type="button" key={r.id} disabled={ids.length>=50 || busy} onClick={()=>{onChange([...ids,r.id]);setPicking(false);setQuery("");}}><span>{name(r)}</span>{r.status==="done" && <Check aria-label="Completed"/>}</button>)}
        {!busy && !rows.length && !error && <span className="muted">No matching tasks</span>}
        {cursor && <button type="button" className="text-action" disabled={busy} onClick={()=>void more()}>More</button>}
      </div>
      {error && <p role="alert">{error}</p>}
      {["next","blocked"].includes(status) && <label className="dependency-manual"><input type="checkbox" checked={manual} onChange={e=>onManual(e.target.checked)}/>Keep blocked manually</label>}
    </div></TaskExpansion>
  </div>;
}
const PREVIEW_COUNT = 2;

function DependencyRow({ label, ids, records, more, onMore, failed = false }: {
  label: string;
  ids: string[];
  records: import("./api").DependencyLabel[];
  more?: string;
  onMore: () => void;
  failed?: boolean;
}) {
  const app = useAppNavigation();
  if (!ids.length) return null;
  return (
    <MetadataField label={label}>
      <div className="dependency-values">
        {ids.slice(0, PREVIEW_COUNT).map(id => {
          const record = records.find(r => r.id === id);
          const title = record ? name(record) : failed ? "View task" : "Loading task…";
          const completed = record?.status === "done" && !record.occurrence?.skipped;
          return (
            <button
              type="button"
              className="dependency-link"
              key={id}
              title={title}
              aria-label={completed ? `${title}, completed` : title}
              onClick={() => app.go({ page: "Tasks", scope: "selected", input: { task_id: id } })}
            >
              <span className="metadata-badge">
                {completed && <Check aria-hidden="true" />}
                <span className="dependency-title">{title}</span>
              </span>
            </button>
          );
        })}
        {more && <button type="button" className="dependency-more" aria-label={`${label}: ${more}`} onClick={onMore}>{more}</button>}
      </div>
    </MetadataField>
  );
}

export function DependencyContext({ api, task }: { api: Api; task: Task }) {
  const ids = task.blocked_by || [];
  const [reload, setReload] = useState(0);
  const preview = task.widget_preview;
  const { records, error } = useRecords(api, preview ? [] : ids.slice(0, PREVIEW_COUNT), reload);
  const app = useAppNavigation();
  const { revision } = useEnvironment();
  const [dependents, setDependents] = useState<{ taskId: string; items: Task[]; more: boolean } | null>(null);
  const [reverseError, setReverseError] = useState("");
  useEffect(() => {
    if (preview || task.blocking_count === 0) return;
    let active = true;
    setReverseError("");
    // One extra record establishes overflow without fetching a whole reverse graph.
    api.call<List>("list_items", {
      view: "all", blocked_by_id: task.id, detail: "summary",
      group_recurrences: false, limit: PREVIEW_COUNT + 1,
    }).then(r => {
      if (active) setDependents({ taskId: task.id, items: r.items, more: !!r.next_cursor || r.next_offset != null });
    }).catch(e => { if (active) setReverseError(errorText(e)); });
    return () => { active = false; };
  }, [api, task.id, task.version, task.blocking_count, preview, revision, reload]);
  const reverse = preview ? { items: preview.dependents, more: preview.more }
    : task.blocking_count !== 0 && dependents?.taskId === task.id ? dependents : null;
  const remaining = (reverse?.items.length || 0) - PREVIEW_COUNT;
  return (
    <div className="dependency-context">
      <DependencyRow
        label="Blocked by" ids={ids} records={preview?.prerequisites ?? records} failed={!!preview || !!error}
        more={ids.length > PREVIEW_COUNT ? `+${ids.length - PREVIEW_COUNT} more` : undefined}
        onMore={() => app.go({ page: "Tasks", scope: "selected", input: { task_ids: ids } })}
      />
      <DependencyRow
        label="Blocking" ids={reverse?.items.map(r => r.id) || []} records={reverse?.items || []}
        more={reverse?.more ? "View all" : remaining > 0 ? `+${remaining} more` : undefined}
        onMore={() => app.go({ page: "Tasks", scope: "selected", input: { view: "all", blocked_by_id: task.id, group_recurrences: false } })}
      />
      {task.not_before && task.blocking_reasons?.some(reason => reason.kind === "availability") && <span className="muted">Available {momentLabel(task.not_before)}</span>}
      {task.manual_block && <span className="muted">Manually blocked</span>}
      {(error || reverseError) && <div className="dependency-error" role="alert">{error || reverseError}<button type="button" className="text-action" onClick={() => setReload(n => n + 1)}>Retry</button></div>}
    </div>
  );
}
