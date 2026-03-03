-- 0019_phishing_tracking.sql
-- Add phishing tracking fields to domains table

ALTER TABLE domains ADD COLUMN phishing_status TEXT DEFAULT NULL;
-- Values: 'clean' | 'detected' | NULL (never checked)

ALTER TABLE domains ADD COLUMN phishing_checked_at TEXT DEFAULT NULL;
-- ISO timestamp of last phishing check
