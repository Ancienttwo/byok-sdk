/**
 * The route inventory (sprint I1).
 *
 * Isolation review starts by asking "what routes exist, and what does each one
 * require?" — a question that is only answerable if the answer cannot drift
 * from what is actually mounted. So mounting goes through {@link
 * CloudRouteRegistry.register} and nowhere else: the registry owns the Hono
 * app, hands out no reference to it that could be mounted on directly, and
 * records a class for every route as it goes.
 *
 * `src/__tests__/route-inventory.test.ts` closes that loop in BOTH directions
 * against Hono's own `app.routes` table: a mounted route missing from the
 * inventory fails the suite, and an inventoried route that never reached the
 * router fails it too. A route whose class is not one of {@link ROUTE_CLASSES}
 * cannot be registered at all.
 */
import { Hono, type Context } from 'hono';

/**
 * What a route requires of its caller. Not a description of the handler's
 * work — a description of the credential it is authenticated by, which is the
 * thing an isolation review has to enumerate:
 *
 * - `device` — a bearer access token; resolves to a `DevicePrincipal` and a
 *   tenant-closed facade.
 * - `presigned` — no principal at all; an HMAC signature over the resource id
 *   plus an expiry IS the credential (§7's two `/content` routes).
 * - `public` — deliberately unauthenticated; must expose nothing tenant-scoped.
 */
export const ROUTE_CLASSES = ['device', 'presigned', 'public'] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

export const ROUTE_METHODS = ['GET', 'POST', 'PUT'] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

export interface RouteDescriptor {
  readonly method: RouteMethod;
  readonly path: string;
  readonly class: RouteClass;
}

export type CloudRouteHandler = (c: Context) => Response | Promise<Response>;

export function routeKey(route: { readonly method: string; readonly path: string }): string {
  return `${route.method} ${route.path}`;
}

export class CloudRouteRegistry {
  readonly #app = new Hono();
  readonly #routes: RouteDescriptor[] = [];

  register(descriptor: RouteDescriptor, handler: CloudRouteHandler): void {
    if (!(ROUTE_CLASSES as readonly string[]).includes(descriptor.class)) {
      throw new Error(`Route ${routeKey(descriptor)} has no valid isolation class`);
    }
    if (!(ROUTE_METHODS as readonly string[]).includes(descriptor.method)) {
      throw new Error(`Route ${routeKey(descriptor)} uses an unsupported method`);
    }
    if (this.#routes.some((existing) => routeKey(existing) === routeKey(descriptor))) {
      throw new Error(`Route ${routeKey(descriptor)} is already registered`);
    }
    this.#routes.push(descriptor);
    this.#app.on(descriptor.method, descriptor.path, handler);
  }

  /** The inventory, in registration order. */
  get routes(): readonly RouteDescriptor[] {
    return this.#routes;
  }

  /** What the router actually mounted, read back off Hono itself — the other half of the I1 comparison. */
  get mounted(): readonly { readonly method: string; readonly path: string }[] {
    return this.#app.routes.map((route) => ({ method: route.method, path: route.path }));
  }

  get fetch(): (request: Request, ...rest: unknown[]) => Response | Promise<Response> {
    return this.#app.fetch as (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
  }
}
