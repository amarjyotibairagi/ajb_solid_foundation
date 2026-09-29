export interface GroundingContext {
  referenceMaterial: string
  creatorInstructions?: string
  previouslyApprovedContent?: string[]
  allowedAuthorities?: string[]
}

export interface UngroundedClaim {
  authority: string
  matchedText: string
  path: string
  reason: string
}

export class UngroundedCoverageClaimError extends Error {
  readonly code = 'UNGROUNDED_COVERAGE_CLAIM'
  readonly claims: UngroundedClaim[]

  constructor(claims: UngroundedClaim[]) {
    super('Generated content contains an unsupported regulatory or compliance claim.')
    this.name = 'UngroundedCoverageClaimError'
    this.claims = claims
  }
}

const MAX_DEPTH = 12
const MAX_NODES = 10_000
const MAX_INSPECTED_CHARACTERS = 200_000

// These markers are deliberately conservative. This check is a provenance
// gate, not a factuality oracle: unsupported hits are quarantined for review.
const AUTHORITY_PATTERNS: readonly RegExp[] = [
  /\b(?:ISO|OSHA|NFPA|ANSI|ASME)(?:[-\s]?\d{2,}(?:[-:]\d+)?)?\b/gi,
  /\b(?:section|sec\.|§)\s*\d+(?:\.\d+)*(?:\([a-z0-9]+\))?\b/gi,
  /\b(?:regulation|directive|standard)\s+[A-Z]{1,8}[-:]?\d{1,8}(?:[-:]\d{1,8})?\b/gi,
]

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
}

function collectContext(context: GroundingContext): string {
  return normalize([
    context.referenceMaterial,
    context.creatorInstructions || '',
    ...(context.previouslyApprovedContent || []),
  ].join('\n'))
}

function authorityFor(match: string): string {
  const normalized = match.trim().toUpperCase()
  const authority = normalized.match(/^(ISO|OSHA|NFPA|ANSI|ASME|SECTION|SEC\.|§|REGULATION|DIRECTIVE|STANDARD)/i)
  return authority?.[1] || 'COMPLIANCE_MARKER'
}

function walkStrings(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number; characters: number; values: Array<{ value: string; path: string }> },
): void {
  if (state.nodes >= MAX_NODES || state.characters >= MAX_INSPECTED_CHARACTERS || depth > MAX_DEPTH) return
  state.nodes += 1
  if (typeof value === 'string') {
    const remaining = MAX_INSPECTED_CHARACTERS - state.characters
    const bounded = value.slice(0, Math.max(0, remaining))
    state.characters += bounded.length
    if (bounded) state.values.push({ value: bounded, path })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, depth + 1, state))
    return
  }
  if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
      const safeKey = key.replace(/[^a-zA-Z0-9_$.-]/g, '_').slice(0, 80)
      walkStrings(child, `${path}.${safeKey}`, depth + 1, state)
    })
  }
}

export function findUngroundedCoverageClaims(
  generatedValue: unknown,
  context: GroundingContext,
): UngroundedClaim[] {
  const groundingText = collectContext(context)
  const allowedAuthorities = new Set((context.allowedAuthorities || []).map(normalize))
  const state = { nodes: 0, characters: 0, values: [] as Array<{ value: string; path: string }> }
  walkStrings(generatedValue, '$', 0, state)

  const claims: UngroundedClaim[] = []
  const seen = new Set<string>()
  for (const item of state.values) {
    for (const pattern of AUTHORITY_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of item.value.matchAll(pattern)) {
        const matchedText = match[0].trim()
        const normalizedMatch = normalize(matchedText)
        const authority = authorityFor(matchedText)
        const grounded = groundingText.includes(normalizedMatch) || allowedAuthorities.has(normalize(authority))
        if (grounded) continue
        const key = `${item.path}|${normalizedMatch}`
        if (seen.has(key)) continue
        seen.add(key)
        claims.push({
          authority,
          matchedText: matchedText.slice(0, 160),
          path: item.path,
          reason: 'The generated claim is not present in the supplied grounding context or server allow-list.',
        })
      }
    }
  }
  return claims
}

export function assertGroundedGeneratedContent(
  generatedValue: unknown,
  context: GroundingContext,
): void {
  const claims = findUngroundedCoverageClaims(generatedValue, context)
  if (claims.length > 0) throw new UngroundedCoverageClaimError(claims)
}
