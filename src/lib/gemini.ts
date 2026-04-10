import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' })

// OCR: extract structured data from a receipt image
export async function extractReceiptData(imageBase64: string, mimeType: string) {
  const prompt = `You are an expense receipt OCR system. Analyze this receipt image.
Return ONLY a valid JSON object with exactly these fields:
{
  "is_readable": true or false,
  "merchant": "merchant name or null",
  "amount": number or null,
  "currency": "3-letter currency code or USD",
  "date": "YYYY-MM-DD or null",
  "category": one of: "meals","travel","accommodation","transport","office","entertainment","other",
  "confidence": "high", "medium", or "low"
}
If the image is blurry, too dark, or unreadable, set is_readable to false and all other fields to null.
Return ONLY the JSON. No explanation, no markdown, no code blocks.`

  const result = await visionModel.generateContent([
    { inlineData: { data: imageBase64, mimeType } },
    prompt,
  ])

  const text = result.response.text().trim()
    .replace(/^```json\n?/, '').replace(/\n?```$/, '')

  return JSON.parse(text)
}

// Verdict: given receipt data + policy context + employee profile → return verdict
export async function generateVerdict(params: {
  merchant: string
  amount: number
  currency: string
  date: string
  category: string
  businessPurpose: string
  employeeLocation: string
  employeeSeniority: string
  policyChunks: string[]
  structuredLimit?: { limit: number; currency: string; currentSpend: number } | null
  previousRejectionContext?: string | null
  overrideFeedback?: Array<{ category: string, amount_range: string, original_ai_verdict: string, admin_verdict: string, admin_reason: string }> | null
  statisticalBaseline?: {
    department?: string | null
    locationCity?: string | null
    locationCountry?: string | null
    median: number
    stddev: number
    zScore: number
    sampleSize: number
  } | null
}) {
  const policyContext = params.policyChunks
    .map((chunk, i) => `[Policy clause ${i + 1}]: ${chunk}`)
    .join('\n\n')

  const prompt = `You are a corporate expense policy compliance engine.

EMPLOYEE PROFILE:
- Location: ${params.employeeLocation}
- Seniority: ${params.employeeSeniority}

RECEIPT DATA:
- Merchant: ${params.merchant}
- Amount: ${params.amount} ${params.currency}
- Date: ${params.date}
- Category: ${params.category}
- Business purpose: ${params.businessPurpose}

RELEVANT POLICY CLAUSES:
${policyContext}

${params.overrideFeedback && params.overrideFeedback.length > 0 ? `
ORGANISATION-SPECIFIC OVERRIDE HISTORY:
For context, your admin previously made the following manual overrides on your decisions for the same category:
${params.overrideFeedback.map((fb, idx) => `- ${idx+1}: You returned "${fb.original_ai_verdict}" for an amount in range ${fb.amount_range}, but admin OVERRODE to "${fb.admin_verdict}". Reason: "${fb.admin_reason}"`).join('\n')}

Use these examples to calibrate your verdict to match this organisation's interpretation.
` : ''}

${params.statisticalBaseline ? `
STATISTICAL RISK CONTEXT:
- Department: ${params.statisticalBaseline.department || 'Unknown'}
- Location city: ${params.statisticalBaseline.locationCity || 'Unknown'}
- Location country: ${params.statisticalBaseline.locationCountry || 'Unknown'}
- Baseline sample size: ${params.statisticalBaseline.sampleSize}
- Median claim amount: ${params.statisticalBaseline.median.toFixed(2)} ${params.currency}
- Standard deviation: ${params.statisticalBaseline.stddev.toFixed(2)} ${params.currency}
- This claim's Z-score: ${params.statisticalBaseline.zScore.toFixed(2)}σ

Context: This claim is ${params.statisticalBaseline.zScore.toFixed(1)}σ (Standard Deviations) away from the median for this specific role in this city. A deviation > 3σ usually indicates high risk.

Use this as a mathematical anchor:
- |Z| <= 2: typically normal behavior
- 2 < |Z| <= 3: unusual, may need caution
- |Z| > 3: strong anomaly signal, usually requires flagging or rejection unless policy text explicitly allows it
` : ''}

${params.structuredLimit ? `
HARD SPEND LIMIT CONSTRAINT:
This employee has a strict monthly limit of ${params.structuredLimit.limit} ${params.structuredLimit.currency} for the category "${params.category}".
Their current approved and pending spend this month is ${params.structuredLimit.currentSpend} ${params.structuredLimit.currency}.
Available budget remaining: ${params.structuredLimit.limit - params.structuredLimit.currentSpend} ${params.structuredLimit.currency}.

If the receipt currency (${params.currency}) is different from the limit currency (${params.structuredLimit.currency}), you MUST approximate the conversion to ${params.structuredLimit.currency} using current market rates.
If the expense amount (after any required currency conversion) exceeds the available budget remaining, the verdict MUST be "flagged" regardless of the policy clauses.
` : ''}

${params.previousRejectionContext ? `
RESUBMISSION CONTEXT:
This is a resubmission! The previous attempt was flagged or rejected because: "${params.previousRejectionContext}".
Verify STRICTLY if the user has corrected this specific issue based on the newly uploaded receipt or the provided override fields. If the issue persists, reject it again.
` : ''}

Based on the policy clauses, the optional hard spend limits above, and the employee's profile, determine if this expense is compliant.

Return ONLY a valid JSON object:
{
  "verdict": "approved", "flagged", or "rejected",
  "reason": "one clear sentence explaining the decision",
  "policy_reference": "exact quote or reference from the policy clause used, or null if no relevant clause found",
  "confidence": a number between 0.0 and 1.0 representing how certain you are about this verdict
}

Rules:
- "approved" = clearly within policy limits for this employee's location and seniority
- "flagged" = ambiguous, needs human review, or partially exceeds limits
- "rejected" = clearly violates policy
- If no relevant policy clause exists, verdict must be "flagged"
- confidence > 0.9: you are highly certain (clear approval or clear rejection)
- confidence 0.7–0.9: moderate certainty, some ambiguity exists
- confidence < 0.7: low certainty, mandatory human review required
Return ONLY the JSON. No markdown, no explanation.`

  const result = await visionModel.generateContent(prompt)
  const text = result.response.text().trim()
    .replace(/^```json\n?/, '').replace(/\n?```$/, '')

  return JSON.parse(text)
}

export async function generatePolicyHealthReport(policyText: string) {
  const prompt = `You are an enterprise expense-policy quality auditor.
Analyze the policy text and produce a health report.

Return ONLY valid JSON with this exact shape:
{
  "status": "healthy" | "risky" | "critical",
  "score": number,
  "summary": string,
  "recommended_additions": [
    {
      "title": string,
      "why": string,
      "priority": "high" | "medium" | "low"
    }
  ]
}

Scoring guidance:
- 80 to 100 => healthy
- 50 to 79 => risky
- 0 to 49 => critical

Focus on practical enforceability and ambiguity reduction for receipts, duplicate claims, per-category limits, location-aware rules, approvals, and auditability.
Cap recommendations to max 8 items.

POLICY TEXT:
${policyText.slice(0, 25000)}
`

  const result = await visionModel.generateContent(prompt)
  const text = result.response.text().trim()
    .replace(/^```json\n?/, '').replace(/\n?```$/, '')

  return JSON.parse(text)
}

export async function generatePolicyClause(params: {
  recommendationTitle: string
  recommendationWhy: string
  organisationName?: string | null
  tone?: 'strict' | 'balanced' | 'lenient'
}) {
  const prompt = `You are a senior policy writer for corporate expense policy documents.
Draft ONE production-ready policy clause.

Inputs:
- Recommendation title: ${params.recommendationTitle}
- Reason: ${params.recommendationWhy}
- Organization: ${params.organisationName || 'This organisation'}
- Tone: ${params.tone || 'balanced'}

Return ONLY valid JSON with this exact shape:
{
  "title": string,
  "clause_text": string,
  "rationale": string
}

Rules:
- The clause_text should be specific, enforceable, and testable.
- Avoid vague words like "reasonable" unless paired with measurable limits.
- Keep clause_text under 120 words.
`

  const result = await visionModel.generateContent(prompt)
  const text = result.response.text().trim()
    .replace(/^```json\n?/, '').replace(/\n?```$/, '')

  return JSON.parse(text)
}

// Embed a text string → 768-dimension vector
export async function embedText(text: string): Promise<number[]> {
  const result = await embeddingModel.embedContent(text)
  return result.embedding.values
}

// Embed multiple texts in batches of 20
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = []
  for (let i = 0; i < texts.length; i += 20) {
    const batch = texts.slice(i, i + 20)
    const embeddings = await Promise.all(batch.map(embedText))
    results.push(...embeddings)
  }
  return results
}
