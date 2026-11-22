// Bundles the server (and the shared code it imports) into dist/server.
// npm packages stay external and are loaded from node_modules at runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts', 'src/server/cli.ts'],
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
