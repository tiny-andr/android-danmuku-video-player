#!/usr/bin/env node
// Stage built APKs into a stable, versioned layout under <project>/dist/.
//
// Gradle writes app-universal-{debug,release}.apk into a deep build/ tree with
// fixed names and no version, so the file that actually gets published leaves no
// trace locally. This copies each one to a name that sorts correctly and carries
// the version, which is also what the release upload reads from.
//
// Naming rule: the debug artifact must sort AFTER the release artifact, because
// GitHub lists release assets alphabetically. "Bplayer-Android-0.2.0.apk" and
// "Bplayer-Android-debug-0.2.0.apk" differ at the character after "Android-":
// '0' (0x30) < 'd' (0x64), so the release build lands first. Keeping version
// first and "debug" second is what preserves that order.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const outputRoot = join(root, 'src-tauri/gen/android/app/build/outputs/apk/universal');
const dist = join(root, 'dist');

const artifacts = [
  {
    label: 'release',
    from: join(outputRoot, 'release/app-universal-release.apk'),
    to: `Bplayer-Android-${version}.apk`,
  },
  {
    label: 'debug',
    from: join(outputRoot, 'debug/app-universal-debug.apk'),
    to: `Bplayer-Android-debug-${version}.apk`,
  },
];

mkdirSync(dist, { recursive: true });

const missing = [];
for (const artifact of artifacts) {
  if (!existsSync(artifact.from)) {
    missing.push(artifact);
    continue;
  }
  const target = join(dist, artifact.to);
  copyFileSync(artifact.from, target);
  const megabytes = (statSync(target).size / (1024 * 1024)).toFixed(1);
  console.log(`${artifact.to}  ${megabytes} MB`);
}

if (missing.length > 0) {
  console.error('');
  for (const artifact of missing) {
    console.error(`missing ${artifact.label} build: ${artifact.from}`);
  }
  console.error('run the build for that variant first, or use "npm run android:dist"');
  process.exit(1);
}

console.log(`\nstaged into ${dist}`);
