// Follow-up comments on a completed Task, adapted from the TUM quickstart.
// Change from the template: replies come from report.mjs instead of an Eve model session.
// A comment with an address gets that address's report; "refresh" re-runs the Task's address.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createAnswer, followUp } from "./report.mjs";
import { loadSokosumiRuntime } from "./sokosumi-runtime.mjs";
import { taskTarget, assertTaskTarget, verifyRuntimeTask } from "./task-target.mjs";

const target = taskTarget();
const answer = createAnswer();
const { readRuntimeCredential, createCoworkerHttpClient, fetchTaskEvents, createTaskEvent } =
  await loadSokosumiRuntime();
const runtime = createCoworkerHttpClient({ apiKey: readRuntimeCredential(target.coworkerId) });

export async function reply(task) {
  assertTaskTarget(task, target);
  const taskId = task.id;
  await verifyRuntimeTask(runtime, taskId, target);
  const journal = `.local/${taskId}.json`;
  const original = existsSync(journal)
    ? JSON.parse(readFileSync(journal, "utf8")).input
    : undefined;
  const p = `.local/${taskId}-comments.json`;
  const state = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const save = () => writeFileSync(p, JSON.stringify(state), { mode: 0o600 });
  const { events } = await fetchTaskEvents(runtime, taskId, AbortSignal.timeout(30000));
  for (const event of events.filter(
    (e) => e.actor?.type === "user" && typeof e.comment === "string" && e.comment.trim(),
  )) {
    // A reply already posted, or one whose post outcome is unknown, is never sent again.
    if (state[event.id] === "posted" || state[event.id] === "post-pending") continue;
    state[event.id] = "report-pending";
    save();
    const next = followUp(event.comment.slice(0, 16000), original);
    const message = next.kind === "report" ? await answer(next.input) : next.message;
    state[event.id] = "post-pending";
    save();
    await verifyRuntimeTask(runtime, taskId, target);
    await createTaskEvent(runtime, taskId, { comment: message }, AbortSignal.timeout(30000));
    state[event.id] = "posted";
    save();
  }
}
