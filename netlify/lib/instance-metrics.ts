// Module-scope state survives across warm invocations of this function's own container: a
// fresh cold start re-evaluates the module (new process) and resets both counters back to
// zero. Each Netlify Function file is bundled/deployed independently, so these numbers are
// per-function-instance, not global across the whole site.
const instanceStartedAt = Date.now();
let invocationCount = 0;

export interface InstanceSnapshot {
  instanceAgeMs: number;
  instanceInvocations: number;
  isColdStart: boolean;
}

/** Call once per invocation. The first call in a fresh container reports isColdStart: true. */
export function recordInvocation(): InstanceSnapshot {
  invocationCount += 1;
  return {
    instanceAgeMs: Date.now() - instanceStartedAt,
    instanceInvocations: invocationCount,
    isColdStart: invocationCount === 1
  };
}
