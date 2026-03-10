import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetchPackage = vi.fn()
const mockFetchVersions = vi.fn()
const mockSelectVersion = vi.fn()
const mockResolveDocsUrl = vi.fn()
const mockCreateFromPURL = vi.fn()
const mockHas = vi.fn((_ecosystem: string) => true)

vi.mock('regxa', () => ({
  fetchPackageFromPURL: (purl: string) => mockFetchPackage(purl),
  fetchVersionsFromPURL: (purl: string) => mockFetchVersions(purl),
  selectVersion: (versions: unknown[], opts: unknown) => mockSelectVersion(versions, opts),
  resolveDocsUrl: (pkg: unknown, urls: unknown, version: string) => mockResolveDocsUrl(pkg, urls, version),
  createFromPURL: (purl: string) => mockCreateFromPURL(purl),
  has: (ecosystem: string) => mockHas(ecosystem),
  NotFoundError: class NotFoundError extends Error {
    ecosystem: string
    packageName: string
    constructor(ecosystem: string, packageName: string) {
      super(`Not found: ${ecosystem}/${packageName}`)
      this.ecosystem = ecosystem
      this.packageName = packageName
    }
  },
}))

vi.mock('regxa/registries', () => ({}))

vi.mock('../../src/sources/github', () => ({
  resolveGitHubRepo: vi.fn(),
}))

vi.mock('../../src/sources/llms', () => ({
  fetchLlmsUrl: vi.fn(),
}))

const { resolveRegistryDocsWithAttempts, parseEcosystemSpec, isRegistrySpec, toStoragePackageName, toIdentityPackageName, storageNameFromIdentity, toUpdatePackageSpec } = await import('../../src/sources/registry')

describe('sources/registry', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockHas.mockReturnValue(true)
  })

  describe('parseEcosystemSpec', () => {
    it('parses cargo prefix', () => {
      expect(parseEcosystemSpec('cargo:serde')).toEqual({ ecosystem: 'cargo', name: 'serde' })
    })

    it('maps crate alias to cargo', () => {
      expect(parseEcosystemSpec('crate:serde')).toEqual({ ecosystem: 'cargo', name: 'serde' })
    })

    it('parses pypi prefix', () => {
      expect(parseEcosystemSpec('pypi:flask')).toEqual({ ecosystem: 'pypi', name: 'flask' })
    })

    it('parses gem prefix', () => {
      expect(parseEcosystemSpec('gem:rails')).toEqual({ ecosystem: 'gem', name: 'rails' })
    })

    it('parses composer prefix', () => {
      expect(parseEcosystemSpec('composer:laravel/framework')).toEqual({ ecosystem: 'composer', name: 'laravel/framework' })
    })

    it('returns null ecosystem for npm packages', () => {
      expect(parseEcosystemSpec('vue')).toEqual({ ecosystem: null, name: 'vue' })
    })

    it('returns null ecosystem for unknown prefix', () => {
      expect(parseEcosystemSpec('unknown:pkg')).toEqual({ ecosystem: null, name: 'unknown:pkg' })
    })
  })

  describe('isRegistrySpec', () => {
    it('detects known ecosystem prefixes', () => {
      expect(isRegistrySpec('cargo:serde')).toBe(true)
      expect(isRegistrySpec('crate:serde')).toBe(true)
      expect(isRegistrySpec('pypi:flask')).toBe(true)
      expect(isRegistrySpec('gem:rails')).toBe(true)
      expect(isRegistrySpec('composer:laravel/framework')).toBe(true)
    })

    it('rejects non-registry specs', () => {
      expect(isRegistrySpec('vue')).toBe(false)
      expect(isRegistrySpec('unknown:pkg')).toBe(false)
    })
  })

  describe('toStoragePackageName', () => {
    it('namespaces with ecosystem', () => {
      expect(toStoragePackageName('serde', 'cargo')).toBe('@skilld-cargo/serde')
      expect(toStoragePackageName('flask', 'pypi')).toBe('@skilld-pypi/flask')
      expect(toStoragePackageName('laravel/framework', 'composer')).toBe('@skilld-composer/laravel/framework')
    })

    it('returns as-is for npm', () => {
      expect(toStoragePackageName('vue', null)).toBe('vue')
    })
  })

  describe('toIdentityPackageName', () => {
    it('prefixes with ecosystem', () => {
      expect(toIdentityPackageName('serde', 'cargo')).toBe('cargo:serde')
      expect(toIdentityPackageName('flask', 'pypi')).toBe('pypi:flask')
    })

    it('returns as-is for npm', () => {
      expect(toIdentityPackageName('vue', null)).toBe('vue')
    })
  })

  describe('storageNameFromIdentity', () => {
    it('converts ecosystem identity to storage name', () => {
      expect(storageNameFromIdentity('cargo:serde')).toBe('@skilld-cargo/serde')
      expect(storageNameFromIdentity('crate:serde')).toBe('@skilld-cargo/serde')
      expect(storageNameFromIdentity('pypi:flask')).toBe('@skilld-pypi/flask')
      expect(storageNameFromIdentity('composer:laravel/framework')).toBe('@skilld-composer/laravel/framework')
    })

    it('passes through npm names', () => {
      expect(storageNameFromIdentity('vue')).toBe('vue')
    })
  })

  describe('toUpdatePackageSpec', () => {
    it('returns ecosystem-prefixed names as-is', () => {
      expect(toUpdatePackageSpec({ name: 'test', packageName: 'cargo:serde' })).toBe('cargo:serde')
    })

    it('detects storage namespace pattern', () => {
      expect(toUpdatePackageSpec({ name: '@skilld-cargo/serde', packageName: undefined })).toBe('cargo:serde')
      expect(toUpdatePackageSpec({ name: '@skilld-composer/laravel/framework', packageName: undefined })).toBe('composer:laravel/framework')
    })

    it('returns npm names as-is', () => {
      expect(toUpdatePackageSpec({ name: 'vue', packageName: 'vue' })).toBe('vue')
    })
  })

  describe('resolveRegistryDocsWithAttempts', () => {
    it('returns error for empty name', async () => {
      const result = await resolveRegistryDocsWithAttempts('cargo', '')
      expect(result.package).toBeNull()
      expect(result.attempts[0]).toMatchObject({ source: 'registry', status: 'error' })
    })

    it('returns not-found when regxa throws NotFoundError', async () => {
      const { NotFoundError } = await import('regxa')
      mockFetchPackage.mockRejectedValue(new NotFoundError('cargo', 'nonexistent'))

      const result = await resolveRegistryDocsWithAttempts('cargo', 'nonexistent')
      expect(result.package).toBeNull()
      expect(result.attempts).toContainEqual(expect.objectContaining({
        source: 'registry',
        status: 'not-found',
      }))
    })

    it('resolves package with latest version from regxa', async () => {
      const { fetchLlmsUrl } = await import('../../src/sources/llms')
      const { resolveGitHubRepo } = await import('../../src/sources/github')

      mockFetchPackage.mockResolvedValue({
        name: 'serde',
        description: 'Serialization framework',
        homepage: '',
        documentation: '',
        repository: 'https://github.com/serde-rs/serde',
        licenses: 'MIT',
        keywords: [],
        namespace: '',
        latestVersion: '1.0.220',
        metadata: {},
      })

      const mockUrls = {
        documentation: vi.fn(() => 'https://docs.rs/serde/1.0.220'),
        registry: vi.fn(),
        download: vi.fn(),
        readme: vi.fn(),
        purl: vi.fn(),
      }
      const mockRegistry = { urls: () => mockUrls, ecosystem: () => 'cargo' }
      mockCreateFromPURL.mockReturnValue([mockRegistry, 'serde', ''])
      mockResolveDocsUrl.mockReturnValue('https://docs.rs/serde/1.0.220')
      vi.mocked(resolveGitHubRepo).mockResolvedValue(null)
      vi.mocked(fetchLlmsUrl).mockResolvedValue(null)

      const progress: string[] = []
      const result = await resolveRegistryDocsWithAttempts('cargo', 'serde', {
        onProgress: step => progress.push(step),
      })

      expect(result.package).toMatchObject({
        name: 'serde',
        version: '1.0.220',
        description: 'Serialization framework',
        repoUrl: 'https://github.com/serde-rs/serde',
      })
      expect(progress).toContain('cargo registry')
    })

    it('selects requested version via selectVersion', async () => {
      const { fetchLlmsUrl } = await import('../../src/sources/llms')

      mockFetchPackage.mockResolvedValue({
        name: 'serde',
        description: '',
        homepage: '',
        documentation: '',
        repository: '',
        licenses: 'MIT',
        keywords: [],
        namespace: '',
        latestVersion: '',
        metadata: {},
      })

      mockFetchVersions.mockResolvedValue([
        { number: '1.0.220', publishedAt: new Date('2025-01-10'), status: '' },
        { number: '1.0.0', publishedAt: new Date('2020-01-01'), status: '' },
      ])

      mockSelectVersion.mockReturnValue({
        number: '1.0.0',
        publishedAt: new Date('2020-01-01'),
        status: '',
      })

      const mockUrls = {
        documentation: vi.fn(() => 'https://docs.rs/serde/1.0.0'),
        registry: vi.fn(),
        download: vi.fn(),
        readme: vi.fn(),
        purl: vi.fn(),
      }
      mockCreateFromPURL.mockReturnValue([{ urls: () => mockUrls, ecosystem: () => 'cargo' }, 'serde', ''])
      mockResolveDocsUrl.mockReturnValue('https://docs.rs/serde/1.0.0')
      vi.mocked(fetchLlmsUrl).mockResolvedValue(null)

      const result = await resolveRegistryDocsWithAttempts('cargo', 'serde', { version: '1.0.0' })

      expect(result.package?.version).toBe('1.0.0')
      expect(mockSelectVersion).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ requested: '1.0.0' }),
      )
    })

    it('returns error when no usable versions exist', async () => {
      mockFetchPackage.mockResolvedValue({
        name: 'serde',
        description: '',
        homepage: '',
        documentation: '',
        repository: '',
        licenses: '',
        keywords: [],
        namespace: '',
        latestVersion: '',
        metadata: {},
      })

      mockFetchVersions.mockResolvedValue([])
      mockSelectVersion.mockReturnValue(null)

      const result = await resolveRegistryDocsWithAttempts('cargo', 'serde', { version: '1.0.0' })
      expect(result.package).toBeNull()
      expect(result.attempts).toContainEqual(expect.objectContaining({
        source: 'registry',
        status: 'error',
        message: 'No usable versions found',
      }))
    })

    it('enriches via GitHub when repository points to GitHub', async () => {
      const { resolveGitHubRepo } = await import('../../src/sources/github')
      const { fetchLlmsUrl } = await import('../../src/sources/llms')

      mockFetchPackage.mockResolvedValue({
        name: 'serde',
        description: 'serde description',
        homepage: '',
        documentation: '',
        repository: 'https://github.com/serde-rs/serde',
        licenses: 'MIT',
        keywords: [],
        namespace: '',
        latestVersion: '1.0.220',
        metadata: {},
      })

      const mockUrls = {
        documentation: vi.fn(() => 'https://docs.rs/serde/1.0.220'),
        registry: vi.fn(),
        download: vi.fn(),
        readme: vi.fn(),
        purl: vi.fn(),
      }
      mockCreateFromPURL.mockReturnValue([{ urls: () => mockUrls, ecosystem: () => 'cargo' }, 'serde', ''])
      mockResolveDocsUrl.mockReturnValue('https://docs.rs/serde/1.0.220')

      vi.mocked(resolveGitHubRepo).mockResolvedValue({
        name: 'serde',
        version: '1.0.220',
        description: 'github description',
        docsUrl: 'https://serde.rs',
        readmeUrl: 'ungh://serde-rs/serde',
        repoUrl: 'https://github.com/serde-rs/serde',
      })
      vi.mocked(fetchLlmsUrl).mockResolvedValue('https://serde.rs/llms.txt')

      const result = await resolveRegistryDocsWithAttempts('cargo', 'serde')

      expect(result.package).toMatchObject({
        name: 'serde',
        version: '1.0.220',
        readmeUrl: 'ungh://serde-rs/serde',
        repoUrl: 'https://github.com/serde-rs/serde',
        llmsUrl: 'https://serde.rs/llms.txt',
      })
      expect(result.attempts).toContainEqual(expect.objectContaining({
        source: 'github-meta',
        status: 'success',
      }))
      expect(result.attempts).toContainEqual(expect.objectContaining({
        source: 'llms.txt',
        status: 'success',
      }))
    })
  })
})
