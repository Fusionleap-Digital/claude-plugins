-- Synthetic schema for the profiler test
CREATE TABLE IF NOT EXISTS "patients" (
  patient_id BIGINT PRIMARY KEY,
  mrn VARCHAR(20) NOT NULL,
  first_name VARCHAR(80),
  date_of_birth DATE,
  diagnosis_code VARCHAR(10),
  updated_at TIMESTAMP NOT NULL
);
CREATE TABLE visits (
  visit_id BIGINT,
  patient_id BIGINT REFERENCES patients(patient_id),
  amount NUMERIC(10, 2),
  card_number VARCHAR(19),
  CONSTRAINT visits_pk PRIMARY KEY (visit_id)
);
CREATE TABLE audit_log (
  event TEXT,
  ip_address VARCHAR(45)
);
