#!/usr/bin/env node
// Fails if the production client bundle contains credentials or direct provider access.
// Run after `npm run build`. Reads the real key from env/.env (if any) only to search for it; never prints it.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve('dist/client');
if (!existsSync(dir)) {
  console.error('dist/client not found; run `npm run build` first.');
  process.exit(2);
}
let key = process.env.GEMINI_API_KEY ?? '';
if (!key && existsSync('.env')) {
  const m = readFileSync('.env', 'utf8').match(/^GEMINI_API_KEY=(.*)$/m);
  key = (m?.[1] ?? '').trim();
}
const patterns = [
  { name: 'Google API key pattern', re: /AIza[0-9A-Za-z_-]{20,}/ },
  { name: 'GEMINI_API_KEY identifier', re: /GEMINI_API_KEY/ },
  { name: 'ACCESS_TOKEN identifier', re: /ACCESS_TOKEN/ },
  { name: 'direct provider endpoint', re: /generativelanguage\.googleapis\.com/ },
];
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(dir);
let failures = 0;
for (const f of files) {
  const text = readFileSync(f, 'latin1');
  for (const { name, re } of patterns) {
    if (re.test(text)) {
      console.error(`FAIL ${path.relative(process.cwd(), f)}: ${name}`);
      failures++;
    }
  }
  if (key.length >= 10 && text.includes(key)) {
    console.error(`FAIL ${path.relative(process.cwd(), f)}: configured GEMINI_API_KEY value found`);
    failures++;
  }
}
if (failures) process.exit(1);
console.info(`OK: scanned ${files.length} client build files; no secrets or direct provider endpoints found${key ? ' (including the configured key value)' : ''}.`);
