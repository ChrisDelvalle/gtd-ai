// Synthetic regression content only; not imported by shipped application code.
export function fixtureContent(name,args) {
 if(['capture_item','create_project'].includes(name))return {brief:'Complete this disposable fixture.',agent_notes:'Isolated adapter regression; no real commitment.',...args};
 if(name==='create_recurrence')return {...args,template:{brief:'Perform this recurring fixture.',agent_notes:'Shared disposable context.',...args.template}};
 if(name==='apply_changes')return {...args,operations:args.operations.map(op=>fixtureContent({capture:'capture_item',create_project:'create_project',create_recurrence:'create_recurrence'}[op.operation],op))};
 return args;
}
