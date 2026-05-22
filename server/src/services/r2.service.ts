import crypto from "crypto";

type PresignInput = {
  method: "GET" | "PUT";
  objectKey: string;
  expiresSeconds?: number;
  responseFilename?: string;
};

const region = "auto";
const service = "s3";

const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    character =>
      `%${character
        .charCodeAt(0)
        .toString(16)
        .toUpperCase()}`
  );

const hashHex = (value: string) =>
  crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");

const hmac = (
  key: Buffer | string,
  value: string
) =>
  crypto
    .createHmac("sha256", key)
    .update(value)
    .digest();

const getSigningKey = (
  secretAccessKey: string,
  dateStamp: string
) => {
  const dateKey =
    hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey =
    hmac(dateKey, region);
  const serviceKey =
    hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
};

const formatAmzDate = (date: Date) =>
  date
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");

const getR2Config = () => {
  const accountId =
    process.env.CLOUDFLARE_R2_ACCOUNT_ID;
  const accessKeyId =
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const bucket =
    process.env.CLOUDFLARE_R2_BUCKET;

  if (
    !accountId ||
    !accessKeyId ||
    !secretAccessKey ||
    !bucket
  ) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint:
      process.env.CLOUDFLARE_R2_ENDPOINT ||
      `https://${accountId}.r2.cloudflarestorage.com`
  };
};

export const isR2Configured = () =>
  getR2Config() !== null;

export const createR2PresignedUrl = ({
  method,
  objectKey,
  expiresSeconds = 300,
  responseFilename
}: PresignInput) => {
  const config = getR2Config();

  if (!config) {
    throw new Error(
      "Cloudflare R2 is not configured"
    );
  }

  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope =
    `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = "host";
  const host =
    new URL(config.endpoint).host;
  const canonicalUri =
    `/${encodeRfc3986(config.bucket)}/${objectKey
      .split("/")
      .map(encodeRfc3986)
      .join("/")}`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential":
      `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders
  };

  if (responseFilename && method === "GET") {
    query["response-content-disposition"] =
      `attachment; filename="${responseFilename.replace(/"/g, "")}"`;
  }

  const canonicalQueryString =
    Object.keys(query)
      .sort()
      .map(
        key =>
          `${encodeRfc3986(key)}=${encodeRfc3986(query[key])}`
      )
      .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    `host:${host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD"
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest)
  ].join("\n");

  const signingKey =
    getSigningKey(
      config.secretAccessKey,
      dateStamp
    );

    console.log("R2 ENDPOINT:", config.endpoint);
    console.log("BUCKET:", config.bucket);
    console.log("OBJECT KEY:", objectKey);
    console.log("CANONICAL URI:", canonicalUri);

  const signature =
    crypto
      .createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");

  return (
    `${config.endpoint}${canonicalUri}` +
    `?${canonicalQueryString}` +
    `&X-Amz-Signature=${signature}`
  );
};
