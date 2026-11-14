import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export function createPasswords() {
  const hashPassword = (password: string) => hash(password, {
    // Argon2id's documented numeric value; the package's ambient const enum
    // cannot be imported with verbatimModuleSyntax.
    algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32,
  });
  let dummy: Promise<string> | undefined;
  return {
    hash: hashPassword,
    async matches(password: string, encoded?: string) {
      // Pay the one-time dummy creation cost for known and unknown accounts alike.
      const dummyHash = await (dummy ??= hashPassword(randomBytes(32).toString('hex')));
      const target = encoded ?? dummyHash;
      try { return await verify(target, password); } catch { return false; }
    },
  };
}
