import {readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';

const textExtensions = new Set(['.html', '.htm', '.txt', '.md', '.json', '.svg', '.js', '.mjs', '.css', '.xml']);
const mediaExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.pdf']);
const rules = [
  {name: 'контент для взрослых', pattern: /порн|эротик|секс[-\s]?(?:шоп|услуг)|эскорт|вебкам|\bporn(?:ography)?\b|\bxxx\b|\badult\s*(?:content|site|video)\b|\bsex\s*(?:shop|service|cam)\b|\bescort\b|18\s*\+/iu},
  {name: 'оружие и взрывчатые вещества', pattern: /оруж|пистолет|боеприпас|взрывчат|\bweapons?\b|\bfirearms?\b|\bguns?\b|\bammo\b|\bexplosives?\b/iu},
  {name: 'наркотики', pattern: /наркотик|кокаин|героин|метамфетамин|\billegal\s+drugs?\b|\bcocaine\b|\bheroin\b|\bmethamphetamine\b/iu},
  {name: 'мошенничество и вредоносные действия', pattern: /фишинг|кардинг|продаж[аи]\s+(?:поддельных|фальшивых)\s+документ|\bphishing\b|\bcarding\b|\bmalware\b|\bransomware\b/iu},
];

const stop = (reason, file) => {
  throw new Error(`ВНИМАНИЕ: публикация остановлена. ${reason}${file ? ` Файл: ${file}.` : ''} Удалите запрещённый контент и повторите проверку.`);
};

export async function reviewSiteContent(source) {
  const root = await stat(source).catch(() => null);
  if (!root?.isDirectory()) stop('Укажите существующую папку статической сборки.');
  const index = await stat(path.join(source, 'index.html')).catch(() => null);
  if (!index?.isFile()) stop('В корне сборки должен быть index.html.');

  let filesChecked = 0;
  const mediaFiles = [];
  const otherFiles = [];
  async function walk(dir, relative = '') {
    for (const item of await readdir(dir, {withFileTypes: true})) {
      const abs = path.join(dir, item.name);
      const rel = path.posix.join(relative, item.name);
      if (item.isSymbolicLink() || item.name.startsWith('.')) stop('Сборка содержит скрытый файл или ссылку.', rel);
      if (item.isDirectory()) { await walk(abs, rel); continue; }
      if (!item.isFile()) stop('Сборка содержит файл недопустимого типа.', rel);
      filesChecked++;
      if (filesChecked > 500) stop('Сборка содержит больше 500 файлов.');
      const details = await stat(abs);
      if (details.size > 10 * 1024 * 1024) stop('Файл превышает лимит 10 МиБ.', rel);
      for (const rule of rules) if (rule.pattern.test(rel)) stop(`В имени файла обнаружена категория «${rule.name}».`, rel);
      const extension = path.extname(item.name).toLowerCase();
      if (textExtensions.has(extension)) {
        const content = await readFile(abs, 'utf8');
        for (const rule of rules) if (rule.pattern.test(content)) stop(`Обнаружена категория «${rule.name}».`, rel);
      } else if (mediaExtensions.has(extension)) mediaFiles.push(rel);
      else otherFiles.push(rel);
    }
  }
  await walk(source);
  return {filesChecked, mediaFiles, otherFiles};
}
