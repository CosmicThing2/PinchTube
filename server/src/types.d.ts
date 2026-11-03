/*
 * types.d.ts — extra TypeScript types added onto the Fastify web framework.
 *
 * Fastify lets an app add its own fields to requests and route options.
 * This declares the ones PinchTube uses, so the compiler knows about them:
 *   - request.user: the signed-in user, filled in by the hook in index.ts
 *     using auth.ts, or null for a visitor who is not signed in.
 *   - route config `public` / `admin`: flags each route can set, checked by
 *     that same hook to decide who may call it.
 * There is no runtime code here; it only affects type checking.
 */

import 'fastify';
import type { User } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyContextConfig {
    /** Reachable without signing in. Everything under /api/ is private otherwise. */
    public?: boolean;
    /** Only administrators may call this route. */
    admin?: boolean;
  }
}
