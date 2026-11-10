import { build, transform } from "esbuild";
import { readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import { loadFixture } from "./demo/fixture.mjs";
import { writeNotices } from "./licenses.mjs";
const out = "dist-demo";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/assets`, { recursive: true });
const fixture = JSON.stringify(await loadFixture());
const fixtureName = `maya-${createHash("sha256").update(fixture).digest("hex").slice(0, 16)}.json`;
await writeFile(`${out}/assets/${fixtureName}`, fixture);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const result = await build({
  entryPoints: {
    website: "src/demo/website.tsx",
    chat: "src/demo/chat.tsx",
    widget: "src/demo/widget.tsx",
  },
  outdir: `${out}/assets`,
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  metafile: true,
  entryNames: "[name]-[hash]",
  chunkNames: "shared-[hash]",
  target: "es2022",
  legalComments: "inline",
  define: {
    "process.env.NODE_ENV": '"production"',
    __GTD_SOURCE_URL__: JSON.stringify(
      "https://github.com/ChrisDelvalle/gtd-ai",
    ),
    __GTD_SOURCE_REVISION__: JSON.stringify(revision),
    __DEMO_FIXTURE__: JSON.stringify(`./${fixtureName}`),
  },
});
const css = async (names) =>
  (
    await transform(
      (
        await Promise.all(names.map((n) => readFile(`src/${n}.css`, "utf8")))
      ).join("\n"),
      { loader: "css", minify: true },
    )
  ).code;
const base = await css([
  "style",
  "charts",
  "website-native",
  "widget-native",
  "floating-panel",
  "widget-display",
  "unified",
  "compact-secondary",
  "swipe-actions",
  "planning",
  "dependencies",
  "demo/demo",
]);
const styles = { app: base, chat: await css(["demo/chat"]) };
const sheets = {};
for (const [name, text] of Object.entries(styles)) {
  const file = `${name}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.css`;
  await writeFile(`${out}/assets/${file}`, text);
  sheets[name] = file;
}
const policy =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'self'; object-src 'none'";
for (const name of ["website", "chat", "widget"]) {
  const entry = Object.entries(result.metafile.outputs).find(
    ([, v]) => v.entryPoint === `src/demo/${name}.tsx`,
  )[0];
  await mkdir(`${out}/${name}`, { recursive: true });
  await writeFile(
    `${out}/${name}/index.html`,
    `<!doctype html><html lang="en" data-theme="${name === "website" ? "light" : "dark"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><title>GTD AI — ${name === "website" ? "Website demo" : name === "chat" ? "Chat demo" : "Interactive widget"}</title><link rel="icon" href="../assets/gtd-icon.png"><link rel="stylesheet" href="../assets/${sheets[name === "chat" ? "chat" : "app"]}"></head><body${name === "widget" ? ' class="widget"' : ""}><div id="root"></div><script type="module" src="../assets/${basename(entry)}"></script></body></html>`,
  );
}
await copyFile("src/gtd-icon.png", `${out}/assets/gtd-icon.png`);
await writeNotices(out);
await copyFile("../LICENSE", `${out}/LICENSE.txt`);
await writeFile(`${out}/.nojekyll`, "");
await writeFile(
  `${out}/index.html`,
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GTD AI demos</title><body><h1>GTD AI</h1><p><a href="./website/">Explore the website</a> · <a href="./chat/">Try the chat demo</a></p></body></html>',
);
await writeFile(
  `${out}/build-info.json`,
  JSON.stringify(
    {
      source: "https://github.com/ChrisDelvalle/gtd-ai",
      revision,
      fixture: fixtureName,
      logicalTime: "2026-11-06T18:00:00.000Z",
      license: "AGPL-3.0-only",
    },
    null,
    2,
  ),
);
await writeFile("demo-build-meta.json", JSON.stringify(result.metafile));
console.log(
  `Built two demos with ${Buffer.byteLength(fixture).toLocaleString()} bytes of fictional data.`,
);
