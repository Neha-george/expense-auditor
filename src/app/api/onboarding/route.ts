import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { action, inviteCode, orgName } = body

    if (action === 'join') {
      if (!inviteCode) {
        return NextResponse.json({ error: 'Invite code is required' }, { status: 400 })
      }

      // Find organization by invite code using service role (bypass RLS)
      const { data: org, error: orgError } = await admin
        .from('organisations')
        .select('id, name')
        .eq('invite_code', inviteCode.trim())
        .single()

      if (orgError || !org) {
        return NextResponse.json({ error: 'Invalid or expired invite code' }, { status: 404 })
      }

      // Update user profile to link to the org, using service role to bypass policies restrictions if needed, 
      // though typically a user CAN update their own profile, we'll use admin to be absolutely certain it applies smoothly during onboarding.
      const { error: updateError } = await admin
        .from('profiles')
        .update({
          organisation_id: org.id,
          onboarding_complete: true, // Employee is instantly onboarded
        })
        .eq('id', user.id)

      if (updateError) {
        return NextResponse.json({ error: 'Failed to join organisation' }, { status: 500 })
      }

      return NextResponse.json({ success: true, organisation: org })
    }

    if (action === 'create') {
      if (!orgName) {
        return NextResponse.json({ error: 'Organisation name is required' }, { status: 400 })
      }

      // Generate random unique slug
      const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).substring(2, 6)

      const { data: org, error: orgError } = await admin
        .from('organisations')
        .insert({ name: orgName, slug })
        .select('id')
        .single()

      if (orgError) {
        return NextResponse.json({ error: 'Failed to create organisation' }, { status: 500 })
      }

      // Note: Admin creator doesn't instantly finish onboarding, they must upload a policy file first.
      const { error: updateError } = await admin
        .from('profiles')
        .update({
          organisation_id: org.id,
          role: 'admin',
          onboarding_complete: false, // Must upload rules first
        })
        .eq('id', user.id)

      if (updateError) {
        return NextResponse.json({ error: 'Failed to link profile to new organisation' }, { status: 500 })
      }

      return NextResponse.json({ success: true, organisation: org })
    }

    if (action === 'complete_admin_onboarding') {
      // Mark the admin user's onboarding as complete. Called after uploading first policy.
      const { error: updateError } = await admin
        .from('profiles')
        .update({ onboarding_complete: true })
        .eq('id', user.id)

      if (updateError) {
        return NextResponse.json({ error: 'Failed to complete onboarding' }, { status: 500 })
      }

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
