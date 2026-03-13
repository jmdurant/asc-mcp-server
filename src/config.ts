import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  keyId: string;
  issuerId: string;
  keyPath: string;
}

export function loadConfig(): Config {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyPath = process.env.ASC_KEY_PATH;

  if (!keyId) throw new Error('ASC_KEY_ID environment variable is required');
  if (!issuerId) throw new Error('ASC_ISSUER_ID environment variable is required');
  if (!keyPath) throw new Error('ASC_KEY_PATH environment variable is required');

  const resolvedPath = resolve(keyPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`API key file not found: ${resolvedPath}`);
  }

  return { keyId, issuerId, keyPath: resolvedPath };
}
