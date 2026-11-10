declare const __GTD_SOURCE_URL__: string;
declare const __GTD_SOURCE_REVISION__: string;
export const sourceInfo = {
  url: __GTD_SOURCE_REVISION__ !== "development" && __GTD_SOURCE_URL__ === "https://github.com/ChrisDelvalle/todo-mcp"
    ? `${__GTD_SOURCE_URL__}/tree/${__GTD_SOURCE_REVISION__}` : __GTD_SOURCE_URL__,
  revision: __GTD_SOURCE_REVISION__,
};
