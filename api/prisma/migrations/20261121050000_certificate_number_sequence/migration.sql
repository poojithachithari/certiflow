-- Certificate numbers come from a Postgres sequence: nextval() is atomic across all
-- connections and instances, so two certificates can never get the same number.
-- (The UNIQUE constraint on "Certificate"."number" is the second line of defence.)
CREATE SEQUENCE IF NOT EXISTS certificate_number_seq START WITH 100001;

-- Audit events and decisions are append-only: block UPDATE/DELETE at the database level,
-- so even a buggy code path cannot rewrite history.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER decision_append_only BEFORE UPDATE OR DELETE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
