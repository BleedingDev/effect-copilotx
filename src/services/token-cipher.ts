import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ServiceMap from "effect/ServiceMap";

import { TokenCipherConfigurationError } from "#/domain/errors/token-cipher-configuration-error";
import { TokenCipherError } from "#/domain/errors/token-cipher-error";
import { AppConfig } from "#/services/app-config";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SERIALIZATION_VERSION = "v1";

export interface EncryptedSecret {
  readonly ciphertext: string;
  readonly keyId: string;
}

const decodeEncryptionKey = (
  rawKey: string
): Effect.Effect<Buffer, TokenCipherConfigurationError> => {
  const trimmed = rawKey.trim();

  if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
    return Effect.succeed(Buffer.from(trimmed, "hex"));
  }

  try {
    const buffer = Buffer.from(trimmed, "base64");
    if (buffer.byteLength === KEY_BYTES) {
      return Effect.succeed(buffer);
    }
  } catch {
    // fall through to the explicit error below.
  }

  return Effect.fail(
    new TokenCipherConfigurationError({
      message:
        "COPILOTX_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters or base64.",
    })
  );
};

const deriveKeyId = (configuredKeyId: string, rawKey: string) => {
  const trimmed = configuredKeyId.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return createHash("sha256").update(rawKey, "utf8").digest("hex").slice(0, 12);
};

const serializeCiphertext = (iv: Buffer, authTag: Buffer, ciphertext: Buffer) =>
  `${SERIALIZATION_VERSION}:${iv.toString("base64url")}:${authTag.toString("base64url")}:${ciphertext.toString("base64url")}`;

const parseCiphertext = (
  serialized: string
): Effect.Effect<
  {
    readonly authTag: Buffer;
    readonly ciphertext: Buffer;
    readonly iv: Buffer;
  },
  TokenCipherError
> => {
  const [version, iv, authTag, ciphertext] = serialized.split(":");

  if (
    version !== SERIALIZATION_VERSION ||
    iv === undefined ||
    authTag === undefined ||
    ciphertext === undefined
  ) {
    return Effect.fail(
      new TokenCipherError({
        message: "Encrypted token payload has an unknown format.",
        operation: "parse",
      })
    );
  }

  return Effect.try({
    catch: () =>
      new TokenCipherError({
        message: "Encrypted token payload is corrupted.",
        operation: "parse",
      }),
    try: () => ({
      authTag: Buffer.from(authTag, "base64url"),
      ciphertext: Buffer.from(ciphertext, "base64url"),
      iv: Buffer.from(iv, "base64url"),
    }),
  });
};

export class TokenCipher extends ServiceMap.Service<TokenCipher>()(
  "copilotx/TokenCipher",
  {
    make: Effect.gen(function* makeTokenCipher() {
      const config = yield* AppConfig;
      const rawKey = String(Redacted.value(config.security.tokenEncryptionKey));
      const key = yield* decodeEncryptionKey(rawKey);
      const keyId = deriveKeyId(config.security.tokenEncryptionKeyId, rawKey);

      const encrypt = Effect.fn("TokenCipher.encrypt")(function* encrypt(
        plaintext: string
      ) {
        return yield* Effect.try({
          catch: () =>
            new TokenCipherError({
              message: "Failed to encrypt the token payload.",
              operation: "encrypt",
            }),
          try: () => {
            const iv = randomBytes(IV_BYTES);
            const cipher = createCipheriv(ALGORITHM, key, iv);
            const ciphertext = Buffer.concat([
              cipher.update(plaintext, "utf8"),
              cipher.final(),
            ]);
            const authTag = cipher.getAuthTag();

            return {
              ciphertext: serializeCiphertext(iv, authTag, ciphertext),
              keyId,
            } satisfies EncryptedSecret;
          },
        });
      });

      const decrypt = Effect.fn("TokenCipher.decrypt")(function* decrypt(
        secret: EncryptedSecret
      ) {
        if (secret.keyId !== keyId) {
          return yield* Effect.fail(
            new TokenCipherError({
              message: `Unknown encryption key id: ${secret.keyId}`,
              operation: "decrypt",
            })
          );
        }

        const parsed = yield* parseCiphertext(secret.ciphertext);

        return yield* Effect.try({
          catch: () =>
            new TokenCipherError({
              message: "Failed to decrypt the token payload.",
              operation: "decrypt",
            }),
          try: () => {
            const decipher = createDecipheriv(ALGORITHM, key, parsed.iv);
            decipher.setAuthTag(parsed.authTag);
            const plaintext = Buffer.concat([
              decipher.update(parsed.ciphertext),
              decipher.final(),
            ]);
            return plaintext.toString("utf8");
          },
        });
      });

      const decryptOptional = Effect.fn("TokenCipher.decryptOptional")(
        function* decryptOptional(
          secret:
            | EncryptedSecret
            | {
                readonly ciphertext?: string | null;
                readonly keyId?: string | null;
              }
            | null
            | undefined
        ) {
          if (
            secret === null ||
            secret === undefined ||
            secret.ciphertext === undefined ||
            secret.ciphertext === null ||
            secret.ciphertext.length === 0 ||
            secret.keyId === undefined ||
            secret.keyId === null ||
            secret.keyId.length === 0
          ) {
            return "";
          }

          return yield* decrypt({
            ciphertext: secret.ciphertext,
            keyId: secret.keyId,
          });
        }
      );

      return {
        currentKeyId: keyId,
        decrypt,
        decryptOptional,
        encrypt,
      };
    }),
  }
) {
  static readonly Default = Layer.effect(this, this.make).pipe(
    Layer.provide(AppConfig.Default)
  );
}
