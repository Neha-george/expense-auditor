import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' })

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

Based on the policy clauses above and the employee's profile, determine if this expense is compliant.

Return ONLY a valid JSON object:
{
  "verdict": "approved", "flagged", or "rejected",
  "reason": "one clear sentence explaining the decision",
  "policy_reference": "exact quote or reference from the policy clause used, or null if no relevant clause found"
}

Rules:
- "approved" = clearly within policy limits for this employee's location and seniority
- "flagged" = ambiguous, needs human review, or partially exceeds limits
- "rejected" = clearly violates policy
- If no relevant policy clause exists, verdict must be "flagged"
Return ONLY the JSON. No markdown, no explanation.`

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
