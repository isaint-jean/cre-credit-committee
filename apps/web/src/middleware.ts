import { NextResponse, type NextRequest } from 'next/server';

/**
 * Private-first edge gate (deploy Step 2). When BASIC_AUTH_USER + BASIC_AUTH_PASS are
 * set (prod, via Fly secrets), the ENTIRE app — including the login page — sits behind
 * HTTP Basic Auth, so a `*.fly.dev` URL is not anonymously reachable. When they are
 * UNSET (local dev), this is a pass-through no-op — `npm run dev` is unaffected.
 *
 * Edge runtime: uses `atob` (no Node Buffer). This is a coarse shared-credential gate
 * for a private staging demo, NOT per-user auth — the app's own JWT login is the real
 * identity layer underneath.
 */
export function middleware(req: NextRequest): NextResponse {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return NextResponse.next(); // no gate configured → dev/no-op

  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const [u, p] = atob(header.slice(6)).split(':');
      if (u === user && p === pass) return NextResponse.next();
    } catch {
      /* malformed header → fall through to challenge */
    }
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="cre-private"' },
  });
}

// Gate everything except Next's static assets + favicon (so the challenge doesn't
// break asset loading once authenticated).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
