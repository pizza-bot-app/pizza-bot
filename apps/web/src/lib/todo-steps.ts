import type { TodoStep } from "@pizza-bot/core";

/** A step as edited locally; `key` is the server id, or a client key until the server assigns one. */
export interface StepDraft {
  key: string;
  id?: string;
  title: string;
  completed: boolean;
}

export type StepEdit =
  | { kind: "toggle"; key: string }
  | { kind: "rename"; key: string; title: string }
  | { kind: "remove"; key: string }
  | { kind: "add"; key: string; title: string };

export function stepDrafts(steps: readonly TodoStep[]): StepDraft[] {
  return steps.map((step) => ({ key: step.id, id: step.id, title: step.title, completed: step.completed }));
}

export function applyStepEdit(steps: readonly StepDraft[], edit: StepEdit): StepDraft[] {
  switch (edit.kind) {
    case "toggle":
      return steps.map((step) => (step.key === edit.key ? { ...step, completed: !step.completed } : step));
    case "rename":
      return steps.map((step) => (step.key === edit.key ? { ...step, title: edit.title } : step));
    case "remove":
      return steps.filter((step) => step.key !== edit.key);
    case "add":
      return [...steps, { key: edit.key, title: edit.title, completed: false }];
  }
}

/** The whole-list PATCH body; steps without a server id get one from the server. */
export function stepsPatch(steps: readonly StepDraft[]) {
  return steps.map((step) => ({
    ...(step.id ? { id: step.id } : {}),
    title: step.title,
    completed: step.completed,
  }));
}

export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly pending: number;
}

/** Runs tasks one at a time in call order; a failed task does not stop the ones after it. */
export function serialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      pending++;
      const result = tail.then(async () => {
        try {
          return await task();
        } finally {
          pending--;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
    get pending() {
      return pending;
    },
  };
}
