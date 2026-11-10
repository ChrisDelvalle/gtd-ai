import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
const roots = ["src/website.tsx", "src/widget-adapter.tsx"];
test("production dependency graph excludes all demo code and fixtures", async () => {
  const output = await build({
    entryPoints: roots,
    bundle: true,
    write: false,
    outdir: "/tmp/gtd-demo-package-check",
    metafile: true,
    format: "esm",
    splitting: true,
    logLevel: "silent",
    define: {
      __GTD_SOURCE_URL__: '"https://example.com/source"',
      __GTD_SOURCE_REVISION__: '"test"',
    },
  });
  assert.deepEqual(
    Object.keys(output.metafile.inputs).filter((p) => /(^|\/)demo\//.test(p)),
    [],
  );
  for (const file of output.outputFiles)
    assert.ok(
      !file.text.includes("Maya Rivera") &&
        !file.text.includes("script-capture-once"),
    );
});
test("Pages artifact has only local entry assets and an explicit static CSP", async () => {
  for (const name of ["website", "chat", "widget"]) {
    const html = await readFile(`dist-demo/${name}/index.html`, "utf8");
    assert.match(html, /default-src 'none'/);
    assert.match(html, /connect-src 'self'/);
    assert.match(html, /form-action 'none'/);
    for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g))
      assert.match(url, /^\.\.\/assets\//);
  }
  const files = await readdir("dist-demo/assets");
  assert.equal(files.filter((x) => x.startsWith("maya-")).length, 1);
  const fixture = JSON.parse(
    await readFile(
      "dist-demo/assets/" + files.find((x) => x.startsWith("maya-")),
    ),
  );
  assert.equal(fixture.records.length, 1097);
  assert.ok(
    (await readFile("dist-demo/THIRD_PARTY_NOTICES.txt", "utf8")).includes(
      "react@",
    ),
  );
});
