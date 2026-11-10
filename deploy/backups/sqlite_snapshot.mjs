// Private cutover/rehearsal helper for the existing Node 24 image. Fixed mounts,
// read-only source, explicit database identity, and no application initialization.
import {DatabaseSync, backup} from 'node:sqlite';
import {closeSync, openSync, copyFileSync, constants, statSync, unlinkSync} from 'node:fs';
import assert from 'node:assert/strict';

let source;
let copied = false;
try {
  const identity = process.argv[1];
  assert(/^[0-9a-f-]{36}$/.test(identity));
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--stopped'));
  let path = '/data/todo.sqlite3';
  if (process.argv[2] === '--stopped') {
    // The operator has separately proved that every writer is stopped. A clean
    // shutdown removes WAL/SHM, but a read-only WAL-mode database still needs
    // writable sidecars. Copy only after proving no committed WAL is omitted;
    // the original volume remains read-only, including its main database.
    try { assert.equal(statSync(path+'-wal').size, 0); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    copyFileSync(path, '/backup/.stopped-source.sqlite3', constants.COPYFILE_EXCL);
    copied = true;
    path = '/backup/.stopped-source.sqlite3';
  }
  source = new DatabaseSync(path, {readOnly: true, timeout: 5000});
  source.exec('BEGIN');
  const meta = Object.fromEntries(source.prepare('SELECT key,value FROM store_meta').all().map(row => [row.key,row.value]));
  assert.equal(meta.identity, identity);
  assert.equal(meta.environment, 'production');
  assert.equal(source.prepare('PRAGMA user_version').get().user_version, 11);
  closeSync(openSync('/backup/todo.sqlite3', 'wx', 0o600));
  await backup(source, '/backup/todo.sqlite3', {rate: 256});
  source.exec('ROLLBACK');
} catch {
  process.stderr.write('Read-only SQLite snapshot failed; existing backups were preserved.\n');
  process.exitCode = 1;
} finally {
  source?.close();
  if (copied) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync('/backup/.stopped-source.sqlite3'+suffix); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
