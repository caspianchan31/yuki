// The credential store's own key and envelope.
// The key lives in its own file (CREDENTIAL_KEY_FILE), apart from the data and apart from
// TOKEN_ENCRYPTION_KEY; it is read once at startup and handed only to the CredentialStore.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/secret-box.ts";

/** A 32-byte key, base64, as the file holds it. */
export type CredentialKey = string & { readonly __credentialKey: unique symbol };

const keyPattern = (text: string) => {
  const bytes = Buffer.from(text, "base64");
  return bytes.length === 32 && bytes.toString("base64") === text;
};

/** A new random key. */
export const randomCredentialKey = () => randomBytes(32).toString("base64") as CredentialKey;
let processKey: CredentialKey | undefined;
/** The key of this process for the sample workspace, which holds only made-up data: one per
 * process, so every store this process opens on one database agrees. */
export const processCredentialKey = () => {
  processKey ??= randomCredentialKey();
  return processKey;
};
/** Whether `key` is this process's sample key (made-up data only, gone with the process). */
export const isProcessCredentialKey = (key: CredentialKey) =>
  processKey !== undefined && key === processKey;

/**
 * Reads the credential key for this process. Live mode refuses to start without the file, with
 * a file that is not one 32-byte base64 key, or with the same key as TOKEN_ENCRYPTION_KEY (the
 * two are kept apart on purpose). The sample workspace takes the file when one is named, else a
 * key that lives only in this process.
 */
export async function readCredentialKey(options: {
  mode: "live" | "sample";
  file: string | undefined;
  tokenKey: string | undefined;
}): Promise<CredentialKey> {
  const file = options.file?.trim();
  if (!file) {
    if (options.mode === "live")
      throw new Error(
        "Live mode requires CREDENTIAL_KEY_FILE: the path of a file holding the credential store's 32-byte base64 key",
      );
    return processCredentialKey();
  }
  let text: string;
  try {
    text = (await readFile(file, "utf8")).trim();
  } catch {
    throw new Error("CREDENTIAL_KEY_FILE could not be read");
  }
  if (!keyPattern(text)) throw new Error("CREDENTIAL_KEY_FILE must hold one 32-byte key in base64");
  if (options.mode === "live" && options.tokenKey && text === options.tokenKey.trim())
    throw new Error(
      "CREDENTIAL_KEY_FILE must hold a key of its own, not TOKEN_ENCRYPTION_KEY: the credential store is kept apart from the rest of the data",
    );
  return text as CredentialKey;
}

/** Whether a string is a usable credential key. */
export const isCredentialKey = (value: string): value is CredentialKey => keyPattern(value);

/** The first 8 hex characters of the key's SHA-256: kept with the data, so a start with a key
 * that does not belong to it is refused instead of reading every entry as unreadable. */
export const keyFingerprint = (key: CredentialKey) =>
  createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 8);

/** The associated data of one entry: its ciphertext opens only under this scope and id. */
const entryAad = (scope: string, id: string) => `openmuse:credential-store:v1:${scope}:${id}`;

export function seal(key: CredentialKey, scope: string, id: string, plaintext: string) {
  return encryptSecret(plaintext, key, entryAad(scope, id));
}
/** The plaintext, or undefined when the ciphertext does not open under this key, scope and id. */
export function unseal(key: CredentialKey, scope: string, id: string, ciphertext: string) {
  try {
    return decryptSecret(ciphertext, key, entryAad(scope, id));
  } catch {
    return undefined;
  }
}
