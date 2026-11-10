import { build, transform } from "esbuild";
import { execFileSync } from "node:child_process";
import { writeNotices } from "./licenses.mjs";
import { guardSplitModules } from "./split-modules.mjs";
import { mkdir, readFile, writeFile, readdir, copyFile, rm } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await writeFile(
  "dist/widget-probe.html",
  await readFile("src/widget-probe.html", "utf8"),
);
const sourceURL = process.env.GTD_SOURCE_URL || "https://github.com/ChrisDelvalle/gtd-ai";
const parsedSource = new URL(sourceURL);
if (parsedSource.protocol !== "https:" || parsedSource.username || parsedSource.password)
  throw Error("GTD_SOURCE_URL must be a public HTTPS source URL");
let sourceRevision = process.env.GTD_SOURCE_REVISION;
if (!sourceRevision) {
  try {
    const options = {encoding:"utf8", stdio:["ignore","pipe","ignore"]};
    sourceRevision = execFileSync("git", ["status", "--porcelain"], options).trim()
      ? "development" : execFileSync("git", ["rev-parse", "HEAD"], options).trim();
  }
  catch { sourceRevision = "development"; }
}
if (!/^(?:[a-f0-9]{40}|development)$/.test(sourceRevision)) throw Error("Invalid source revision");
const common = {
  bundle: true,
  minify: true,
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"', "__GTD_SOURCE_URL__": JSON.stringify(sourceURL), "__GTD_SOURCE_REVISION__": JSON.stringify(sourceRevision) },
  legalComments: "inline",
};
const bundledPages = [{
    name: "self-contained-pages",
    setup(builder) {
      builder.onResolve({filter: /\/lazy-pages$/}, () => ({path: resolve("src/bundled-pages.ts")}));
    },
  }];
const website = await build({
  ...common,
  entryPoints: ["src/website.tsx"],
  outdir: "dist/assets",
  entryNames: "app-[hash]",
  chunkNames: "[name]-[hash]",
  splitting: true,
  metafile: true,
  format: "esm",
});
const websiteEntry = Object.entries(website.metafile.outputs).find(([, value]) => value.entryPoint === "src/website.tsx")?.[0];
if (!websiteEntry) throw Error("Website entry was not emitted");
const initialModules = new Set();
function visitInitial(path) {
  for (const dependency of website.metafile.outputs[path]?.imports || []) {
    if (dependency.external || dependency.kind !== "import-statement" || initialModules.has(dependency.path)) continue;
    initialModules.add(dependency.path);
    visitInitial(dependency.path);
  }
}
visitInitial(websiteEntry);
const renamedModules = await guardSplitModules(website.metafile, new Set([websiteEntry, ...initialModules]));
const moduleHints = [...initialModules].map(path => `<link rel="modulepreload" href="/assets/${basename(renamedModules.get(path))}">`).join("");
await build({
  ...common,
  plugins: bundledPages,
  entryPoints: ["src/widget.tsx"],
  outfile: "dist/widget.js",
  format: "iife",
});
const css = (await readFile("src/style.css", "utf8")) + "\n" + (await readFile("src/charts.css", "utf8"));
const planningCss = (await readFile("src/planning.css", "utf8")) + "\n" + (await readFile("src/dependencies.css", "utf8"));
const nativeCss = await readFile("src/widget-native.css", "utf8");
const floatingCss = await readFile("src/floating-panel.css", "utf8");
const displayCss = await readFile("src/widget-display.css", "utf8");
const websiteCss = await readFile("src/website-native.css", "utf8");
const unifiedCss = await readFile("src/unified.css", "utf8");
const loginCss = await readFile("src/website-login.css", "utf8");
const usersCss = await readFile("src/website-users.css", "utf8");
const swipeCss = await readFile("src/swipe-actions.css", "utf8");
const secondaryCss = await readFile("src/compact-secondary.css", "utf8");
const websiteCssOutput = (await transform(`${css}\n${nativeCss}\n${floatingCss}\n${websiteCss}\n${unifiedCss}\n${secondaryCss}\n${swipeCss}\n${loginCss}\n${planningCss}\n${usersCss}`, { loader: "css", minify: true })).code;
const stylesheet = `style-${createHash("sha256").update(websiteCssOutput).digest("hex").slice(0,16)}.css`;
await writeFile(`dist/assets/${stylesheet}`, websiteCssOutput);
const head =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GTD</title>';
await writeFile(
  "dist/index.html",
  `${head.replace("initial-scale=1", "initial-scale=1,viewport-fit=cover")}<meta name="theme-color" content="#ffffff"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="GTD"><link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" href="/gtd-icon.png"><link rel="icon" href="/gtd-icon.png"><link rel="stylesheet" href="/assets/${stylesheet}">${moduleHints}</head><body><div id="root"></div><script type="module" src="/assets/${basename(renamedModules.get(websiteEntry))}"></script></body></html>`,
);
const js = (await readFile("dist/widget.js", "utf8")).replaceAll(
  "</script",
  "<\\/script",
);
await writeFile(
  "dist/widget.html",
  `${head}<style>${css}\n${floatingCss}\n${planningCss}</style></head><body class="widget"><div id="root"></div><script>${js}</script></body></html>`,
);
await writeFile(
  "dist/widget-chatgpt.html",
  `${head.replace('<html lang="en">', '<html lang="en" data-bridge="chatgpt">')}<style>${css}\n${floatingCss}\n${planningCss}</style></head><body class="widget"><div id="root"></div><script>${js}</script></body></html>`,
);
await build({
  ...common,
  plugins: bundledPages,
  entryPoints: ["src/widget-adapter.tsx"],
  outfile: "dist/widget-adapter.js",
  format: "iife",
});
const adapterJs = (await readFile("dist/widget-adapter.js", "utf8")).replaceAll(
  "</script",
  "<\\/script",
);
const adapterCss = (await transform(
  `${css}\n${websiteCss}\n${nativeCss}\n${floatingCss}\n${displayCss}\n${unifiedCss}\n${secondaryCss}\n${swipeCss}\n${planningCss}`,
  { loader: "css", minify: true },
)).code;
await writeFile(
  "dist/widget-adapter.html",
  `${head.replace('<html lang="en">', '<html lang="en" data-account-binding="1">')}<style>${adapterCss}</style></head><body class="widget"><div id="root"></div><script>${adapterJs}</script></body></html>`,
);

await writeFile("dist/gtd-icon.png", await readFile("src/gtd-icon.png"));
await writeFile(
  "dist/manifest.webmanifest",
  JSON.stringify({
    id: "/",
    name: "GTD",
    short_name: "GTD",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: "/gtd-icon.png",
        sizes: "256x256",
        type: "image/png",
        purpose: "any",
      },
    ],
  }),
);

// Only code/styles receive immutable compression; no user data enters this build.
const assetManifest = {};
for (const name of await readdir("dist/assets")) {
  const bytes = await readFile(`dist/assets/${name}`);
  const gzip = gzipSync(bytes, { level: 9 });
  const brotli = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  await writeFile(`dist/assets/${name}.gz`, gzip);
  await writeFile(`dist/assets/${name}.br`, brotli);
  assetManifest[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, gzip: gzip.length, brotli: brotli.length };
}
await writeFile("dist/asset-manifest.json", JSON.stringify(assetManifest, null, 2));

// A website-only release must not silently republish a different widget.
if (process.env.GTD_PUBLISHED_WIDGET_DIR) {
  const directory = resolve(process.env.GTD_PUBLISHED_WIDGET_DIR);
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8"));
  for (const [name, expected] of Object.entries(manifest)) {
    if (!/^widget(?:-[a-z]+)?\.(?:html|js)$/.test(name)) throw Error("Invalid published widget path");
    const bytes = await readFile(`${directory}/${name}`);
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw Error(`Published widget changed: ${name}`);
    await copyFile(`${directory}/${name}`, `dist/${name}`);
  }
  if (!manifest["widget-adapter.html"]) throw Error("Missing published adapter widget");
}

if (process.env.GTD_REQUIRE_ACCOUNT_WIDGET === "1") {
  const html = await readFile("dist/widget-adapter.html", "utf8");
  if (!html.includes('data-account-binding="1"') || !html.includes('gtd/expectedAccount'))
    throw Error("Authenticated release requires the matching account-bound widget, not a legacy published artifact");
}

await writeNotices();
await writeFile("dist/build-info.json", JSON.stringify({version: JSON.parse(await readFile("package.json", "utf8")).version, source: sourceURL, revision: sourceRevision, license: "AGPL-3.0-only"}, null, 2)+"\n");
