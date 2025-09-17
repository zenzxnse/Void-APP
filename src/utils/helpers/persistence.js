// helpers/persistence.js
import { createHash } from 'node:crypto';

export function componentKey(parsed) {
  // versionedPrefix = `${namespace}:${action}:${version}`
  const { namespace, action, version, data } = parsed;
  const versionedPrefix = `${namespace}:${action}:${version}`;
  const custom = JSON.stringify(data.custom ?? {});
  const h = createHash('sha1').update(custom).digest('base64url').slice(0, 12);
  return `${versionedPrefix}:${h}`;
}
