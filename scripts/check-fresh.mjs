import { readFile } from 'node:fs/promises';

const target = process.argv[2] || 'site/index.html';
const html = /^https?:/.test(target) ? await fetch(target).then(response => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}) : await readFile(target, 'utf8');
const match = html.match(/<meta name="radar-date" content="(\d{4}-\d{2}-\d{2})">/);
if (!match) throw new Error('未找到 radar-date');
const age = (Date.now() - Date.parse(`${match[1]}T00:00:00+08:00`)) / 864e5;
console.log(`最新日报：${match[1]}，距今 ${age.toFixed(1)} 天`);
if (age > 2) process.exit(1);
