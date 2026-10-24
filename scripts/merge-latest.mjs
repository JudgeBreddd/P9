import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Each Windows runner writes a latest.yml naming only its own installer, and a release holds one latest.yml. This keeps
// the first file's top level (version, path, sha512, releaseDate) and lists every installer under files:, where
// electron-updater picks the .exe whose name holds its own process.arch (findFile in its Provider.js).
// electron-builder writes the file with js-yaml's dump, so files: is a block of lines indented two spaces.
export function mergeLatest(texts) {
  const parts = texts.map((text) => ({ version: /^version: (.+)$/m.exec(text)?.[1], files: /^files:\n((?: {2}.*\n)+)/m.exec(text)?.[1] }));
  if (parts.some((part) => !part.version || !part.files)) throw new Error('latest-yml-unreadable');
  if (parts.some((part) => part.version !== parts[0].version)) throw new Error('latest-yml-versions-differ');
  return texts[0].replace(parts[0].files, parts.map((part) => part.files).join(''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out, ...inputs] = process.argv.slice(2);
  if (inputs.length < 2) throw new Error('usage: merge-latest.mjs <out> <latest.yml> <latest.yml>...');
  await writeFile(out, mergeLatest(await Promise.all(inputs.map((file) => readFile(file, 'utf8')))));
}
