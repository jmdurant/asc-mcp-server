import { importPKCS8, SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import type { Config } from './config.js';

let cachedKey: CryptoKey | null = null;
let cachedKeyPath: string | null = null;

async function getSigningKey(keyPath: string): Promise<CryptoKey> {
  if (!cachedKey || cachedKeyPath !== keyPath) {
    const pem = readFileSync(keyPath, 'utf8');
    cachedKey = await importPKCS8(pem, 'ES256');
    cachedKeyPath = keyPath;
  }
  return cachedKey;
}

export async function generateToken(config: Config): Promise<string> {
  const key = await getSigningKey(config.keyPath);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })
    .setIssuer(config.issuerId)
    .setIssuedAt()
    .setExpirationTime('20m')
    .setAudience('appstoreconnect-v1')
    .sign(key);
}
