import { readFile } from "node:fs/promises";
const root = new URL("./maya/", import.meta.url);
export async function loadFixture() {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", root), "utf8"),
  );
  const read = async (names) =>
    (
      await Promise.all(
        names.map(async (name) =>
          JSON.parse(await readFile(new URL(name, root), "utf8")),
        ),
      )
    ).flat();
  return {
    ...manifest,
    records: await read(manifest.records),
    changes: await read(manifest.changes),
  };
}
