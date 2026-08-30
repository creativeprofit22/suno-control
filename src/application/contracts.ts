import type { SubmissionReceipt, SunoJob, TrackedJob, TrackedOutput } from "../domain/job.js";

export interface JobRepository {
  load(id: string): Promise<TrackedJob | undefined>;
  save(job: TrackedJob): Promise<void>;
  outputsExist(job: TrackedJob): Promise<boolean>;
}

export interface TemporaryOutput {
  path: string;
  suggestedName: string;
}

export interface OutputStore {
  exists(jobId: string, relativePath: string): Promise<boolean>;
  persist(jobId: string, output: TemporaryOutput): Promise<string>;
}

export type DiagnosticStage = "launch" | "preparation" | "submission" | "observation" | "download";
export type AutomationStatus =
  | "accepted"
  | "completed"
  | "login-required"
  | "challenge-required"
  | "validation-rejected"
  | "rate-limited"
  | "account-blocked"
  | "changed-ui"
  | "failed"
  | "unknown";

export interface DiagnosticFact {
  key: string;
  count: number;
  visible: boolean;
}

export interface AutomationOutcome {
  status: AutomationStatus;
  receipt?: SubmissionReceipt;
  outputs?: TrackedOutput[];
  code?: string;
  stage?: DiagnosticStage;
  location?: "suno-create" | "suno-login" | "suno-other" | "external" | "unknown";
  facts?: DiagnosticFact[];
}

export interface SunoSession {
  submit(job: SunoJob, checkpoint: () => Promise<void>): Promise<AutomationOutcome>;
  observe(job: TrackedJob): Promise<AutomationOutcome>;
  close(): Promise<void>;
}

export interface SunoAutomation {
  open(): Promise<SunoSession>;
}
