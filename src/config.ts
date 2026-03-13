import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  keyId: string;
  issuerId: string;
  keyPath: string;
  contactPhone?: string;
}

export interface ConfigError {
  variable: string;
  description: string;
  present: boolean;
  error?: string;
}

export function getConfigErrors(): ConfigError[] {
  const errors: ConfigError[] = [];

  const keyId = process.env.ASC_KEY_ID;
  errors.push({
    variable: 'ASC_KEY_ID',
    description: 'Your API Key ID',
    present: !!keyId,
    ...(!keyId ? { error: 'Not set' } : {}),
  });

  const issuerId = process.env.ASC_ISSUER_ID;
  errors.push({
    variable: 'ASC_ISSUER_ID',
    description: 'Your Issuer ID',
    present: !!issuerId,
    ...(!issuerId ? { error: 'Not set' } : {}),
  });

  const keyPath = process.env.ASC_KEY_PATH;
  if (!keyPath) {
    errors.push({
      variable: 'ASC_KEY_PATH',
      description: '/path/to/AuthKey_XXXXXX.p8',
      present: false,
      error: 'Not set',
    });
  } else {
    const resolvedPath = resolve(keyPath);
    if (!existsSync(resolvedPath)) {
      errors.push({
        variable: 'ASC_KEY_PATH',
        description: '/path/to/AuthKey_XXXXXX.p8',
        present: true,
        error: `File not found: ${resolvedPath}`,
      });
    } else {
      errors.push({
        variable: 'ASC_KEY_PATH',
        description: '/path/to/AuthKey_XXXXXX.p8',
        present: true,
      });
    }
  }

  return errors;
}

export function loadConfig(): Config | null {
  const errors = getConfigErrors();
  const hasErrors = errors.some(e => !!e.error);

  if (hasErrors) {
    return null;
  }

  return {
    keyId: process.env.ASC_KEY_ID!,
    issuerId: process.env.ASC_ISSUER_ID!,
    keyPath: resolve(process.env.ASC_KEY_PATH!),
    contactPhone: process.env.ASC_CONTACT_PHONE,
  };
}
