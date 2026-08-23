#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 600;
const ROOT_DIR = process.cwd();

// Extensions to check for agent-authored source
const AUTHORED_EXTENSIONS = new Set([
  '.js', '.mjs', '.ts', '.html', '.css', '.py', '.ps1', '.sh', '.md', '.mdc', '.yaml', '.yml'
]);

// Ignored directories and patterns
const IGNORED_PATHS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.coverage',
  '.system_generated',
  '.user_uploaded'
];

function isIgnored(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  return IGNORED_PATHS.some(p => normalized.startsWith(p + '/') || normalized === p || normalized.includes('/' + p + '/'));
}

function countPhysicalLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content) return 0;
  // Count physical newline characters + 1
  return content.split(/\r\n|\r|\n/).length;
}

function scanDir(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ROOT_DIR, fullPath);

    if (isIgnored(relPath)) continue;

    if (entry.isDirectory()) {
      scanDir(fullPath, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUTHORED_EXTENSIONS.has(ext)) {
        // Exclude generated / data JSON or evidence files
        if (entry.name.endsWith('.min.js') || entry.name.endsWith('.min.css')) continue;
        const lines = countPhysicalLines(fullPath);
        results.push({ relPath: relPath.replace(/\\/g, '/'), lines });
      }
    }
  }
  return results;
}

const targetArg = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : ROOT_DIR;
const files = scanDir(targetArg);
let failed = false;

console.log(`=== 600-Line Code Structure Guardrail Check (Limit: ${MAX_LINES}) ===\n`);
console.log('STATUS | LINES | FILE');
console.log('------------------------------------------------------------');

for (const file of files) {
  if (file.lines > MAX_LINES) {
    console.error(`FAIL   | ${String(file.lines).padStart(5)} | ${file.relPath} > ${MAX_LINES}`);
    failed = true;
  } else {
    console.log(`PASS   | ${String(file.lines).padStart(5)} | ${file.relPath}`);
  }
}

console.log('------------------------------------------------------------');
if (failed) {
  console.error(`\n❌ GUARDRAIL FAILED: One or more files exceed the ${MAX_LINES}-line limit.\n`);
  process.exit(1);
} else {
  console.log(`\n✅ GUARDRAIL PASSED: All ${files.length} authored source files are within ${MAX_LINES} lines.\n`);
  process.exit(0);
}
