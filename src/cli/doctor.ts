import { formatDoctorReport, runDoctor, type DoctorOptions } from '../core/doctor';

export interface DoctorCommandOptions {
  json?: boolean;
  write?: (text: string) => void;
  doctorOptions?: DoctorOptions;
}

/** Execute the doctor command and return the process exit code for automation. */
export async function runDoctorCommand(options: DoctorCommandOptions = {}): Promise<number> {
  const report = await runDoctor(options.doctorOptions);
  const output = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatDoctorReport(report);
  (options.write ?? ((text) => process.stdout.write(text)))(output);
  return report.ok ? 0 : 1;
}
