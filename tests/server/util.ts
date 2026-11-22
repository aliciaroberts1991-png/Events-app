import crypto from 'node:crypto';
export const sampleSlug = () => `test-${crypto.randomBytes(4).toString('hex')}`;
