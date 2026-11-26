#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile, chmod, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { createHash, randomUUID } from 'node:crypto';
import { reviewSiteContent } from './content-policy.mjs';

const api = (process.env.OPENDEPLOY_API || 'https://app.opendeploy.ru').replace(/\/$/, '');
const endpoint = new URL(api);
if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost','127.0.0.1'].includes(endpoint.hostname))) throw new Error('Для удалённого API требуется HTTPS.');
const credential = path.join(homedir(), '.opendeploy', `${createHash('sha256').update(api).digest('hex').slice(0, 16)}.json`);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BUILD_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 500;
async function call(url, options = {}) {
 const response = await fetch(api + url, { ...options, signal: AbortSignal.timeout(30000) });
 const type = response.headers.get('content-type') || '';
 if (!type.includes('application/json')) throw new Error(`Сервис вернул HTTP ${response.status} без JSON. Проверьте адрес API и настройки доступа.`);
 const data = await response.json();
 if (!response.ok && response.status !== 202) throw new Error(data.message || `HTTP ${response.status}`);
 return data;
}
async function access() {
 try { const item = JSON.parse(await readFile(credential, 'utf8')); if (typeof item.access_token !== 'string') throw Error(); return item.access_token; }
 catch { throw new Error('Сначала подключите аккаунт командой login.'); }
}
async function zipDirectory(source, dest) {
 const root = await stat(source).catch(() => null);
 if (!root?.isDirectory()) throw new Error('Укажите существующую папку статической сборки.');
 const index = await stat(path.join(source, 'index.html')).catch(() => null);
 if (!index?.isFile()) throw new Error('В корне сборки должен быть index.html.');
 const zip = new yazl.ZipFile(); let count = 0, total = 0;
 async function walk(dir, relative = '') {
  for (const item of await readdir(dir, { withFileTypes: true })) {
   if (item.isSymbolicLink() || item.name.startsWith('.')) throw new Error(`Уберите скрытые файлы и ссылки из сборки: ${item.name}`);
   if (/(?:^id_(?:rsa|ed25519)$|\.(?:pem|key|p12|pfx)$)/i.test(item.name)) throw new Error(`Уберите возможный секрет из сборки: ${item.name}`);
   const abs = path.join(dir, item.name), rel = path.posix.join(relative, item.name);
   if (item.isDirectory()) await walk(abs, rel);
   else if (item.isFile()) { const file = await stat(abs); if (file.size > MAX_FILE_BYTES) throw new Error(`Файл ${rel} превышает лимит 10 МиБ.`); total += file.size; if (total > MAX_BUILD_BYTES) throw new Error('Сборка превышает лимит 25 МиБ.'); if (++count > MAX_FILES) throw new Error('Сборка содержит больше 500 файлов.'); zip.addFile(abs, rel); }
   else throw new Error('Недопустимый тип файла.');
  }
 }
 await walk(source);
 const done = pipeline(zip.outputStream, createWriteStream(dest, { flags: 'wx', mode: 0o600 })); zip.end(); await done;
 const size = (await stat(dest)).size; if (size > MAX_ARCHIVE_BYTES) throw new Error('ZIP-архив превышает лимит 10 МиБ.');
}
const [command, ...args] = process.argv.slice(2);
try {
 if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log('Команды: login, projects, check <поддомен>, create <название>, review <папка сборки>, deploy <id> <поддомен> <папка сборки> --content-reviewed.');
  process.exit(0);
 }
 if (!['login', 'projects', 'check', 'create', 'review', 'deploy'].includes(command)) throw new Error(`Неизвестная команда: ${command}. Используйте --help.`);
 if (command === 'login') {
  const data = await call('/v1/auth/device', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({client_name:'OpenDeploy AI Agent'}) });
  console.log(`Откройте ${data.verification_uri} и введите код ${data.user_code}`);
  const deadline = Date.now() + data.expires_in*1000;
  while (Date.now() < deadline) {
   await new Promise(resolve => setTimeout(resolve, Math.max(5, data.interval)*1000));
   const result = await call('/v1/auth/device/token', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({device_code:data.device_code}) });
   if (result.access_token) { await mkdir(path.dirname(credential), { recursive:true, mode:0o700 }); await writeFile(credential, JSON.stringify(result), { mode:0o600 }); await chmod(credential,0o600); console.log('Аккаунт подключён.'); process.exit(0); }
  }
  throw new Error('Время подключения истекло.');
 }
 if (command === 'review') {
  if (args.length !== 1) throw new Error('Используйте review <папка сборки>.');
  const report = await reviewSiteContent(path.resolve(args[0]));
  console.log(JSON.stringify({status:'requires_agent_review', ...report, message:'Проверьте смысл всех страниц, изображений, видео и других файлов. При запретном или сомнительном содержимом остановите публикацию.'}, null, 2));
  process.exit(0);
 }
 if (command === 'deploy') {
  const [id, slug, folder, flag] = args;
  if (!id || !slug || !folder || flag !== '--content-reviewed' || args.length !== 4) throw new Error('Используйте deploy <id проекта> <поддомен> <папка сборки> --content-reviewed после проверки содержимого агентом.');
  await reviewSiteContent(path.resolve(folder));
 }
 const accessToken = await access(), headers = { authorization:`Bearer ${accessToken}` };
 if (command === 'projects') console.log(JSON.stringify(await call('/v1/agent/projects', { headers }), null, 2));
 else if (command === 'check') { if (!args[0]) throw new Error('Укажите желаемый поддомен.'); console.log(JSON.stringify(await call(`/v1/agent/subdomains/check?name=${encodeURIComponent(args[0])}`, { headers }), null, 2)); }
 else if (command === 'create') { if (!args[0]) throw new Error('Укажите название сайта.'); console.log(JSON.stringify(await call('/v1/agent/projects', { method:'POST', headers:{...headers,'content-type':'application/json'}, body:JSON.stringify({name:args.join(' ')}) }), null, 2)); }
 else if (command === 'deploy') {
  const [id, slug, folder] = args;
  const archive = path.join(tmpdir(), `opendeploy-${randomUUID()}.zip`);
  try {
   await zipDirectory(path.resolve(folder), archive);
   const form = new FormData(); form.set('subdomain',slug); form.set('file',new Blob([await readFile(archive)],{type:'application/zip'}),'site.zip');
   const result = await call(`/v1/agent/projects/${encodeURIComponent(id)}/deploy`, { method:'POST', headers, body:form });
   if (result.status === 'ready_to_verify') {
    try { const check = await fetch(result.url, { signal:AbortSignal.timeout(10000), redirect:'manual' }); result.availability = check.ok ? 'reachable' : 'unverified'; }
    catch { result.availability = 'unverified'; }
   }
   console.log(JSON.stringify(result,null,2));
  } finally { await unlink(archive).catch(()=>{}); }
 } else throw new Error('Команды: login, projects, check <поддомен>, create <название>, review <папка сборки>, deploy <id> <поддомен> <папка сборки> --content-reviewed.');
} catch (e) { console.error(e.message); process.exitCode=1; }
