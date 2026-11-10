import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Include full notices for every installed production dependency, including
// transitive packages. Development tools are not shipped with the browser app.
export async function writeNotices(directory = "dist") {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const notices = ['GTD — third-party browser dependencies\nFirst-party code: AGPL-3.0-only. See the repository LICENSE.'];
  for (const [path, pkg] of Object.entries(lock.packages).sort()) {
    if (!path || pkg.dev || pkg.optional) continue;
    const names = (await readdir(path)).filter(n => /^(license|licence|copying|notice)([.-]|$)/i.test(n));
    if (!names.length) throw Error(`Missing license notice for ${path}; review before distributing`);
    const texts = await Promise.all(names.map(n => readFile(join(path, n), 'utf8')));
    notices.push(`${path.replace(/^node_modules\//, '')}@${pkg.version}\n${texts.join('\n')}`);
  }
  await writeFile(`${directory}/THIRD_PARTY_NOTICES.txt`, notices.join('\n\n--------------------\n\n'));
}
