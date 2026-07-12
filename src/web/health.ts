import { runDoctor, type DoctorCheck, type DoctorReport } from "../core/doctor";
import { buildRuntimeStatus, type RuntimeStatusContext, type RuntimeStatusSnapshot } from "../core/status";

export interface WebHealthSnapshot {
  schemaVersion: 1;
  ok: boolean;
  generatedAt: string;
  runtime: {
    status: RuntimeStatusSnapshot;
  };
  doctor: {
    summary: DoctorReport["summary"];
    checks: DoctorCheck[];
  };
  nextActions: string[];
}

export async function buildWebHealth(context: RuntimeStatusContext): Promise<WebHealthSnapshot> {
  const status = buildRuntimeStatus(context);
  const doctor = await runDoctor();
  const nextActions = doctor.checks
    .filter((check) => check.status !== "pass" && check.action)
    .map((check) => `${check.title}: ${check.action}`)
    .slice(0, 6);

  return {
    schemaVersion: 1,
    ok: doctor.ok,
    generatedAt: doctor.generatedAt,
    runtime: { status },
    doctor: {
      summary: doctor.summary,
      checks: doctor.checks,
    },
    nextActions,
  };
}
