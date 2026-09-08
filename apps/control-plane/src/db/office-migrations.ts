export const officeMigrations: Array<[number, string, string]> = [
  [7, "virtual-office-core-v1", `
CREATE TABLE IF NOT EXISTS offices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, layout_json TEXT NOT NULL DEFAULT '{}',
  presentation_revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS role_definitions (
  role_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
  responsibilities TEXT NOT NULL, contract_json TEXT NOT NULL DEFAULT '{}',
  contract_hash TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER,
  PRIMARY KEY(role_id, version)
);
CREATE TABLE IF NOT EXISTS office_members (
  id TEXT PRIMARY KEY, office_id TEXT NOT NULL REFERENCES offices(id), role_id TEXT NOT NULL,
  role_version INTEGER NOT NULL, display_name TEXT NOT NULL, avatar_key TEXT,
  seat_key TEXT NOT NULL, binding_json TEXT NOT NULL DEFAULT '{}',
  max_concurrency INTEGER NOT NULL DEFAULT 1, config_revision INTEGER NOT NULL DEFAULT 1,
  presentation_revision INTEGER NOT NULL DEFAULT 1, archived_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(role_id, role_version) REFERENCES role_definitions(role_id, version),
  UNIQUE(office_id, seat_key)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, office_id TEXT NOT NULL REFERENCES offices(id), title TEXT NOT NULL,
  goal TEXT NOT NULL, source_ref_json TEXT, scope_json TEXT NOT NULL, limits_json TEXT NOT NULL,
  delivery_target_json TEXT NOT NULL, mission_revision INTEGER NOT NULL DEFAULT 1,
  objective_revision INTEGER NOT NULL DEFAULT 1, current_mission_run_id TEXT,
  first_started_at INTEGER NOT NULL, deadline_at INTEGER, deadline_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS mission_inputs (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), input_seq INTEGER NOT NULL,
  objective_revision INTEGER NOT NULL, kind TEXT NOT NULL, text_json TEXT,
  artifact_id TEXT, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(mission_id, input_seq)
);
CREATE TABLE IF NOT EXISTS mission_runs (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), run_number INTEGER NOT NULL,
  phase TEXT NOT NULL, control TEXT NOT NULL, control_revision INTEGER NOT NULL DEFAULT 1,
  active_plan_revision INTEGER, pending_plan_revision INTEGER, objective_snapshot_json TEXT NOT NULL,
  limits_snapshot_json TEXT NOT NULL, scope_snapshot_json TEXT NOT NULL, projection_revision INTEGER NOT NULL DEFAULT 1,
  authority_epoch TEXT NOT NULL, next_wake_at INTEGER, wait_summary_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL, finished_at INTEGER, stop_reason TEXT, cleanup_state TEXT NOT NULL DEFAULT 'CLEAR',
  UNIQUE(mission_id, run_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_one_active_run ON mission_runs(mission_id)
  WHERE phase NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');
CREATE TABLE IF NOT EXISTS mission_plans (
  id TEXT PRIMARY KEY, mission_run_id TEXT NOT NULL REFERENCES mission_runs(id), revision INTEGER NOT NULL,
  base_revision INTEGER, objective_revision INTEGER NOT NULL, status TEXT NOT NULL,
  proposal_json TEXT NOT NULL, proposal_hash TEXT NOT NULL, command_id TEXT,
  created_at INTEGER NOT NULL, activated_at INTEGER,
  UNIQUE(mission_run_id, revision)
);
CREATE TABLE IF NOT EXISTS mission_steps (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES mission_plans(id), step_key TEXT NOT NULL,
  kind TEXT NOT NULL, member_snapshot_json TEXT NOT NULL, contract_json TEXT NOT NULL,
  input_fingerprint TEXT, state TEXT NOT NULL, wait_reason TEXT, next_wake_at INTEGER,
  execution_generation INTEGER NOT NULL DEFAULT 1, output_manifest_json TEXT,
  output_ready_at INTEGER, accepted_at INTEGER, current_execution_id TEXT,
  reused_from_step_id TEXT, failure_json TEXT, updated_at INTEGER NOT NULL,
  UNIQUE(plan_id, step_key)
);
CREATE TABLE IF NOT EXISTS mission_step_dependencies (
  plan_id TEXT NOT NULL REFERENCES mission_plans(id), from_step_id TEXT NOT NULL REFERENCES mission_steps(id),
  to_step_id TEXT NOT NULL REFERENCES mission_steps(id), condition TEXT NOT NULL,
  input_mapping_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(from_step_id, to_step_id)
);
CREATE INDEX IF NOT EXISTS idx_mission_runs_phase_wake ON mission_runs(phase, next_wake_at);
CREATE INDEX IF NOT EXISTS idx_mission_steps_plan_state ON mission_steps(plan_id, state, next_wake_at);
CREATE INDEX IF NOT EXISTS idx_missions_office_created ON missions(office_id, created_at DESC, id DESC);
`,],
  [8, "virtual-office-coordination-v1", `
CREATE TABLE IF NOT EXISTS mission_step_executions (
  id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES mission_steps(id), generation INTEGER NOT NULL,
  backend_kind TEXT NOT NULL, task_id TEXT, task_run_id TEXT, command_id TEXT,
  state TEXT NOT NULL, retry_safety TEXT NOT NULL, operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, resolved_target_json TEXT NOT NULL DEFAULT '{}', resource_state TEXT NOT NULL DEFAULT 'CLEAR',
  started_at INTEGER, finished_at INTEGER, UNIQUE(step_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_exec_task_run ON mission_step_executions(task_run_id) WHERE task_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_exec_command ON mission_step_executions(command_id) WHERE command_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS office_resource_slots (
  resource_key TEXT NOT NULL, slot_no INTEGER NOT NULL, execution_id TEXT REFERENCES mission_step_executions(id),
  task_attempt_id TEXT, brain_attempt_id TEXT, state TEXT NOT NULL, acquired_at INTEGER, released_at INTEGER,
  PRIMARY KEY(resource_key, slot_no)
);
CREATE TABLE IF NOT EXISTS mission_budget_charges (
  mission_id TEXT NOT NULL REFERENCES missions(id), mission_run_id TEXT NOT NULL REFERENCES mission_runs(id),
  charge_key TEXT NOT NULL, dimension TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0), created_at INTEGER NOT NULL,
  PRIMARY KEY(mission_id, charge_key, dimension)
);
CREATE TABLE IF NOT EXISTS mission_decisions (
  id TEXT PRIMARY KEY, mission_run_id TEXT NOT NULL REFERENCES mission_runs(id), step_id TEXT,
  objective_revision INTEGER NOT NULL, request_hash TEXT NOT NULL, kind TEXT NOT NULL,
  prompt_json TEXT NOT NULL, state TEXT NOT NULL, answer_json TEXT, answer_hash TEXT,
  expires_at INTEGER, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS mission_commands (
  id TEXT PRIMARY KEY, mission_run_id TEXT NOT NULL REFERENCES mission_runs(id), step_execution_id TEXT,
  kind TEXT NOT NULL, logical_key TEXT NOT NULL, envelope_json TEXT NOT NULL, request_hash TEXT NOT NULL,
  transport_state TEXT NOT NULL, processing_state TEXT NOT NULL, next_send_at INTEGER NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT, claim_until INTEGER,
  brain_attempts INTEGER NOT NULL DEFAULT 0, current_brain_attempt_id TEXT, result_hash TEXT,
  result_json TEXT, applied_at INTEGER, expires_at INTEGER, last_error TEXT,
  UNIQUE(mission_run_id, logical_key)
);
CREATE TABLE IF NOT EXISTS mission_command_attempts (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL REFERENCES mission_commands(id), attempt_number INTEGER NOT NULL,
  admission_key TEXT NOT NULL, admission_hash TEXT NOT NULL, admission_receipt_json TEXT,
  state TEXT NOT NULL, claim_generation INTEGER NOT NULL DEFAULT 1, last_heartbeat_at INTEGER,
  deadline_at INTEGER, process_evidence_json TEXT, result_hash TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
  UNIQUE(command_id, attempt_number), UNIQUE(command_id, admission_key)
);
CREATE TABLE IF NOT EXISTS mission_inbox (
  id TEXT PRIMARY KEY, producer TEXT NOT NULL, producer_event_id TEXT NOT NULL,
  mission_run_id TEXT NOT NULL REFERENCES mission_runs(id), payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
  state TEXT NOT NULL, available_at INTEGER NOT NULL, processed_at INTEGER, error_json TEXT,
  UNIQUE(producer, producer_event_id)
);
CREATE TABLE IF NOT EXISTS mission_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, office_id TEXT NOT NULL REFERENCES offices(id),
  mission_id TEXT NOT NULL REFERENCES missions(id), mission_run_id TEXT NOT NULL REFERENCES mission_runs(id),
  type TEXT NOT NULL, event_version INTEGER NOT NULL DEFAULT 1, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_deliveries (
  id TEXT PRIMARY KEY, mission_run_id TEXT NOT NULL REFERENCES mission_runs(id), final_manifest_hash TEXT NOT NULL,
  target_key TEXT NOT NULL, target_ref_json TEXT NOT NULL, state TEXT NOT NULL, command_id TEXT,
  receipt_revision INTEGER NOT NULL DEFAULT 0, receipt_json TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, last_error TEXT,
  UNIQUE(mission_run_id, final_manifest_hash, target_key)
);
CREATE INDEX IF NOT EXISTS idx_mission_inbox_due ON mission_inbox(state, available_at);
CREATE INDEX IF NOT EXISTS idx_mission_commands_due ON mission_commands(transport_state, next_send_at, claim_until);
CREATE INDEX IF NOT EXISTS idx_mission_commands_processing ON mission_commands(processing_state, expires_at);
CREATE INDEX IF NOT EXISTS idx_mission_events_mission ON mission_events(mission_id, seq);
`,],
  [9, "virtual-office-artifacts-v1", `
CREATE TABLE IF NOT EXISTS mission_uploads (
  id TEXT PRIMARY KEY, owner_scope_json TEXT NOT NULL, scope_key TEXT NOT NULL, artifact_key TEXT NOT NULL,
  expected_digest TEXT, expected_size INTEGER, filename TEXT NOT NULL, media_type TEXT NOT NULL,
  state TEXT NOT NULL, temp_relative_path TEXT NOT NULL, artifact_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(scope_key, artifact_key)
);
CREATE TABLE IF NOT EXISTS mission_artifacts (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), mission_run_id TEXT,
  step_id TEXT, execution_id TEXT, owner_key TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  purpose TEXT NOT NULL, pin_state TEXT NOT NULL, retain_until INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(owner_key, artifact_id, purpose)
);
CREATE INDEX IF NOT EXISTS idx_mission_artifacts_pin ON mission_artifacts(artifact_id, pin_state);
CREATE INDEX IF NOT EXISTS idx_mission_deliveries_state ON mission_deliveries(state, created_at);
`,],
  [10, "virtual-office-recovery-v1", `
ALTER TABLE mission_inbox ADD COLUMN claim_token TEXT;
ALTER TABLE mission_inbox ADD COLUMN claim_until INTEGER;
ALTER TABLE mission_command_attempts ADD COLUMN progress_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_mission_inbox_claim ON mission_inbox(state, claim_until);
`,],
  [11, "hermes-control-brain-v2", `
ALTER TABLE missions ADD COLUMN source_intent_key TEXT;
ALTER TABLE missions ADD COLUMN conversation_ref TEXT;
ALTER TABLE missions ADD COLUMN acceptance_json TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_source_intent ON missions(source_intent_key) WHERE source_intent_key IS NOT NULL;
ALTER TABLE mission_runs ADD COLUMN brain_protocol_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mission_runs ADD COLUMN brain_state TEXT NOT NULL DEFAULT 'IDLE';
ALTER TABLE mission_runs ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mission_runs ADD COLUMN decision_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mission_runs ADD COLUMN current_decision_command_id TEXT;
ALTER TABLE mission_runs ADD COLUMN decision_pending INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS mission_waits (
  id TEXT PRIMARY KEY, mission_run_id TEXT NOT NULL REFERENCES mission_runs(id),
  decision_command_id TEXT, reason TEXT NOT NULL, subscription_json TEXT NOT NULL DEFAULT '{}',
  deadline_at INTEGER, state TEXT NOT NULL, satisfied_event_id TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_wait_active ON mission_waits(mission_run_id) WHERE state IN ('PENDING', 'SATISFIED');
CREATE TABLE IF NOT EXISTS mission_tool_operations (
  id TEXT PRIMARY KEY, mission_run_id TEXT NOT NULL REFERENCES mission_runs(id),
  execution_id TEXT, command_id TEXT, tool_id TEXT NOT NULL, operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, effect_class TEXT NOT NULL, state TEXT NOT NULL,
  external_handle_json TEXT, result_hash TEXT, result_json TEXT, scope_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(operation_key)
);
CREATE INDEX IF NOT EXISTS idx_mission_tool_operations_state ON mission_tool_operations(state, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_one_decision_pending ON mission_commands(mission_run_id)
  WHERE kind = 'mission.decide' AND processing_state IN ('NOT_STARTED', 'ADMITTED', 'RUNNING');
CREATE TABLE IF NOT EXISTS mission_acceptance_checks (
  id TEXT PRIMARY KEY, mission_run_id TEXT NOT NULL REFERENCES mission_runs(id), criterion_id TEXT NOT NULL,
  objective_revision INTEGER NOT NULL, subject_hash TEXT NOT NULL, verdict TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}', reviewer_ref TEXT, producer_command_id TEXT,
  check_key TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(producer_command_id, check_key)
);
CREATE INDEX IF NOT EXISTS idx_mission_acceptance_run ON mission_acceptance_checks(mission_run_id, objective_revision, criterion_id);
ALTER TABLE mission_deliveries ADD COLUMN delivery_key TEXT;
ALTER TABLE mission_deliveries ADD COLUMN conversation_ref TEXT;
ALTER TABLE mission_deliveries ADD COLUMN uncertainty_reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_delivery_key ON mission_deliveries(delivery_key) WHERE delivery_key IS NOT NULL;
`,],
  [12, "hermes-source-intent-fencing-v1", `
ALTER TABLE missions ADD COLUMN source_intent_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_source_intent_hash ON missions(source_intent_key, source_intent_hash) WHERE source_intent_key IS NOT NULL;
`,],
];
