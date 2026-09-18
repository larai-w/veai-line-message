import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const build = fileURLToPath(new URL('../scripts/build-package.mjs', import.meta.url));
const routing = fileURLToPath(new URL('./carecall-routing.test.mjs', import.meta.url));
test('deployment archive preserves every entry and contains only runtime modules', t => {
  const dir = mkdtempSync(join(tmpdir(), 'line-package-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const zip = join(dir, 'function.zip');
  const built = spawnSync(process.execPath, [build, zip], {encoding:'utf8'});
  assert.equal(built.status, 0, built.stderr);
  const listing = spawnSync('unzip', ['-Z1', zip], {encoding:'utf8'});
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split('\n').sort(), ['carecall.mjs','index.mjs']);
  assert.equal(spawnSync('unzip', ['-q', zip, '-d', dir]).status, 0);
  const checked = spawnSync(process.execPath, ['--test', routing], {
    env:{...process.env, ROUTING_TEST_ENTRY:join(dir,'index.mjs'), CARECALL_ENABLED:'0'}, encoding:'utf8'
  });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});
test('packaging refuses an existing archive without changing it', t => {
  const dir=mkdtempSync(join(tmpdir(),'line-package-existing-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const zip=join(dir,'function.zip');writeFileSync(zip,'existing artifact');
  assert.notEqual(spawnSync(process.execPath,[build,zip]).status,0);
  assert.equal(readFileSync(zip,'utf8'),'existing artifact');
});
