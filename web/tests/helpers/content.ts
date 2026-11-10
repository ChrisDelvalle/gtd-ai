// Required content for disposable regression records; never used by application code.
export function fixtureContent(name: string, args: Record<string, unknown>) {
  const fields = {brief: "Complete this disposable interface fixture.", ...args};
  if (["capture_item", "create_project"].includes(name)) return fields;
  if (name === "create_recurrence") return {...args, template: {brief: "Perform this recurring fixture.", ...(args.template as object)}};
  if (name === "apply_changes") return {...args, operations: (args.operations as Record<string,unknown>[]).map(op =>
    ["capture","create_project"].includes(String(op.operation)) ? {brief:"Complete this disposable batch fixture.",...op} : op)};
  return args;
}
