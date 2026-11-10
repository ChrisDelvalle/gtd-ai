// Shared descriptors and immutable UI resource for stdio and HTTP transports.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {registerAppResource, RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';

export const toolNames = Object.freeze(['capture_item','list_items','update_item','undo_change','apply_changes','list_changes','show_tasks','create_project','update_project','list_projects','show_projects','show_gtd','sync_state','create_recurrence','update_recurrence','list_occurrences','gtd_ui_read','gtd_ui_write']);
export const guidance = JSON.parse(readFileSync(new URL('../src/tool_guidance.json',import.meta.url),'utf8'));
const definitions = new Map([...guidance.tools,...guidance.app_only_facades].map(t=>[t.name,t]));
export const displayTools = new Set(['show_tasks','show_projects','show_gtd']);

export function presentation(html = readFileSync(new URL('./widget.html',import.meta.url),'utf8')) {
  const sha256 = createHash('sha256').update(html).digest('hex');
  return {html,sha256,uri:`ui://widget/gtd-${sha256.slice(0,20)}.html`};
}

export function authenticatedPresentation(bundle) {
  // Authenticated resources have a distinct immutable URI and require account
  // metadata before rendering data or enabling requests. Legacy stdio stays intact.
  if (!/<html(?=[\s>])/i.test(bundle.html)) throw Error('Widget document has no HTML root');
  if (!/<html\b[^>]*\bdata-account-binding="1"(?=[\s>])/i.test(bundle.html))
    throw Error('Authenticated adapter requires an account-bound widget build');
  return presentation(bundle.html.replace(/<html(?=[\s>])/i, `<html data-account-required="true"`));
}

export function decorateTools(tools, {uri, uiEnabled, authenticated = false}) {
  const expected = authenticated ? [...toolNames,'get_profile'] : toolNames;
  if (!Array.isArray(tools) || tools.length !== expected.length ||
      expected.some(name=>tools.filter(t=>t.name===name).length!==1)) throw Error('Unexpected backend contract');
  return tools.map(tool=>{
    const copy = structuredClone(tool);
    copy._meta ??= {};
    const definition = definitions.get(tool.name);
    if (definition) copy.description = definition.description ?? definition.description_variants[uiEnabled?'ui_enabled':'ui_disabled'];
    if (!uiEnabled || !displayTools.has(tool.name)) {
      if (copy._meta.ui) delete copy._meta.ui.resourceUri;
      delete copy._meta['openai/outputTemplate'];
    }
    // Preserve app-only visibility and authentication metadata when attaching UI.
    if (uiEnabled && displayTools.has(tool.name)) {
      copy._meta.ui = {...copy._meta.ui,resourceUri:uri};
      copy._meta['openai/outputTemplate'] = uri;
    }
    return copy;
  });
}

export function registerWidget(server, bundle, {host = 'openai', resource, log = ()=>{}} = {}) {
  const {html,uri,sha256} = bundle;
  const ui = {prefersBorder:false,csp:{connectDomains:[],resourceDomains:[],frameDomains:[]}};
  if (host === 'claude') {
    if (!resource) throw Error('Claude requires its configured MCP resource URL');
    ui.domain = createHash('sha256').update(resource).digest('hex').slice(0,32)+'.claudemcpcontent.com';
  }
  registerAppResource(server,'private-gtd-tasks',uri,{},async()=>{
    log('resources.read','info',{uri,mimeType:RESOURCE_MIME_TYPE,bytes:Buffer.byteLength(html),sha256});
    return {contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:html,_meta:{ui,
      'openai/ui':{availableDisplayModes:['inline','fullscreen'],preferredDisplayMode:'inline'}}}]};
  });
}
