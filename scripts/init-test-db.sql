-- Runs once, the first time the Postgres container starts.
-- A separate database for tests so they never wipe your dev data.
CREATE DATABASE api_test OWNER api;
