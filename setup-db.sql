-- Run this SQL to set up the OneSim database
-- Connect to PostgreSQL as postgres user and run:

-- Create database
CREATE DATABASE onesim_africa;

-- Connect to the new database and create extensions if needed
\c onesim_africa;

-- Verify creation
SELECT 'Database created successfully' AS status;
