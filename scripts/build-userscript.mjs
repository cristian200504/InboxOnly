import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const { version } = JSON.parse(await read('package.json'));
const [rules, policy, guard] = await Promise.all([
  read('InboxOnly/Resources/navigation-rules.json'),
  read('InboxOnly/Resources/policy.js'),
  read('InboxOnly/Resources/guard.js'),
]);
const metadata = `// ==UserScript==
// @name         InboxOnly - Instagram messages
// @namespace    inboxonly.local
// @version      ${version}
// @description  Keep Instagram messages; block feed, Reels, Explore and profiles, including Reels opened from a chat.
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @run-at       document-start
// @inject-into  auto
// @grant        none
// ==/UserScript==
`;
const output = new URL('dist/InboxOnly.user.js', root);
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(output, `${metadata}\n(function () {\nwindow.InboxOnlyRules = ${JSON.stringify(JSON.parse(rules))};\n${policy}\n${guard}\n})();\n`);
console.log(`Built ${fileURLToPath(output)}`);
