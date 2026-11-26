import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {reviewSiteContent} from '../bin/content-policy.mjs';

const cli = fileURLToPath(new URL('../bin/opendeploy.mjs', import.meta.url));

async function site(html) {
  const folder = await mkdtemp(path.join(tmpdir(), 'opendeploy-policy-'));
  await writeFile(path.join(folder, 'index.html'), html);
  return folder;
}

test('allows an ordinary static site for agent review', async () => {
  const folder = await site('<h1>Портфолио фотографа</h1>');
  try {
    await writeFile(path.join(folder, 'portrait.png'), Buffer.from([0, 1, 2]));
    assert.deepEqual(await reviewSiteContent(folder), {filesChecked:2, mediaFiles:['portrait.png'], otherFiles:[]});
  } finally { await rm(folder, {recursive:true, force:true}); }
});

for (const [category, content] of [
  ['контент для взрослых', '<h1>Порно видео</h1>'],
  ['оружие', '<h1>Купить оружие</h1>'],
  ['наркотики', '<h1>Продажа наркотиков</h1>'],
  ['фишинг', '<h1>Phishing portal</h1>'],
]) {
  test(`stops ${category} before upload`, async () => {
    const folder = await site(content);
    try {
      await assert.rejects(() => reviewSiteContent(folder), /публикация остановлена/i);
      const result = spawnSync(process.execPath, [cli, 'deploy', 'project', 'example', folder, '--content-reviewed'], {
        encoding:'utf8',
        env:{...process.env, HOME:folder, OPENDEPLOY_API:'http://127.0.0.1:3100'},
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /публикация остановлена/i);
      assert.doesNotMatch(result.stderr, /подключите аккаунт/i);
    } finally { await rm(folder, {recursive:true, force:true}); }
  });
}

test('scans nested files and filenames', async () => {
  const folder = await site('<h1>Обычный сайт</h1>');
  try {
    await mkdir(path.join(folder, 'pages'));
    await writeFile(path.join(folder, 'pages', 'weapons.html'), '<h1>Каталог</h1>');
    await assert.rejects(() => reviewSiteContent(folder), /оружие и взрывчатые вещества/);
  } finally { await rm(folder, {recursive:true, force:true}); }
});

test('deploy requires explicit completed content review', async () => {
  const folder = await site('<h1>Обычный сайт</h1>');
  try {
    const result = spawnSync(process.execPath, [cli, 'deploy', 'project', 'example', folder], {
      encoding:'utf8',
      env:{...process.env, HOME:folder, OPENDEPLOY_API:'http://127.0.0.1:3100'},
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--content-reviewed/);
  } finally { await rm(folder, {recursive:true, force:true}); }
});
