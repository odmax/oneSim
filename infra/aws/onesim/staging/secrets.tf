# ---------------------------------------------------------------------------
# Application runtime secret containers.
#
# Values are machine-generated RANDOM placeholders stored ONLY in AWS Secrets
# Manager. Nothing is committed to this repository and no value is ever printed
# by Terraform outputs. NEXTAUTH_SECRET / ENCRYPTION_KEY use byte_length 32
# (64 hex chars) to satisfy application validation; the rest use 16 bytes.
#
# RESEND_API_KEY (email) is created as an EMPTY container without a value and
# is intentionally NOT referenced by the default task definition — populate only
# if Resend email is enabled.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "app" {
  for_each = var.application_secret_specs
  name     = "onesim/staging/${each.key}"
  tags     = merge(local.common_tags, { Name = "onesim/staging/${each.key}" })
}

resource "random_id" "app_secret_value" {
  for_each    = var.application_secret_specs
  byte_length = each.value.byte_length
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each      = var.application_secret_specs
  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = random_id.app_secret_value[each.key].hex
}

# Optional email secret container (no value created).
resource "aws_secretsmanager_secret" "resend_api_key" {
  name = var.resend_api_key_secret_name
  tags = merge(local.common_tags, { Name = var.resend_api_key_secret_name })
}