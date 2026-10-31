// Continuous Sokosumi worker, adapted from the TUM quickstart (masumi-network/tum-hackathon-quickstart).
// Change from the template: the result comes from report.mjs (deterministic, no Eve/model server),
// and a failed report read is retried on the next poll because it only reads public chain data.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { acquireWorkerLock } from "./worker-lock.mjs";
import { createAnswer, parseTask } from "./report.mjs";
import { reply } from "./comments.mjs";
import { createPaidAdapter, isPaidReady } from "./paid-task.mjs";
import { taskTarget, isTaskForTarget } from "./task-target.mjs";

const target = taskTarget();
const id = target.coworkerId;
const answer = createAnswer();
const releaseLock = acquireWorkerLock();
process.once("exit", releaseLock);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    releaseLock();
    process.exit(0);
  });
function cli(args) {
  return JSON.parse(
    execFileSync("sokosumi", ["--preprod", ...args, "--json"], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}
const write = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const paid = await createPaidAdapter({
  target,
  answer,
  save: async (taskId, state) => write(`.local/${taskId}.json`, state),
});
console.log("Continuous worker running", process.pid);
while (true) {
  try {
    const tasks = cli(["tasks", "list", "--coworker-id", id, ...target.taskArgs]).tasks;
    for (const t of tasks.filter((t) => isTaskForTarget(t, target))) {
      try {
        const journal = `.local/${t.id}.json`,
          resultFile = `.local/${t.id}.txt`;
        let state = existsSync(journal) ? JSON.parse(readFileSync(journal, "utf8")) : {};
        if (t.status === "READY" && !state.phase) {
          write(journal, { phase: "starting" });
          const started = cli([
            "runtime",
            "start",
            t.id,
            ...target.runtimeArgs,
            "--coworker-id",
            id,
          ]);
          state = { phase: "started", input: started.description };
          write(journal, state);
        }
        if (state.paid && process.env.PAID_TASKS_ENABLED !== "true") continue;
        // Paid path only for a request we can actually fulfil: nobody pays for "no address found".
        const paidEligible =
          state.phase === "started" &&
          process.env.PAID_TASKS_ENABLED === "true" &&
          isPaidReady() &&
          parseTask(state.input).ok;
        if (state.paid || paidEligible) {
          state = await paid.advance(t, state);
          if (state.phase === "completed") await reply(t);
          continue;
        }
        if (state.phase === "started" || state.phase === "report-pending") {
          write(journal, { ...state, phase: "report-pending" });
          const result = await answer(state.input);
          writeFileSync(resultFile, result, { mode: 0o600 });
          state = { ...state, phase: "result-saved" };
          write(journal, state);
        }
        if (state.phase === "result-saved") {
          write(journal, { ...state, phase: "complete-pending" });
          const completed = cli([
            "runtime",
            "complete",
            t.id,
            ...target.runtimeArgs,
            "--coworker-id",
            id,
            "--result-file",
            resultFile,
          ]);
          state = { ...state, phase: "completed", completion: completed };
          write(journal, state);
          console.log("Completed", t.id);
        }
        if (state.phase === "completed") await reply(t);
      } catch (e) {
        console.error("Task blocked", t.id, String(e.message).slice(0, 200));
      }
    }
  } catch (e) {
    console.error("Polling read failed", String(e.message).slice(0, 200));
  }
  await new Promise((r) => setTimeout(r, 5000));
}
