import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = resolve(process.argv[2] ?? 'function.zip');
// Refuse an existing archive: zip updates can retain obsolete or private files.
if (existsSync(output)) throw Error('Output archive already exists');
const result = spawnSync('zip', ['-q', output, 'index.mjs', 'carecall.mjs'], {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) throw Error('Deployment packaging failed');
