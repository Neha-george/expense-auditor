import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
            supabaseResponse.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  const path = request.nextUrl.pathname

  console.log(`[Middleware] -> Path: ${path} | User ID: ${user?.id} | Auth Error: ${authError?.message}`)

  // ── Public / static paths — always allow ──────────────────
  const publicPaths = ['/auth/login', '/auth/register', '/onboarding/request-access']
  const isPublic = publicPaths.some(p => path.startsWith(p))
  if (isPublic) return supabaseResponse

  // ── RULE 1: Must be authenticated ─────────────────────────
  if (!user) {
    console.log(`[Middleware] -> Redirecting to /auth/login because no user`)
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  // Fetch profile once — all subsequent guards need it
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, organisation_id, onboarding_complete')
    .eq('id', user.id)
    .single()

  console.log(`[Middleware] -> Profile for ${user.id}:`, profile, '| Error:', profileError?.message)

  // ── RULE 2: Must belong to an organisation ─────────────────
  // Exception: /onboarding itself is allowed so the user can create/join an org
  if (!profile?.organisation_id && !path.startsWith('/onboarding')) {
    console.log(`[Middleware] -> Redirecting to /onboarding because no org_id`)
    return NextResponse.redirect(new URL('/onboarding', request.url))
  }

  // ── RULE 3: Admin must complete onboarding ─────────────────
  if (
    profile?.organisation_id &&
    !profile?.onboarding_complete &&
    profile?.role === 'admin' &&
    !path.startsWith('/onboarding')
  ) {
    console.log(`[Middleware] -> Redirecting to /onboarding because admin not complete`)
    return NextResponse.redirect(new URL('/onboarding', request.url))
  }

  // ── Already in onboarding but fully set up → exit ──────────
  if (path.startsWith('/onboarding') && profile?.organisation_id && profile?.onboarding_complete) {
    const dest = profile.role === 'admin' ? '/admin/dashboard' : '/employee/submit'
    console.log(`[Middleware] -> Redirecting to ${dest} because already onboarded`)
    return NextResponse.redirect(new URL(dest, request.url))
  }

  // ── RULE 4: Guard Admin routes ────────────────────────────
  if (path.startsWith('/admin') && profile?.role !== 'admin') {
    console.log(`[Middleware] -> Blocking non-admin from /admin route`)
    return NextResponse.redirect(new URL('/employee/submit', request.url))
  }

  // ── RULE 5: Guard Employee routes — admins go to admin dashboard ───
  if (path.startsWith('/employee') && profile?.role === 'admin') {
    console.log(`[Middleware] -> Redirecting admin away from employee route to /admin/dashboard`)
    return NextResponse.redirect(new URL('/admin/dashboard', request.url))
  }

  // ── RULE 6: Redirect root to appropriate dashboard ────────
  if (path === '/') {
    const dest = profile?.role === 'admin' ? '/admin/dashboard' : '/employee/submit'
    return NextResponse.redirect(new URL(dest, request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
