import { NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { email, password, fullName, department, location, seniority } = body

    if (!email || !password || !fullName) {
      return NextResponse.json(
        { error: 'Email, password, and full name are required' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    // Use the admin (service-role) client to create the user.
    // This bypasses any "email signups are disabled" restriction
    // in the Supabase dashboard.
    const adminSupabase = createAdminSupabase()

    const { data: authData, error: authError } =
      await adminSupabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // Auto-confirm the email
        user_metadata: { full_name: fullName },
      })

    if (authError) {
      console.error('Admin createUser error:', authError)
      return NextResponse.json(
        { error: authError.message },
        { status: 400 }
      )
    }

    if (!authData.user) {
      return NextResponse.json(
        { error: 'User creation failed' },
        { status: 500 }
      )
    }

    // Update the profile row (created by the DB trigger) with extra fields
    if (department || location || seniority) {
      const { error: profileError } = await adminSupabase
        .from('profiles')
        .update({
          ...(department && { department }),
          ...(location && { location }),
          ...(seniority && { seniority }),
        })
        .eq('id', authData.user.id)

      if (profileError) {
        console.error('Profile update error:', profileError)
      }
    }

    // Sign the user in so the session cookie is set
    const serverSupabase = await createServerSupabase()
    const { error: signInError } = await serverSupabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      console.error('Auto sign-in error:', signInError)
      // User was created but auto-login failed — they can still sign in manually
      return NextResponse.json({
        success: true,
        userId: authData.user.id,
        autoSignIn: false,
        message: 'Account created. Please sign in manually.',
      })
    }

    return NextResponse.json({
      success: true,
      userId: authData.user.id,
      autoSignIn: true,
    })
  } catch (err) {
    console.error('Registration API error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
