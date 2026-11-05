import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function decodeKey(key: string): Buffer {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== key) {
    throw new Error("Credential encryption requires a 32-byte base64 key");
  }
  return bytes;
}

/** The associated data every envelope is bound to unless a caller names its own. */
const defaultAad = "openmuse:credential:v1";
/** Versioned AES-256-GCM envelope: version.nonce.tag.ciphertext. `aad`
 * binds the envelope to a context (the credential store binds each entry to its scope and id),
 * so a ciphertext moved to another context does not decrypt; left out, it is what it always was. */
export function encryptSecret(plaintext: string, key: string, aad = defaultAad): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(key), nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(encrypted: string, key: string, aad = defaultAad): string {
  const keyBytes = decodeKey(key);
  const [version, nonceString, tagString, ciphertextString, extra] = encrypted.split(".");
  if (
    version !== "v1" ||
    nonceString === undefined ||
    tagString === undefined ||
    ciphertextString === undefined ||
    extra !== undefined
  ) {
    throw new Error("Invalid encrypted secret");
  }
  const encoded = [nonceString, tagString, ciphertextString];
  const [nonce, tag, ciphertext] = encoded.map((value) => Buffer.from(value, "base64url"));
  if (
    nonce.length !== 12 ||
    tag.length !== 16 ||
    encoded.some(
      (value, index) => Buffer.from(value, "base64url").toString("base64url") !== encoded[index],
    )
  ) {
    throw new Error("Invalid encrypted secret");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to authenticate or decrypt credential");
  }
}
