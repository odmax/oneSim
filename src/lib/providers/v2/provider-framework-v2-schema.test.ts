import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

describe('Provider Framework V2 — Schema Migration', () => {
  beforeAll(async () => {
    await prisma.$connect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  // ── 1. Migration validates ───────────────────────────────────────────
  describe('Schema validity', () => {
    it('Prisma client connects successfully', async () => {
      const result = await prisma.$queryRaw`SELECT 1 as val`
      expect(result).toBeDefined()
    })
  })

  // ── 2. Existing provider records remain unchanged ────────────────────
  describe('Existing V1 data integrity', () => {
    it('Provider model is accessible and has all original fields', async () => {
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'providers' AND column_name IN ('id', 'name', 'code', 'type', 'apiBaseUrl', 'status', 'supportsESIM', 'priority')
        ORDER BY column_name
      `
      const names = columns.map(c => c.column_name)
      expect(names).toContain('id')
      expect(names).toContain('name')
      expect(names).toContain('code')
      expect(names).toContain('type')
      expect(names).toContain('apiBaseUrl')
      expect(names).toContain('status')
      expect(names).toContain('supportsESIM')
      expect(names).toContain('priority')
    })

    it('ProviderTemplate model is accessible and unchanged', async () => {
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'provider_templates' AND column_name IN ('id', 'name', 'connectorType', 'authType', 'defaultBaseUrl')
        ORDER BY column_name
      `
      const names = columns.map(c => c.column_name)
      expect(names).toContain('id')
      expect(names).toContain('name')
      expect(names).toContain('connectorType')
      expect(names).toContain('authType')
      expect(names).toContain('defaultBaseUrl')
    })

    it('V1 providers can be queried without errors', async () => {
      const providers = await prisma.provider.findMany({ take: 5 })
      expect(Array.isArray(providers)).toBe(true)
    })
  })

  // ── 3. V2 nullable linkage does not affect V1 providers ──────────────
  describe('V2 linkage on Provider model', () => {
    it('providers table has all V2 nullable columns', async () => {
      const columns = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'providers' AND column_name LIKE 'pv2%'
        ORDER BY column_name
      `
      const names = columns.map(c => c.column_name)
      expect(names).toContain('pv2TemplateId')
      expect(names).toContain('pv2TemplateVersionId')
      expect(names).toContain('pv2ConfigStatus')
      expect(names).toContain('pv2MigrationStatus')
      expect(names).toContain('pv2LastValidationResult')
      expect(names).toContain('pv2LastTemplateUpgradeAt')
      expect(names).toContain('pv2EnabledFeaturePacks')
      // All must be nullable
      for (const col of columns) {
        expect(col.is_nullable).toBe('YES')
      }
    })
  })

  // ── 4. New V2 tables exist ───────────────────────────────────────────
  describe('V2 tables exist', () => {
    const expectedTables = [
      'pv2_operations',
      'pv2_feature_packs',
      'pv2_feature_pack_operations',
      'pv2_templates',
      'pv2_template_versions',
      'pv2_template_feature_packs',
      'pv2_provider_feature_pack_overrides',
      'pv2_template_auth_configs',
      'pv2_template_auth_request_mappings',
      'pv2_template_auth_response_mappings',
      'pv2_template_endpoints',
      'pv2_template_endpoint_headers',
      'pv2_template_endpoint_query_params',
      'pv2_template_endpoint_path_params',
      'pv2_template_endpoint_body_params',
      'pv2_template_field_mappings',
      'pv2_template_transformations',
      'pv2_template_error_mappings',
      'pv2_template_retry_policies',
      'pv2_template_rate_limit_policies',
      'pv2_template_cache_policies',
      'pv2_template_pagination_configs',
      'pv2_template_webhook_configs',
      'pv2_template_health_checks',
      'pv2_template_sync_configs',
      'pv2_template_pipeline_configs',
      'pv2_events',
      'pv2_template_validation_rules',
    ]

    it.each(expectedTables)('table %s exists', async (tableName) => {
      const result = await prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = ${tableName}
        ) as exists
      `
      expect(result[0]?.exists).toBe(true)
    })
  })

  // ── 5. New V2 enums exist ────────────────────────────────────────────
  describe('V2 enums exist', () => {
    const expectedEnums = [
      'PV2TemplateStatus',
      'PV2TemplateProtocol',
      'PV2AuthStrategy',
      'PV2HttpMethod',
      'PV2ContentType',
      'PV2ParamSourceType',
      'PV2FieldDataType',
      'PV2MappingFailureBehavior',
      'PV2MappingAssociation',
      'PV2TransformationType',
      'PV2ErrorCategory',
      'PV2ErrorSeverity',
      'PV2BackoffStrategy',
      'PV2CacheScope',
      'PV2PaginationStrategy',
      'PV2WebhookSignatureStrategy',
      'PV2NormalizedWebhookEvent',
      'PV2SyncType',
      'PV2SyncConflictStrategy',
      'PV2SyncDeletionStrategy',
      'PV2PipelineStage',
      'PV2PipelineFailureBehavior',
      'PV2EventType',
      'PV2EventStatus',
      'PV2ValidationSeverity',
      'PV2ValidationPhase',
      'PV2RequestBodyMode',
      'PV2ResponseBodyMode',
      'PV2FeaturePackStatus',
    ]

    it.each(expectedEnums)('enum %s exists', async (enumName) => {
      const result = await prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = ${enumName}
        ) as exists
      `
      expect(result[0]?.exists).toBe(true)
    })
  })

  // ── 6. Existing enums are untouched ──────────────────────────────────
  describe('Existing enums untouched', () => {
    const existingEnums = ['UserRole', 'BusinessStatus', 'ProviderType', 'ProviderStatus', 'JobType', 'JobStatus']
    it.each(existingEnums)('enum %s still exists', async (enumName) => {
      const result = await prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = ${enumName}
        ) as exists
      `
      expect(result[0]?.exists).toBe(true)
    })
  })

  // ── 7. Template versioning — multiple versions per code ──────────────
  describe('Template versioning', () => {
    const templateCode = `TEST_V2_${Date.now()}`
    let templateId: string

    afterAll(async () => {
      // Cleanup
      if (templateId) {
        await prisma.pV2Template.deleteMany({ where: { code: templateCode } })
      }
    })

    it('can create a template', async () => {
      const template = await prisma.pV2Template.create({
        data: {
          code: templateCode,
          displayName: 'Test Template',
          providerFamily: 'TEST',
          semanticVersion: '1.0.0',
          status: 'DRAFT',
        },
      })
      templateId = template.id
      expect(template.id).toBeTruthy()
      expect(template.code).toBe(templateCode)
    })

    it('can create multiple versions of the same template code', async () => {
      const v1 = await prisma.pV2TemplateVersion.create({
        data: {
          templateId,
          version: 1,
          semanticVersion: '1.0.0',
          status: 'ACTIVE',
        },
      })
      expect(v1.version).toBe(1)

      const v2 = await prisma.pV2TemplateVersion.create({
        data: {
          templateId,
          version: 2,
          semanticVersion: '2.0.0',
          status: 'DRAFT',
        },
      })
      expect(v2.version).toBe(2)

      const versions = await prisma.pV2TemplateVersion.findMany({
        where: { templateId },
        orderBy: { version: 'asc' },
      })
      expect(versions).toHaveLength(2)
    })

    it('rejects duplicate template code + semantic version', async () => {
      await expect(
        prisma.pV2Template.create({
          data: {
            code: templateCode,
            displayName: 'Duplicate',
            providerFamily: 'TEST',
            semanticVersion: '1.0.0',
          },
        })
      ).rejects.toThrow()
    })

    it('rejects duplicate template version number', async () => {
      await expect(
        prisma.pV2TemplateVersion.create({
          data: {
            templateId,
            version: 1,
            semanticVersion: '1.0.1',
          },
        })
      ).rejects.toThrow()
    })
  })

  // ── 8. Endpoints bind to operations ──────────────────────────────────
  describe('Endpoint ↔ Operation binding', () => {
    const opCode = `TEST_OP_${Date.now()}`
    const epKey = `TEST_EP_${Date.now()}`
    let operationId: string
    let templateId: string
    let endpointId: string

    beforeAll(async () => {
      const op = await prisma.pV2Operation.create({
        data: { code: opCode, name: 'Test Operation', category: 'TEST' },
      })
      operationId = op.id

      const tmpl = await prisma.pV2Template.create({
        data: {
          code: `TEST_EP_TMPL_${Date.now()}`,
          displayName: 'EP Test',
          providerFamily: 'TEST',
          semanticVersion: '1.0.0',
        },
      })
      templateId = tmpl.id
    })

    afterAll(async () => {
      if (endpointId) await prisma.pV2TemplateEndpoint.deleteMany({ where: { templateId } })
      await prisma.pV2Template.deleteMany({ where: { id: templateId } })
      await prisma.pV2Operation.deleteMany({ where: { code: opCode } })
    })

    it('can create an endpoint bound to an operation', async () => {
      const ep = await prisma.pV2TemplateEndpoint.create({
        data: {
          templateId,
          operationId,
          endpointKey: epKey,
          httpMethod: 'GET',
          relativePath: '/api/v1/test',
        },
      })
      endpointId = ep.id
      expect(ep.operationId).toBe(operationId)
      expect(ep.endpointKey).toBe(epKey)
    })

    it('endpoint requires a valid operation relation', async () => {
      await expect(
        prisma.pV2TemplateEndpoint.create({
          data: {
            templateId,
            operationId: 'nonexistent_operation_id',
            endpointKey: 'INVALID',
            httpMethod: 'GET',
            relativePath: '/invalid',
          },
        })
      ).rejects.toThrow()
    })

    it('rejects duplicate endpoint key per template', async () => {
      await expect(
        prisma.pV2TemplateEndpoint.create({
          data: {
            templateId,
            operationId,
            endpointKey: epKey,
            httpMethod: 'POST',
            relativePath: '/api/v1/dup',
          },
        })
      ).rejects.toThrow()
    })
  })

  // ── 9. Feature packs bind to operations ──────────────────────────────
  describe('Feature Pack ↔ Operation binding', () => {
    const fpCode = `TEST_FP_${Date.now()}`
    const opCode = `TEST_FPOP_${Date.now()}`
    let featurePackId: string
    let operationId: string

    beforeAll(async () => {
      const fp = await prisma.pV2FeaturePack.create({
        data: { code: fpCode, name: 'Test FP', description: 'Test' },
      })
      featurePackId = fp.id

      const op = await prisma.pV2Operation.create({
        data: { code: opCode, name: 'Test FP Op', category: 'TEST' },
      })
      operationId = op.id
    })

    afterAll(async () => {
      await prisma.pV2FeaturePackOperation.deleteMany({ where: { featurePackId } })
      await prisma.pV2FeaturePack.deleteMany({ where: { id: featurePackId } })
      await prisma.pV2Operation.deleteMany({ where: { id: operationId } })
    })

    it('can bind an operation to a feature pack', async () => {
      const binding = await prisma.pV2FeaturePackOperation.create({
        data: { featurePackId, operationId, isRequired: true },
      })
      expect(binding.featurePackId).toBe(featurePackId)
      expect(binding.operationId).toBe(operationId)
    })

    it('rejects duplicate feature pack ↔ operation binding', async () => {
      await expect(
        prisma.pV2FeaturePackOperation.create({
          data: { featurePackId, operationId, isRequired: true },
        })
      ).rejects.toThrow()
    })

    it('feature pack requires valid operation relation', async () => {
      await expect(
        prisma.pV2FeaturePackOperation.create({
          data: { featurePackId, operationId: 'nonexistent', isRequired: true },
        })
      ).rejects.toThrow()
    })
  })

  // ── 10. Mappings enforce required relations ──────────────────────────
  describe('Field Mapping relations', () => {
    const opCode = `TEST_MAP_OP_${Date.now()}`
    let operationId: string
    let templateId: string

    beforeAll(async () => {
      const op = await prisma.pV2Operation.create({
        data: { code: opCode, name: 'Map Test Op', category: 'TEST' },
      })
      operationId = op.id

      const tmpl = await prisma.pV2Template.create({
        data: {
          code: `TEST_MAP_${Date.now()}`,
          displayName: 'Map Test',
          providerFamily: 'TEST',
          semanticVersion: '1.0.0',
        },
      })
      templateId = tmpl.id
    })

    afterAll(async () => {
      await prisma.pV2TemplateFieldMapping.deleteMany({ where: { templateId } })
      await prisma.pV2Template.deleteMany({ where: { id: templateId } })
      await prisma.pV2Operation.deleteMany({ where: { id: operationId } })
    })

    it('can create a field mapping with template relation', async () => {
      const mapping = await prisma.pV2TemplateFieldMapping.create({
        data: {
          templateId,
          association: 'REQUEST',
          sourcePath: '$.iccid',
          destinationPath: 'iccid',
          operationCode: 'ALLOCATE_ESIM',
        },
      })
      expect(mapping.templateId).toBe(templateId)
      expect(mapping.association).toBe('REQUEST')
    })

    it('field mapping sourcePath is required', async () => {
      await expect(
        prisma.pV2TemplateFieldMapping.create({
          data: {
            templateId,
            association: 'REQUEST',
            destinationPath: 'test',
          } as any,
        })
      ).rejects.toThrow()
    })
  })

  // ── 11. Auth config is one-per-template ───────────────────────────────
  describe('Auth Config uniqueness', () => {
    let templateId: string

    beforeAll(async () => {
      const tmpl = await prisma.pV2Template.create({
        data: {
          code: `TEST_AUTH_${Date.now()}`,
          displayName: 'Auth Test',
          providerFamily: 'TEST',
          semanticVersion: '1.0.0',
        },
      })
      templateId = tmpl.id
    })

    afterAll(async () => {
      await prisma.pV2TemplateAuthConfig.deleteMany({ where: { templateId } })
      await prisma.pV2Template.deleteMany({ where: { id: templateId } })
    })

    it('can create an auth config for a template', async () => {
      const auth = await prisma.pV2TemplateAuthConfig.create({
        data: { templateId, strategy: 'OAUTH2' },
      })
      expect(auth.strategy).toBe('OAUTH2')
    })

    it('rejects second auth config for same template', async () => {
      await expect(
        prisma.pV2TemplateAuthConfig.create({
          data: { templateId, strategy: 'API_KEY' },
        })
      ).rejects.toThrow()
    })
  })

  // ── 12. Event bus schema ─────────────────────────────────────────────
  describe('Event Bus (outbox)', () => {
    it('can create an event', async () => {
      const event = await prisma.pV2Event.create({
        data: {
          eventType: 'PROVIDER_REQUEST_STARTED',
          aggregateType: 'Order',
          aggregateId: 'test-order-123',
          payload: { test: true },
        },
      })
      expect(event.status).toBe('PENDING')
      expect(event.retryCount).toBe(0)
      // cleanup
      await prisma.pV2Event.delete({ where: { id: event.id } })
    })
  })
})
