import {useEffect, useRef} from "react";
export function BriefField({value = "", onChange, required = false}: {
  value?: string; onChange: (value: string) => void; required?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {ref.current?.setCustomValidity(Array.from(value).length > 600 ? "Use at most 600 characters." : required && !value.trim() ? "Add a brief." : "");}, [value, required]);
  return <label>Brief<textarea ref={ref} rows={2} maxLength={1200} required={required}
    value={value} onChange={event => onChange(event.target.value)} /></label>;
}
