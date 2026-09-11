import fs from 'node:fs';
import path from 'node:path';
import { probeMediaFacts } from './src/normalization/ffprobe-facts.mjs';
import { isDerivativeFile } from './src/normalization/classification.mjs';

const roots = [
  'G:\\Media\\VR\\VR_Video_Processing\\01_Download_Completed',
  'G:\\Media\\VR\\Render'
];

async function scan() {
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && /\.(mp4|mov|m4v|mkv|webm)$/i.test(ent.name)) {
          files.push({ root, fullPath: p, relPath: path.relative(root, p) });
        }
      }
    }
    walk(root);
  }

  console.log(`Scanning ${files.length} media files across roots with concurrency 8...`);
  const items = new Array(files.length);
  const queue = files.map((f, index) => ({ ...f, index }));
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      const isDeriv = isDerivativeFile(item.fullPath);
      let facts = null;
      if (!isDeriv) {
        facts = await probeMediaFacts(item.fullPath);
      }
      items[item.index] = {
        root: item.root,
        fullPath: item.fullPath,
        relPath: item.relPath,
        isDerivative: isDeriv,
        facts
      };
      completed++;
      if (completed % 100 === 0 || completed === files.length) {
        console.log(`Probed ${completed} / ${files.length} files (${Math.round((completed / files.length) * 100)}%)...`);
      }
    }
  }

  const workers = Array.from({ length: 8 }, () => worker());
  await Promise.all(workers);

  fs.writeFileSync('prototype/lan_secure_origin/scanned_raw_library.json', JSON.stringify(items, null, 2), 'utf8');
  console.log(`Scan complete! Saved facts for ${items.length} files to scanned_raw_library.json`);
}

scan().catch(console.error);
