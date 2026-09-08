export type OperationDescriptor = {
  operationId: string;
  group: string;
  action: string;
  parameterSchemaVersion: number;
  resultSchemaVersion: number;
  supported: boolean;
  policyClass: string;
  effectClass: "READ_ONLY" | "IDEMPOTENT_WRITE" | "WORKSPACE_WRITE" | "EXTERNAL_EFFECT";
  sideEffectClass: "READ_ONLY" | "IDEMPOTENT_WRITE" | "WORKSPACE_WRITE" | "EXTERNAL_EFFECT";
  available: boolean;
  reason?: string;
  unavailableReason?: string;
  mutating: boolean;
  requiresRevision: boolean;
  requiredParameters: string[];
  supportsIdempotency: boolean;
  supportsCas: boolean;
};

const read = (operationId: string, group: string, action: string, requiredParameters: string[] = [], available = true, reason?: string): OperationDescriptor => ({ operationId, group, action, parameterSchemaVersion: 1, resultSchemaVersion: 1, supported: available, policyClass: group, effectClass: "READ_ONLY", sideEffectClass: "READ_ONLY", available, ...(reason ? { reason, unavailableReason: reason } : {}), mutating: false, requiresRevision: false, requiredParameters, supportsIdempotency: false, supportsCas: false });
const write = (operationId: string, group: string, action: string, effectClass: OperationDescriptor["effectClass"], requiredParameters: string[], available = true, reason?: string): OperationDescriptor => ({ operationId, group, action, parameterSchemaVersion: 1, resultSchemaVersion: 1, supported: available, policyClass: group, effectClass, sideEffectClass: effectClass, available, ...(reason ? { reason, unavailableReason: reason } : {}), mutating: true, requiresRevision: requiredParameters.some((name) => name.startsWith("expected_") || name === "if_match"), requiredParameters, supportsIdempotency: true, supportsCas: effectClass === "IDEMPOTENT_WRITE" || effectClass === "WORKSPACE_WRITE" });

/**
 * The catalog is deliberately declarative. Runtime handlers still validate the
 * request and route through the owning service; the catalog never grants scope
 * or exposes an arbitrary HTTP/shell escape hatch.
 */
export function operationCatalog(options: { artifacts: boolean; modelTests: boolean; modelPreferences: boolean; onboarding: boolean }): OperationDescriptor[] {
  return [
    read("control.missions.list", "control.missions", "list"),
    read("control.missions.get", "control.missions", "get", ["mission_id"]),
    read("control.missions.events", "control.missions", "events", ["mission_id"], false, "MISSION_EVENTS_USE_PUBLIC_ROUTE"),
    write("control.missions.create", "control.missions", "create", "IDEMPOTENT_WRITE", ["office_id", "brain_protocol_version", "title", "goal"]),
    write("control.missions.append_input", "control.missions", "append_input", "IDEMPOTENT_WRITE", ["mission_id", "kind", "text"]),
    write("control.missions.pause", "control.missions", "pause", "IDEMPOTENT_WRITE", ["mission_id", "expected_control_revision"]),
    write("control.missions.resume", "control.missions", "resume", "IDEMPOTENT_WRITE", ["mission_id", "expected_control_revision"]),
    write("control.missions.cancel", "control.missions", "cancel", "IDEMPOTENT_WRITE", ["mission_id", "expected_control_revision"]),
    read("control.missions.results", "control.missions", "results", ["mission_id"]),
    read("control.tasks.list", "control.tasks", "list"),
    read("control.tasks.get", "control.tasks", "get", ["task_id"]),
    read("control.tasks.events", "control.tasks", "events", ["task_id"], false, "TASK_EVENTS_USE_PUBLIC_ROUTE"),
    read("control.tasks.results", "control.tasks", "results", ["task_id"], false, "TASK_RESULTS_USE_PUBLIC_ROUTE"),
    write("control.tasks.create", "control.tasks", "create", "IDEMPOTENT_WRITE", ["title", "task_type", "instruction"], false, "TASK_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.tasks.cancel", "control.tasks", "cancel", "IDEMPOTENT_WRITE", ["task_id"], false, "TASK_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.tasks.retry", "control.tasks", "retry", "IDEMPOTENT_WRITE", ["task_id"], false, "TASK_OPERATION_USE_PUBLIC_ROUTE"),
    read("control.workers.list", "control.workers", "list"),
    read("control.workers.get", "control.workers", "get", ["worker_id"]),
    write("control.workers.rename", "control.workers", "rename", "IDEMPOTENT_WRITE", ["worker_id", "name"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    read("control.workers.preferences", "control.workers", "preferences", ["worker_id"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    read("control.workers.diagnose", "control.workers", "diagnose", ["worker_id"], false, "WORKER_DIAGNOSTICS_USE_PUBLIC_ROUTE"),
    write("control.workers.drain", "control.workers", "drain", "IDEMPOTENT_WRITE", ["worker_id"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.workers.resume", "control.workers", "resume", "IDEMPOTENT_WRITE", ["worker_id"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.workers.enable", "control.workers", "enable", "IDEMPOTENT_WRITE", ["worker_id"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.workers.disable", "control.workers", "disable", "IDEMPOTENT_WRITE", ["worker_id"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.workers.approve_registration", "control.workers", "approve_registration", "IDEMPOTENT_WRITE", ["registration_id"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.workers.reject_registration", "control.workers", "reject_registration", "IDEMPOTENT_WRITE", ["registration_id"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.workers.remove_registration", "control.workers", "remove_registration", "IDEMPOTENT_WRITE", ["registration_id"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.workers.grant", "control.workers", "grant", "EXTERNAL_EFFECT", ["worker_id", "capability"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    write("control.workers.revoke", "control.workers", "revoke", "EXTERNAL_EFFECT", ["worker_id", "capability"], false, "WORKER_OPERATION_USE_PUBLIC_ROUTE"),
    read("control.models.list", "control.models", "list"),
    read("control.models.test_templates", "control.models", "test_templates", [], options.modelTests, options.modelTests ? undefined : "MODEL_TEST_UNAVAILABLE"),
    write("control.models.test_create", "control.models", "test_create", "IDEMPOTENT_WRITE", ["template_id", "template_version", "input"], false, "MODEL_TEST_USE_PUBLIC_ROUTE"),
    read("control.models.test_get", "control.models", "test_get", ["batch_id"], false, "MODEL_TEST_USE_PUBLIC_ROUTE"),
    write("control.models.test_cancel", "control.models", "test_cancel", "IDEMPOTENT_WRITE", ["batch_id"], false, "MODEL_TEST_USE_PUBLIC_ROUTE"),
    read("control.model_preferences.list", "control.models", "preference_list", [], options.modelPreferences, options.modelPreferences ? undefined : "MODEL_PREFERENCE_UNAVAILABLE"),
    write("control.model_preferences.create", "control.models", "preference_create", "IDEMPOTENT_WRITE", ["name", "task_type", "targets"], false, "MODEL_PREFERENCE_USE_PUBLIC_ROUTE"),
    write("control.model_preferences.update", "control.models", "preference_update", "IDEMPOTENT_WRITE", ["preference_id", "if_match"], false, "MODEL_PREFERENCE_USE_PUBLIC_ROUTE"),
    write("control.model_preferences.delete", "control.models", "preference_delete", "IDEMPOTENT_WRITE", ["preference_id", "if_match"], false, "MODEL_PREFERENCE_USE_PUBLIC_ROUTE"),
    read("control.office.list", "control.office", "list"),
    read("control.office.get", "control.office", "get", ["office_id"], false, "OFFICE_USE_PUBLIC_ROUTE"),
    write("control.office.role_create", "control.office", "role_create", "IDEMPOTENT_WRITE", ["name", "responsibilities"], false, "OFFICE_USE_PUBLIC_ROUTE"),
    write("control.office.role_revise", "control.office", "role_revise", "IDEMPOTENT_WRITE", ["role_id", "if_match"], false, "OFFICE_USE_PUBLIC_ROUTE"),
    write("control.office.member_create", "control.office", "member_create", "IDEMPOTENT_WRITE", ["office_id", "role_id", "display_name", "seat_key"], false, "OFFICE_USE_PUBLIC_ROUTE"),
    write("control.office.member_revise", "control.office", "member_revise", "IDEMPOTENT_WRITE", ["member_id", "if_match"], false, "OFFICE_USE_PUBLIC_ROUTE"),
    write("control.office.member_archive", "control.office", "member_archive", "IDEMPOTENT_WRITE", ["member_id", "if_match"], false, "OFFICE_USE_PUBLIC_ROUTE"),
    read("control.capabilities.get", "control.capabilities", "get"),
    read("control.systems.list", "control.systems", "list"),
    read("control.systems.health", "control.systems", "health", [], false, "SYSTEMS_USE_PUBLIC_ROUTE"),
    read("control.systems.dashboard", "control.systems", "dashboard", [], false, "SYSTEMS_USE_PUBLIC_ROUTE"),
    read("control.systems.acceptance", "control.systems", "acceptance", [], false, "SYSTEMS_USE_PUBLIC_ROUTE"),
    read("control.systems.recovery_status", "control.systems", "recovery_status", [], false, "SYSTEMS_USE_PUBLIC_ROUTE"),
    read("control.settings.get", "control.settings", "get"),
    read("control.settings.effective", "control.settings", "effective", [], false, "SETTINGS_USE_PUBLIC_ROUTE"),
    write("control.settings.update", "control.settings", "update", "IDEMPOTENT_WRITE", ["if_match"], false, "SETTINGS_OPERATION_USE_PUBLIC_ROUTE"),
    read("control.artifacts.get", "control.artifacts", "get", ["artifact_id"], options.artifacts, options.artifacts ? undefined : "ARTIFACT_STORAGE_UNAVAILABLE"),
    read("control.artifacts.list", "control.artifacts", "list", [], false, "ARTIFACT_USE_PUBLIC_ROUTE"),
    read("control.artifacts.preview", "control.artifacts", "preview", ["artifact_id"], false, "ARTIFACT_USE_PUBLIC_ROUTE"),
    read("control.artifacts.download", "control.artifacts", "download", ["artifact_id"], false, "ARTIFACT_USE_PUBLIC_ROUTE"),
    write("control.artifacts.upload", "control.artifacts", "upload", "WORKSPACE_WRITE", ["mission_id", "filename"], false, "ARTIFACT_UPLOAD_NOT_IMPLEMENTED"),
    read("control.worker_onboarding.get", "control.workers", "onboarding", ["onboarding_id"], options.onboarding, options.onboarding ? undefined : "ONBOARDING_UNAVAILABLE"),
    write("control.missions.reopen", "control.missions", "reopen", "IDEMPOTENT_WRITE", ["mission_id", "expected_mission_revision"]),
    write("control.missions.answer", "control.missions", "answer", "IDEMPOTENT_WRITE", ["mission_id", "question_id", "expected_objective_revision"], false, "OWNER_QUESTION_NOT_IMPLEMENTED"),
    write("control.missions.retry_delivery", "control.missions", "retry_delivery", "EXTERNAL_EFFECT", ["mission_id", "delivery_id"], false, "DELIVERY_RETRY_NOT_IMPLEMENTED"),
    read("control.operations.catalog", "control.operations", "catalog"),
    read("control.operations.status", "control.operations", "status", ["operation_id"]),
    write("hermes.schedules.create", "hermes.schedules", "create", "IDEMPOTENT_WRITE", ["schedule_expression", "timezone", "instruction"], false, "HERMES_SCHEDULER_OWNED"),
    read("hermes.schedules.list", "hermes.schedules", "list", [], false, "HERMES_SCHEDULER_OWNED"),
    read("hermes.schedules.get", "hermes.schedules", "get", ["schedule_id"], false, "HERMES_SCHEDULER_OWNED"),
    write("hermes.schedules.update", "hermes.schedules", "update", "IDEMPOTENT_WRITE", ["schedule_id", "expected_revision"], false, "HERMES_SCHEDULER_OWNED"),
    write("hermes.schedules.pause", "hermes.schedules", "pause", "IDEMPOTENT_WRITE", ["schedule_id", "expected_revision"], false, "HERMES_SCHEDULER_OWNED"),
    write("hermes.schedules.resume", "hermes.schedules", "resume", "IDEMPOTENT_WRITE", ["schedule_id", "expected_revision"], false, "HERMES_SCHEDULER_OWNED"),
    write("hermes.schedules.delete", "hermes.schedules", "delete", "IDEMPOTENT_WRITE", ["schedule_id", "expected_revision"], false, "HERMES_SCHEDULER_OWNED"),
    write("hermes.schedules.run_now", "hermes.schedules", "run_now", "IDEMPOTENT_WRITE", ["schedule_id"], false, "HERMES_SCHEDULER_OWNED"),
    read("hermes.schedules.history", "hermes.schedules", "history", ["schedule_id"], false, "HERMES_SCHEDULER_OWNED"),
    read("hermes.configuration.model_status", "hermes.configuration", "model_status", [], false, "HERMES_CONFIGURATION_NOT_CONNECTED"),
    write("hermes.configuration.model_change", "hermes.configuration", "model_change", "IDEMPOTENT_WRITE", ["model", "expected_revision"], false, "HERMES_CONFIGURATION_NOT_CONNECTED"),
    read("hermes.configuration.tool_status", "hermes.configuration", "tool_status", [], false, "HERMES_CONFIGURATION_NOT_CONNECTED"),
    write("hermes.tools.execute", "hermes.tools", "execute", "EXTERNAL_EFFECT", ["tool_id", "arguments"], false, "HERMES_TOOL_RUNTIME_NOT_CONNECTED"),
    read("platform.deployments.list", "platform.deployments", "list", [], false, "DEPLOYMENT_ADAPTER_NOT_CONNECTED"),
    write("platform.deployments.validate", "platform.deployments", "validate", "IDEMPOTENT_WRITE", ["project_id"], false, "DEPLOYMENT_ADAPTER_NOT_CONNECTED"),
    write("platform.deployments.deploy", "platform.deployments", "deploy", "EXTERNAL_EFFECT", ["project_id", "release_digest"], false, "DEPLOYMENT_ADAPTER_NOT_CONNECTED"),
    read("platform.deployments.status", "platform.deployments", "status", ["project_id"], false, "DEPLOYMENT_ADAPTER_NOT_CONNECTED"),
    write("platform.deployments.rollback", "platform.deployments", "rollback", "EXTERNAL_EFFECT", ["project_id"], false, "DEPLOYMENT_ADAPTER_NOT_CONNECTED"),
  ];
}
