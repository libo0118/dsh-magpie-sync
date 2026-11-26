import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readFile, mkdir, lstat, symlink, copyFile } from 'node:fs/promises';
const runtime = process.env.DSH_IMPLEMENTATION_DIR;
if (!runtime) throw new Error('请设置 DSH_IMPLEMENTATION_DIR 指向 DSH app/dsh 目录');
const require = createRequire(join(runtime, 'package.json'));
const { withFileLock } = require('@deepseek-ai/dsh-atomic-write');
const { saveManifest } = require('@deepseek-ai/dsh-plugin-manager/operations');
const { loadProfileDirectory, composeEntries } = require('@deepseek-ai/dsh-app-boot');
const profileDir = process.env.DSH_PROFILE_DIR;
if (!profileDir) throw new Error('请在 DSH 会话内运行安装脚本，以识别当前 profile');
const sourceDir = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const target = join(profileDir, 'node_modules', 'dsh-magpie-sync');
const filename = join(profileDir, 'package.json');
const backupDir = new URL('../evidence/', import.meta.url);
await mkdir(backupDir, { recursive: true });
await withFileLock(filename, async () => {
  const text = await readFile(filename, 'utf8');
  const manifest = JSON.parse(text);
  await copyFile(filename, new URL(`profile-manifest-before-${Date.now()}.json`, backupDir));
  let current;
  try { current = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    const { realpath } = await import('node:fs/promises');
    if (resolve(await realpath(target)) !== resolve(sourceDir)) throw new Error('已有同名插件位于其他目录，请通过插件管理页处理');
  } else await symlink(sourceDir, target, process.platform === 'win32' ? 'junction' : 'dir');
  manifest.dependencies ??= {};
  manifest.dependencies['dsh-magpie-sync'] = `link:${sourceDir.replaceAll('\\', '/')}`;
  manifest.dsh ??= {}; manifest.dsh.profile ??= {}; manifest.dsh.profile.bundles ??= [];
  if (!manifest.dsh.profile.bundles.includes('dsh-magpie-sync')) manifest.dsh.profile.bundles.push('dsh-magpie-sync');
  await saveManifest(profileDir, manifest);
  try {
    const loaded = loadProfileDirectory('dsh', profileDir, join(runtime, 'package.json'));
    const entries = composeEntries([...loaded.layers.map(x => x.patches), loaded.patches]);
    const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])]);
    if (!flatten(entries).some(row => row.id === 'magpie-model-sync')) throw new Error('profile 未组合出同步插件');
  } catch (error) {
    const { writeFileAtomic } = require('@deepseek-ai/dsh-atomic-write');
    await writeFileAtomic(filename, text, { mode: 0o600 });
    throw error;
  }
  console.log(JSON.stringify({ installed: true, profile: profileDir, package: 'dsh-magpie-sync', source: sourceDir, compositionVerified: true }));
}, { waitMs: 30000 });
