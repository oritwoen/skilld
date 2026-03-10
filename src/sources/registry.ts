import type { Package } from 'regxa'
import type { ResolveAttempt, ResolveResult, ResolvedPackage } from './types.ts'
import { createFromPURL, fetchPackageFromPURL, fetchVersionsFromPURL, has, NotFoundError, resolveDocsUrl, selectVersion } from 'regxa'
import 'regxa/registries'
import { fetchLlmsUrl } from './llms.ts'
import { resolveGitHubRepo } from './github.ts'
import { isLikelyCodeHostUrl, isUselessDocsUrl, parseGitHubUrl } from './utils.ts'

/**
 * Ecosystem prefix aliases for CLI input.
 * Maps user-facing prefix → regxa ecosystem name.
 */
const ECOSYSTEM_ALIASES: Record<string, string> = {
  cargo: 'cargo',
  crate: 'cargo',
  pypi: 'pypi',
  gem: 'gem',
  composer: 'composer',
}

/** All supported ecosystem prefixes for CLI help text */
export const ECOSYSTEM_PREFIXES = Object.keys(ECOSYSTEM_ALIASES)

/** Check if a regxa ecosystem is registered */
export function isValidEcosystem(ecosystem: string): boolean {
  return has(ecosystem)
}

/** Parse "cargo:serde" or "pypi:flask" into ecosystem + name. Returns null ecosystem for npm packages. */
export function parseEcosystemSpec(spec: string): { ecosystem: string | null, name: string } {
  const colonIdx = spec.indexOf(':')
  if (colonIdx === -1)
    return { ecosystem: null, name: spec }

  const prefix = spec.slice(0, colonIdx).toLowerCase()
  const ecosystem = ECOSYSTEM_ALIASES[prefix]
  if (!ecosystem)
    return { ecosystem: null, name: spec }

  return { ecosystem, name: spec.slice(colonIdx + 1) }
}

/** Check if spec has an ecosystem prefix (e.g. "cargo:serde", "pypi:flask") */
export function isRegistrySpec(spec: string): boolean {
  const colonIdx = spec.indexOf(':')
  if (colonIdx === -1)
    return false
  return spec.slice(0, colonIdx).toLowerCase() in ECOSYSTEM_ALIASES
}

/** Storage key with ecosystem namespace: "serde" → "@skilld-cargo/serde" */
export function toStoragePackageName(packageName: string, ecosystem: string | null): string {
  return ecosystem ? `@skilld-${ecosystem}/${packageName}` : packageName
}

/** Identity key with ecosystem prefix: "serde" → "cargo:serde" */
export function toIdentityPackageName(packageName: string, ecosystem: string | null): string {
  return ecosystem ? `${ecosystem}:${packageName}` : packageName
}

/** Reverse: "cargo:serde" → "@skilld-cargo/serde", "vue" → "vue" */
export function storageNameFromIdentity(identityName: string): string {
  const { ecosystem, name } = parseEcosystemSpec(identityName)
  return toStoragePackageName(name, ecosystem)
}

/** Derive update spec from skill entry for `skilld update` */
export function toUpdatePackageSpec(skill: { packageName?: string, name: string, info?: { source?: string } | null }): string {
  const packageName = skill.packageName || skill.name

  // Already has ecosystem prefix → return as-is
  const { ecosystem } = parseEcosystemSpec(packageName)
  if (ecosystem)
    return packageName

  // Detect storage namespace pattern (@skilld-<ecosystem>/...)
  const match = packageName.match(/^@skilld-(\w+)\/(.+)$/)
  if (match)
    return `${match[1]}:${match[2]}`

  return packageName
}

/**
 * Resolve package metadata from any non-npm registry via regxa PURL.
 * Supports all regxa ecosystems: cargo, pypi, gem, composer, etc.
 */
export async function resolveRegistryDocsWithAttempts(
  ecosystem: string,
  packageName: string,
  options: { version?: string, onProgress?: (step: string) => void } = {},
): Promise<ResolveResult> {
  const attempts: ResolveAttempt[] = []
  const onProgress = options.onProgress
  const normalizedName = packageName.trim().toLowerCase()

  if (!normalizedName) {
    attempts.push({ source: 'registry', status: 'error', message: `Invalid package name: ${packageName}` })
    return { package: null, attempts }
  }

  const purl = `pkg:${ecosystem}/${encodeURIComponent(normalizedName)}`
  onProgress?.(`${ecosystem} registry`)

  let pkg: Package | undefined
  try {
    pkg = await fetchPackageFromPURL(purl)
  }
  catch (error) {
    const isNotFound = error instanceof NotFoundError
    attempts.push({
      source: 'registry',
      status: isNotFound ? 'not-found' : 'error',
      message: isNotFound ? `Package not found on ${ecosystem}` : `Failed to fetch ${ecosystem} metadata`,
    })
    return { package: null, attempts }
  }

  attempts.push({
    source: 'registry',
    status: 'success',
    message: `Found on ${ecosystem}: ${pkg.name || normalizedName}`,
  })

  // Version selection via regxa's built-in selectVersion
  let version = pkg.latestVersion
  let publishedAt: string | undefined

  if (options.version || !version) {
    const versions = await fetchVersionsFromPURL(purl).catch(() => [])
    const selected = selectVersion(versions, {
      requested: options.version,
      latest: pkg.latestVersion,
    })
    if (selected) {
      version = selected.number
      publishedAt = selected.publishedAt?.toISOString()
    }
  }

  if (!version) {
    attempts.push({ source: 'registry', status: 'error', message: 'No usable versions found' })
    return { package: null, attempts }
  }

  // Resolve docs URL using regxa's URL builder (handles docs.rs, rubydoc, pypi, etc.)
  const [registry] = createFromPURL(purl)
  const urls = registry.urls()
  const docsUrl = resolveDocsUrl(pkg, urls, version)

  const repoUrl = pkg.repository && isLikelyCodeHostUrl(pkg.repository) ? pkg.repository : undefined

  let resolved: ResolvedPackage = {
    name: normalizedName,
    version,
    releasedAt: publishedAt,
    description: pkg.description || undefined,
    docsUrl: docsUrl && !isUselessDocsUrl(docsUrl) ? docsUrl : urls.documentation(normalizedName, version),
    repoUrl,
  }

  // GitHub enrichment
  const gh = repoUrl ? parseGitHubUrl(repoUrl) : null
  if (gh) {
    onProgress?.('GitHub enrichment')
    const ghResolved = await resolveGitHubRepo(gh.owner, gh.repo)
    if (ghResolved) {
      attempts.push({ source: 'github-meta', url: repoUrl, status: 'success', message: 'Enriched via GitHub repo metadata' })
      resolved = {
        ...ghResolved,
        name: normalizedName,
        version,
        releasedAt: resolved.releasedAt || ghResolved.releasedAt,
        description: resolved.description || ghResolved.description,
        docsUrl: resolved.docsUrl || ghResolved.docsUrl,
        repoUrl,
        readmeUrl: ghResolved.readmeUrl || resolved.readmeUrl,
      }
    }
    else {
      attempts.push({ source: 'github-meta', url: repoUrl, status: 'not-found', message: `GitHub enrichment failed, using ${ecosystem} metadata` })
    }
  }

  // llms.txt discovery
  if (!resolved.llmsUrl && resolved.docsUrl) {
    onProgress?.('llms.txt discovery')
    resolved.llmsUrl = await fetchLlmsUrl(resolved.docsUrl).catch(() => null) ?? undefined
    if (resolved.llmsUrl)
      attempts.push({ source: 'llms.txt', url: resolved.llmsUrl, status: 'success' })
  }

  return { package: resolved, attempts }
}
