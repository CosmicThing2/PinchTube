/*
 * version.ts — the version number PinchTube reports about itself.
 *
 * A single constant read from the environment at startup. The Dockerfile
 * sets PINCHTUBE_VERSION from a build argument, which the release workflow
 * (.github/workflows/docker-publish.yml) fills in from the release tag.
 * routes/settings.ts sends it to the web app for the System section.
 */

/**
 * Shown under Settings → System. Release images get it from the release tag
 * (the publish workflow passes it in as PINCHTUBE_VERSION); a local build
 * from source reports "dev".
 */
export const APP_VERSION = process.env.PINCHTUBE_VERSION?.trim() || 'dev';
