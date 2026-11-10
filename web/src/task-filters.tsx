import { useId } from "react";
import { ChevronDown, X } from "lucide-react";
import { type Args, statuses, effortLevels } from "./api";

function DateFilter({
  label,
  name,
  value,
  change,
}: {
  label: string;
  name: string;
  value: string;
  change: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="filter-date">
      <label htmlFor={id}>{label}</label>
      <div className="filter-date-control" data-empty={!value || undefined}>
        <div className="filter-date-value">
          <input
            id={id}
            type="date"
            aria-label={name}
            value={value}
            onChange={(e) => change(e.target.value)}
          />
          {!value && (
            <span className="filter-date-placeholder" aria-hidden="true">
              Any date
            </span>
          )}
        </div>
        <button
          type="button"
          className="filter-date-clear"
          aria-label={`Clear ${name.toLowerCase()}`}
          title={`Clear ${name.toLowerCase()}`}
          disabled={!value}
          onClick={() => change("")}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function TaskFilters({
  args,
  scope,
  filtering,
  change,
}: {
  args: Args;
  scope: string;
  filtering: boolean;
  change: (args: Args) => void;
}) {
  return (
    <>
      <div className="filter-heading">
        <span>Filters</span>
        <button
          type="button"
          className="text-action"
          disabled={!filtering}
          onClick={() =>
            change({
              ...args,
              due_from: undefined,
              due_through: undefined,
              undated: false,
              include_deleted: false,
              max_estimated_minutes: undefined,
              max_effort: undefined,
              planned_from: undefined,
              planned_through: undefined,
              exclude_statuses: undefined,
              ...(scope === "all" ? { archived: false } : {}),
            })
          }
        >
          Clear filters
        </button>
      </div>
      <div className="estimate-fields"><label>Time available<input aria-label="Time available in minutes" type="number" min="0" max="5256000" step="1" placeholder="Minutes" value={args.max_estimated_minutes as number ?? ""} onChange={e=>change({...args,max_estimated_minutes:e.target.value===""?undefined:Number(e.target.value)})}/></label><label>Maximum effort<select aria-label="Maximum effort" value={String(args.max_effort||"")} onChange={e=>change({...args,max_effort:e.target.value||undefined})}><option value="">Any</option>{effortLevels.map(v=><option key={v} value={v}>{v[0].toUpperCase()+v.slice(1)}</option>)}</select></label></div>
      <label className="filter-sort">
        Sort
        <span className="select-control">
          <select
            aria-label="Sort tasks"
            value={String(args.sort || "")}
            onChange={(e) =>
              change({ ...args, sort: e.target.value || undefined })
            }
          >
            <option value="">Recommended</option>
            <option value="action">Next actions first</option>
            <option value="importance">Importance</option>
            <option value="due">Due date</option>
            <option value="updated">Recently changed</option>
            <option value="created">Created</option>
          </select>
          <ChevronDown aria-hidden="true" />
        </span>
      </label>
      {scope === "all" && (
        <fieldset className="status-filters">
          <legend>Status</legend>
          {(
            ["next", "inbox", "waiting", "blocked", "someday", "done"] as const
          ).map((status) => (
            <label className="checkbox" key={status}>
              <input
                type="checkbox"
                checked={
                  !Array.isArray(args.exclude_statuses) ||
                  !args.exclude_statuses.includes(status)
                }
                onChange={(e) => {
                  const excluded = new Set(
                    Array.isArray(args.exclude_statuses)
                      ? args.exclude_statuses
                      : [],
                  );
                  if (e.target.checked) excluded.delete(status);
                  else excluded.add(status);
                  const next = statuses.filter((value) => excluded.has(value));
                  change({
                    ...args,
                    exclude_statuses: next.length ? next : undefined,
                  });
                }}
              />
              {
                {
                  next: "Next",
                  inbox: "Inbox",
                  waiting: "Waiting",
                  blocked: "Blocked",
                  someday: "Someday",
                  done: "Done",
                }[status]
              }
            </label>
          ))}
        </fieldset>
      )}
      {(
        [
          ["due", "Due"],
          ["planned", "Planned"],
        ] as const
      ).map(([prefix, title]) => (
        <fieldset className="filter-range" key={prefix}>
          <legend>{title}</legend>
          <div className="filter-range-fields">
            {(["from", "through"] as const).map((bound) => (
              <DateFilter
                key={bound}
                label={bound === "from" ? "From" : "Through"}
                name={`${title} ${bound}`}
                value={String(args[`${prefix}_${bound}`] || "")}
                change={(value) =>
                  change({
                    ...args,
                    ...(prefix === "due" ? { undated: false } : {}),
                    [`${prefix}_${bound}`]: value || undefined,
                  })
                }
              />
            ))}
          </div>
        </fieldset>
      ))}
      <div className="filter-options">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!args.undated}
            onChange={(e) =>
              change({
                ...args,
                due_from: undefined,
                due_through: undefined,
                undated: e.target.checked,
              })
            }
          />
          Undated
        </label>
        {scope === "all" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={args.archived !== false}
              onChange={(e) =>
                change({
                  ...args,
                  archived: e.target.checked ? undefined : false,
                })
              }
            />
            Include archived
          </label>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!args.include_deleted}
            onChange={(e) =>
              change({ ...args, include_deleted: e.target.checked })
            }
          />
          Deleted
        </label>
      </div>
    </>
  );
}
