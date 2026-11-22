// Writes docs/schemas/*.json from the Zod schemas the server validates with.
// Run after changing src/shared/research-schema.ts:  npm run docs:schema
import fs from 'node:fs';
import { loadConfig } from '../src/server/config';
import { buildOpenApi, researchJsonSchemas } from '../src/server/openapi';
import { exportFileSchema } from '../src/shared/local-data';
import { z } from 'zod';

const out = 'docs/schemas';
fs.mkdirSync(out, { recursive: true });
const s = researchJsonSchemas();
fs.writeFileSync(`${out}/research-import.schema.json`, JSON.stringify(s.ImportPayload, null, 2) + '\n');
fs.writeFileSync(`${out}/run-complete.schema.json`, JSON.stringify(s.RunComplete, null, 2) + '\n');
fs.writeFileSync(`${out}/run-fail.schema.json`, JSON.stringify(s.RunFail, null, 2) + '\n');
fs.writeFileSync(`${out}/device-data-export.schema.json`, JSON.stringify(z.toJSONSchema(exportFileSchema, { unrepresentable: 'any', io: 'input' }), null, 2) + '\n');
const ctx = { config: { ...loadConfig(), publicUrl: 'https://your-app.example.com' } } as never;
fs.writeFileSync(`${out}/openapi.json`, JSON.stringify(buildOpenApi(ctx), null, 2) + '\n');
console.log(`Wrote schemas to ${out}/`);
