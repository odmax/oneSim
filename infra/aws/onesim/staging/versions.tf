# OneSIM staging infrastructure — Terraform backend configuration.
#
# Deliberately configured for a SEPARATE, isolated state key for OneSIM:
#   key = onesim/staging/terraform.tfstate
# This key must NEVER collide with or be derived from the pre-existing
# `infra/terraform.tfstate` found to have dangerous source/state divergence.
#
# IMPORTANT (do not act on in this task):
#   - terraform init/plan/apply against this shared bucket/table is FORBIDDEN
#     until the bucket encryption/versioning and DynamoDB locking configuration
#     are audited separately.
#   - Never reuse `infra/terraform.tfstate` as the key.
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket         = "onetelecom-terraform-state"
    key            = "onesim/staging/terraform.tfstate"
    region         = "af-south-1"
    dynamodb_table = "onetelecom-terraform-locks"
    encrypt        = true
  }
}