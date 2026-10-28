// Item 19 (threat model row 65): the artifact frame's runtimes, into apps/web/dist/frame/ after Astro's build (which empties
// dist). The page fetches them from its own origin and hands them to the frame as text, so the frame needs no network:
// mermaid.js (Mermaid's own browser build), react.js (React and ReactDOM as globals, bundled here) and typescript.js
// (TypeScript's browser build, which turns a React artifact's JSX into plain JavaScript inside the frame).
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('../', import.meta.url)), out = path.join(root, 'apps', 'web', 'dist', 'frame');
const require = createRequire(import.meta.url);
await mkdir(out, { recursive: true });
await copyFile(path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js'), path.join(out, 'mermaid.js'));
await copyFile(require.resolve('typescript/lib/typescript.js'), path.join(out, 'typescript.js'));
const build = await rolldown({ input: path.join(root, 'apps', 'web', 'src', 'frame-react.mjs'), platform: 'browser', transform: { define: { 'process.env.NODE_ENV': '"production"' } } });
await build.write({ file: path.join(out, 'react.js'), format: 'iife', minify: true, codeSplitting: false });
await build.close();
