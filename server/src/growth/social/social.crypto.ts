import crypto from "crypto";

const encryptionError = () =>
  Object.assign(new Error("Social token encryption is not configured"), {
    code: "social_encryption_unavailable",
    statusCode: 503
  });

const encryptionKey = () => {
  const configured = process.env.GROWTH_SOCIAL_ENCRYPTION_KEY?.trim();
  if (!configured) throw encryptionError();
  const base64 = Buffer.from(configured, "base64");
  if (base64.length === 32) return base64;
  const hex = Buffer.from(configured, "hex");
  if (hex.length === 32) return hex;
  throw Object.assign(new Error("GROWTH_SOCIAL_ENCRYPTION_KEY must be a 32-byte base64 or hexadecimal key"), {
    code: "social_encryption_key_invalid",
    statusCode: 503
  });
};

export const encryptSocialSecret = (plaintext: string) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
};

export const decryptSocialSecret = (payload: string) => {
  const [version, ivValue, tagValue, ciphertextValue] = payload.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue)
    throw Object.assign(new Error("Encrypted social secret is malformed"), { code: "social_secret_invalid", statusCode: 500 });
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
};

export const generateOAuthState = () => crypto.randomBytes(32).toString("base64url");
export const hashOAuthState = (state: string) =>
  crypto.createHash("sha256").update(state, "utf8").digest("hex");
export const generatePkceVerifier = () => crypto.randomBytes(48).toString("base64url");
export const createPkceChallenge = (verifier: string) =>
  crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
export const fingerprintSocialContent = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
