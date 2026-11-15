ALTER TABLE noticeos.tempo_mpp_scans
  ADD COLUMN next_log_index integer NOT NULL DEFAULT 0 CHECK (next_log_index >= 0);

GRANT UPDATE (next_log_index) ON noticeos.tempo_mpp_scans TO noticeos_app;
