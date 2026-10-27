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
