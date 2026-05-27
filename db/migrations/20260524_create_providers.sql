CREATE TABLE provider_configs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(100) NOT NULL,
  slug              VARCHAR(60)  NOT NULL UNIQUE,
  base_url          TEXT         NOT NULL,
  auth_type         VARCHAR(40)  NOT NULL CHECK (auth_type IN (
                      'api_key', 'oauth2_client_credentials',
                      'basic_auth', 'bearer_token', 'custom_header'
                    )),
  credentials       TEXT         NOT NULL,
  adapter_class     VARCHAR(60)  NOT NULL DEFAULT 'rest_generic'
                    CHECK (adapter_class IN (
                      'rest_generic', 'rest_custom', 'soap', 'graphql'
                    )),
  field_mappings    JSONB        NOT NULL DEFAULT '{}',
  endpoints         JSONB        NOT NULL DEFAULT '{}',
  webhook_config    JSONB        NOT NULL DEFAULT '{}',
  active            BOOLEAN      NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_providers_slug   ON providers(slug);
CREATE INDEX idx_providers_active ON providers(active);
