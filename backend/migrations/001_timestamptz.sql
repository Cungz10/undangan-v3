-- Jalankan SEKALI di Supabase SQL Editor kalau DB sudah pernah dibuat pakai TIMESTAMP biasa.
-- Asumsi: nilai lama tersimpan dalam UTC (default session timezone Supabase). Cek dulu: SHOW timezone;
BEGIN;
ALTER TABLE users          ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
                           ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE comments       ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
                           ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE likes          ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
ALTER TABLE invited_guests ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
                           ALTER COLUMN revoked_at TYPE TIMESTAMPTZ USING revoked_at AT TIME ZONE 'UTC';
ALTER TABLE check_ins      ALTER COLUMN checked_in_at TYPE TIMESTAMPTZ USING checked_in_at AT TIME ZONE 'UTC';
COMMIT;
