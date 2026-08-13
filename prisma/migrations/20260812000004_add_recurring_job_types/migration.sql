-- Add the recurring job types used by the cron scheduler (process-jobs route).
-- Without these enum values seedRecurringJobs silently fails on every insert,
-- so the auto-sync / self-heal recurring jobs never run.
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'ESIM_STATUS_SYNC';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'ESIM_USAGE_SYNC';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'INSTALLATION_RECONCILIATION';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PROVIDER_SELF_HEAL';
