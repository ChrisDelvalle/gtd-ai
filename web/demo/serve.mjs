import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("dist-demo"),
  port = Number(process.env.DEMO_PORT || 4175);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".txt": "text/plain",
};
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/gtd-ai/")) {
      res.writeHead(302, { Location: "/gtd-ai/website/" });
      return res.end();
    }
    let path = resolve(
      root,
      decodeURIComponent(url.pathname.slice("/gtd-ai/".length)),
    );
    if (path !== root && !path.startsWith(root + "/")) throw Error();
    if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
    res.writeHead(200, {
      "Content-Type": types[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(
    `Demos: http://127.0.0.1:${port}/gtd-ai/website/ and /gtd-ai/chat/`,
  ),
);
