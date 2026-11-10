import type { ReactNode } from "react";

export function MetadataField({ label, children, kind }: {
  label: string;
  children: ReactNode;
  kind?: "deadline";
}) {
  return (
    <div className="metadata-row" data-kind={kind}>
      <span className="metadata-key">{label ? `${label}:` : null}</span>
      {children}
    </div>
  );
}

export function MetadataRow({ label, children, importance, status, kind }: {
  label: string;
  children: ReactNode;
  importance?: string;
  status?: string;
  kind?: "deadline";
}) {
  return (
    <MetadataField label={label} kind={kind}>
      <span className={`metadata-badge${importance ? " importance-badge" : ""}${status ? " status-badge" : ""}`} data-importance={importance} data-status={status}>
        {children}
      </span>
    </MetadataField>
  );
}
