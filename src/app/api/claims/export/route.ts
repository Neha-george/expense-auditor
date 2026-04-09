import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase-server'

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organisation_id')
      .eq('id', user.id)
      .single()

    // 🛡️ Security Check: Verify admin role on the server side
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'No organisation found' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format') // 'quickbooks', 'xero', 'bacs'
    const fromDate = searchParams.get('fromDate')
    const toDate = searchParams.get('toDate')

    if (!['quickbooks', 'xero', 'bacs'].includes(format || '')) {
       return NextResponse.json({ error: 'Invalid format requested' }, { status: 400 })
    }

    // Fetch ONLY approved claims
    let query = supabase
      .from('claims')
      .select('id, amount, currency, merchant, receipt_date, category, business_purpose, profiles!claims_employee_id_fkey(full_name, email)')
      .eq('organisation_id', orgId)
      .eq('status', 'approved')
      .order('receipt_date', { ascending: true })

    if (fromDate) query = query.gte('receipt_date', fromDate)
    if (toDate) query = query.lte('receipt_date', toDate)

    const [ { data: claims, error: claimsError }, { data: mappings, error: mappingError } ] = await Promise.all([
      query,
      supabase.from('gl_account_mappings').select('category, gl_code').eq('organisation_id', orgId)
    ])

    if (claimsError) throw claimsError
    if (mappingError) throw mappingError

    const glMap = new Map((mappings || []).map(m => [m.category, m.gl_code]))
    
    // Format helpers
    const escapeCsv = (str: any) => `"${String(str || '').replace(/"/g, '""')}"`

    if (format === 'quickbooks') {
      // Very strict IIF template format using tab characters.
      // TRNS represents the header/total for the transaction
      // SPL represents the split lines (the actual expense categorization)
      const lines = []
      lines.push('!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR')
      lines.push('!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR')
      lines.push('!ENDTRNS')
      
      for (const claim of claims || []) {
        const dateStr = new Date(claim.receipt_date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
        const employeeName = (claim.profiles as any)?.full_name || 'Employee'
        const glCode = glMap.get(claim.category) || 'UNCATEGORIZED'
        const amt = Number(claim.amount || 0).toFixed(2)
        const memo = (claim.business_purpose || '').replace(/\t|\n|\r/g, ' ').substring(0, 50)
        
        // Negative amount for AP (TRNS), positive for Expense (SPL)
        lines.push(`TRNS\t${claim.id}\tBILL\t${dateStr}\tAccounts Payable\t${employeeName}\t-${amt}\t${claim.id}\t${memo}\tN`)
        lines.push(`SPL\t${claim.id}\tBILL\t${dateStr}\t${glCode}\t${claim.merchant}\t${amt}\t\t${claim.category}\tN`)
        lines.push(`ENDTRNS`)
      }

      return new NextResponse(lines.join('\n'), {
        headers: {
          'Content-Type': 'application/qbooks',
          'Content-Disposition': `attachment; filename="claims_export_${Date.now()}.iif"`,
        },
      })
    }

    if (format === 'xero') {
      // Xero CSV Format
      // Using claim_id as Reference/InvoiceNumber to prevent duplicates
      const headers = ['*ContactName', 'EmailAddress', '*InvoiceNumber', '*InvoiceDate', '*DueDate', '*Description', '*Quantity', '*UnitAmount', '*AccountCode', '*TaxType', 'Reference', 'Currency']
      const rows = [headers.join(',')]
      
      for (const claim of claims || []) {
        const employeeName = (claim.profiles as any)?.full_name || 'Employee'
        const email = (claim.profiles as any)?.email || ''
        const dateStr = new Date(claim.receipt_date).toLocaleDateString('en-US')
        const glCode = glMap.get(claim.category) || ''
        const desc = `${claim.merchant}: ${claim.business_purpose}`.replace(/\t|\n|\r/g, ' ')
        const amt = Number(claim.amount || 0).toFixed(2)

        rows.push([
           escapeCsv(employeeName),
           escapeCsv(email),
           escapeCsv(claim.id), // InvoiceNumber (Unique Tx ID)
           escapeCsv(dateStr),
           escapeCsv(dateStr), // DueDate same as InvoiceDate for expenses
           escapeCsv(desc),
           '1', // Quantity
           escapeCsv(amt),
           escapeCsv(glCode),
           escapeCsv('Tax Exempt'), // Assuming tax exempt or handled by Xero defaults
           escapeCsv(`Claim ${claim.id.substring(0,8)}`), // Reference
           escapeCsv(claim.currency || 'USD')
        ].join(','))
      }

      return new NextResponse(rows.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="xero_export_${Date.now()}.csv"`,
        },
      })
    }

    if (format === 'bacs') {
      // Generic BACS payment file CSV (Simplified standard for standard corporate banks)
      const headers = ['BeneficiaryName', 'SortCode', 'AccountNumber', 'Amount', 'Currency', 'PaymentReference', 'InternalReference']
      const rows = [
        '# BACS Payment File Generated by PolicyLens',
        headers.join(',')
      ]

      for (const claim of claims || []) {
        const employeeName = (claim.profiles as any)?.full_name || 'Employee'
        const amt = Number(claim.amount || 0).toFixed(2)
        // SortCode/Account usually populated from an HR system. In this export we provide blanks for the finance team 
        // to merge with their employee banking details, but we provide the structured layout and unique refs.
        rows.push([
           escapeCsv(employeeName),
           '', // SortCode placeholder
           '', // AccountNumber placeholder
           escapeCsv(amt),
           escapeCsv(claim.currency || 'GBP'),
           escapeCsv(`EXP-${claim.id.substring(0, 8)}`), // PaymentReference to see on bank statement
           escapeCsv(claim.id) // Internal Reference (Unique Tx ID)
        ].join(','))
      }

      return new NextResponse(rows.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="bacs_export_${Date.now()}.csv"`,
        },
      })
    }

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
