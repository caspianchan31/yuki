// One-time codes from a saved two-factor seed (RFC 4226 HOTP, RFC 6238
// TOTP), computed inside the credential store at the moment a code is typed. The seed never
// leaves the store.
import { createHmac } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";
/** The parameters of a seed as its otpauth:// link gives them. A bare base32 seed takes the
 * values the otpauth link format defines when a link leaves them out (6 digits, 30 seconds,
 * SHA1); they are stored with the entry and shown to the owner. */
export interface TotpParameters {
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
}
export const otpauthDefaults: TotpParameters = { digits: 6, period: 30, algorithm: "SHA1" };

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Base32 (RFC 4648) without padding, upper case, to bytes. */
export function base32Bytes(seed: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of seed.replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = "SHA1") {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code for `atSeconds` (Unix time). */
export function totp(key: Buffer, atSeconds: number, parameters: TotpParameters = otpauthDefaults) {
  return hotp(
    key,
    Math.floor(atSeconds / parameters.period),
    parameters.digits,
    parameters.algorithm,
  );
}
