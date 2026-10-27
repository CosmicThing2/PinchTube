/**
 * Shown under Settings → System. Release images get it from the release tag
 * (the publish workflow passes it in as PINCHTUBE_VERSION); a local build
 * from source reports "dev".
 */
export const APP_VERSION = process.env.PINCHTUBE_VERSION?.trim() || 'dev';
