import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(new URL('../web/', import.meta.url), dist, { recursive: true });
await rm(new URL('./server.js', dist), { force: true });
await cp(new URL('../engine/', import.meta.url), new URL('./engine/', dist), { recursive: true });
await cp(new URL('../agents/', import.meta.url), new URL('./agents/', dist), { recursive: true });
await cp(new URL('../balance-config.json', import.meta.url), new URL('./balance-config.json', dist));
await cp(new URL('../cards.json', import.meta.url), new URL('./cards.json', dist));
await mkdir(new URL('./vendor/', dist), { recursive: true });

await build({
  absWorkingDir: fileURLToPath(root),
  bundle: true,
  entryPoints: [fileURLToPath(new URL('./supabase-client.js', import.meta.url))],
  format: 'esm',
  outfile: fileURLToPath(new URL('./vendor/supabase.js', dist)),
  platform: 'browser',
});
