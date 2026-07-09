/**
 * lib/r2.js – Cloudflare R2 storage helper (S3-compatible).
 *
 * Reads credentials from environment variables (set on the Railway app service):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
 *
 * Only used for profile avatars at present. Uploads are small (a resized,
 * compressed 256x256 image), so this stays well within the Railway/R2 free
 * tier and does no background work.
 */

'use strict';

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const ACCOUNT_ID      = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID   = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY      = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET          = process.env.R2_BUCKET;
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');

// R2 is configured when all required vars are present. If not, the avatar
// feature is simply disabled (uploads return a clear error) rather than the
// whole app failing to boot.
const isConfigured = !!(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_KEY && BUCKET && PUBLIC_BASE_URL);

let _client = null;
function client() {
  if (!isConfigured) throw new Error('R2 storage is not configured on this server.');
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_KEY },
    });
  }
  return _client;
}

/**
 * putObject(key, body, contentType) → the public URL for the stored object.
 */
async function putObject(key, body, contentType) {
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=86400',
  }));
  return `${PUBLIC_BASE_URL}/${key}`;
}

/**
 * deleteObject(key) – remove an object. Given a full public URL or a bare key,
 * it strips the base URL to recover the key.
 */
async function deleteObject(keyOrUrl) {
  if (!keyOrUrl) return;
  let key = keyOrUrl;
  if (key.startsWith(PUBLIC_BASE_URL + '/')) key = key.slice(PUBLIC_BASE_URL.length + 1);
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { isConfigured, putObject, deleteObject, PUBLIC_BASE_URL };