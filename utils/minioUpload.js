import { DeleteObjectCommand, S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load backend/.env regardless of the process working directory.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const trimEnv = (name) => {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
};

const r2Config = {
  endpoint:
    trimEnv('CLOUDFLARE_R2_S3API') || trimEnv('CLOUDFLARE_R2_ENDPOINT'),
  region: trimEnv('CLOUDFLARE_R2_REGION') || 'auto',
  accessKeyId: trimEnv('CLOUDFLARE_R2_ACCESS_KEY'),
  secretAccessKey: trimEnv('CLOUDFLARE_R2_SECRET_KEY'),
  bucketName: trimEnv('CLOUDFLARE_R2_BUCKET_NAME'),
  publicUrl: trimEnv('CLOUDFLARE_R2_PUBLIC_URL'),
};

const normalizeEndpoint = (endpoint, bucketName) => {
  if (!endpoint) return endpoint;
  try {
    const parsed = new URL(endpoint);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
      const bucketFromPath = pathParts[0];
      if (!bucketName) {
        r2Config.bucketName = bucketFromPath;
      }
      parsed.pathname = '/';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return endpoint.replace(/\/+$/, '');
  }
};

r2Config.endpoint = normalizeEndpoint(r2Config.endpoint, r2Config.bucketName);

const missingConfig = Object.entries({
  CLOUDFLARE_R2_ENDPOINT: r2Config.endpoint,
  CLOUDFLARE_R2_ACCESS_KEY: r2Config.accessKeyId,
  CLOUDFLARE_R2_SECRET_KEY: r2Config.secretAccessKey,
  CLOUDFLARE_R2_BUCKET_NAME: r2Config.bucketName,
  CLOUDFLARE_R2_PUBLIC_URL: r2Config.publicUrl,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

const ensureR2Config = () => {
  if (missingConfig.length > 0) {
    const error = new Error(
      `Missing Cloudflare R2 configuration: ${missingConfig.join(', ')}`
    );
    error.code = 'R2_CONFIG_MISSING';
    throw error;
  }
};

const s3Client = new S3Client({
  endpoint: r2Config.endpoint,
  region: r2Config.region,
  credentials: {
    accessKeyId: r2Config.accessKeyId,
    secretAccessKey: r2Config.secretAccessKey,
  },
});

const BUCKET_NAME = r2Config.bucketName;

const sanitizeR2ConfigForLogs = () => ({
  endpoint: r2Config.endpoint,
  region: r2Config.region,
  bucketName: r2Config.bucketName,
  publicUrl: r2Config.publicUrl,
  accessKeyIdSuffix: r2Config.accessKeyId ? r2Config.accessKeyId.slice(-6) : null,
});

/**
 * Uploads a file buffer to Cloudflare R2 (S3 compatible)
 * @param {Buffer} buffer File buffer
 * @param {string} originalName Original file name
 * @param {string} mimeType File mime type
 * @param {string} folder Target folder path
 * @returns {Promise<Object>} Object containing secure_url and public_id
 */
export const uploadToMinio = async (buffer, originalName, mimeType, folder = 'uploads') => {
  try {
    ensureR2Config();

    const ext = path.extname(originalName) || '';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const fileName = `${folder}/${uniqueSuffix}${ext}`;

    console.log('[R2_UPLOAD] Starting upload', {
      originalName,
      mimeType,
      bytes: buffer?.length ?? 0,
      key: fileName,
      config: sanitizeR2ConfigForLogs(),
    });

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: mimeType,
    });

    await s3Client.send(command);

    // Generate the public URL (using Cloudflare R2 public bucket URL)
    const secureUrl = `${r2Config.publicUrl.replace(/\/+$/, '')}/${fileName}`;

    console.log('[R2_UPLOAD] Upload success', {
      key: fileName,
      secureUrl,
      format: ext.replace('.', ''),
    });

    return {
      secure_url: secureUrl,
      public_id: fileName,
      format: ext.replace('.', ''),
      duration: null // R2 doesn't parse audio duration automatically
    };
  } catch (error) {
    console.error('[R2_UPLOAD] Cloudflare R2 upload error', {
      message: error.message,
      code: error.Code || error.code || 'R2_UPLOAD_FAILED',
      metadata: error.$metadata,
      config: sanitizeR2ConfigForLogs(),
    });

    if (error.Code === 'Unauthorized' || error?.$metadata?.httpStatusCode === 401) {
      const authError = new Error(
        'Cloudflare R2 authentication failed. Check the R2 access key, secret key, bucket permissions, and endpoint.'
      );
      authError.code = 'R2_AUTH_FAILED';
      authError.statusCode = 502;
      throw authError;
    }

    throw error;
  }
};

const getObjectKeyFromPublicUrl = (fileUrl) => {
  if (!fileUrl || !r2Config.publicUrl) return null;
  const normalizedPublicUrl = r2Config.publicUrl.replace(/\/+$/, '');
  const normalizedFileUrl = String(fileUrl).trim();
  if (!normalizedFileUrl.startsWith(normalizedPublicUrl)) {
    return null;
  }

  const key = normalizedFileUrl
    .slice(normalizedPublicUrl.length)
    .replace(/^\/+/, '')
    .trim();

  return key || null;
};

export const deleteFromMinioByUrl = async (fileUrl) => {
  const objectKey = getObjectKeyFromPublicUrl(fileUrl);
  if (!objectKey) {
    return false;
  }

  ensureR2Config();

  await s3Client.send(new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: objectKey,
  }));

  console.log('[R2_DELETE] Deleted object', {
    key: objectKey,
    config: sanitizeR2ConfigForLogs(),
  });

  return true;
};

export default s3Client;
