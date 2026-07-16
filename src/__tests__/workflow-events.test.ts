import { afterEach, describe, expect, it, vi } from "vitest";
import * as workflowEvents from "../workflow-events.js";
import { defaultState, deleteState, getState, setState } from "../state.js";

const {
  getWorkflowVersion,
  publishWorkflowChange,
  waitForWorkflowChange,
} = workflowEvents;

let sequence = 0;

function workflowId(label: string): string {
  sequence += 1;
  return `workflow-events-${label}-${sequence}`;
}

describe("workflow event coordination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts a new workflow at a stable version", () => {
    const id = workflowId("initial");
    const initialVersion = getWorkflowVersion(id);

    expect(Number.isSafeInteger(initialVersion)).toBe(true);
    expect(getWorkflowVersion(id)).toBe(initialVersion);
  });

  it("reports the current waiter count without changing coordination", async () => {
    expect(workflowEvents).toHaveProperty("getWorkflowWaiterCount");
    const getWorkflowWaiterCount = (
      workflowEvents as typeof workflowEvents & {
        getWorkflowWaiterCount: (workflowId: string) => number;
      }
    ).getWorkflowWaiterCount;
    const id = workflowId("waiter-count");
    const observedVersion = getWorkflowVersion(id);

    expect(getWorkflowWaiterCount(id)).toBe(0);
    const waiter = waitForWorkflowChange(id, observedVersion, new AbortController().signal);
    expect(getWorkflowWaiterCount(id)).toBe(1);

    publishWorkflowChange(id);
    await waiter;
    expect(getWorkflowWaiterCount(id)).toBe(0);
  });

  it("increments the version and resolves every waiter observing an older version", async () => {
    const id = workflowId("publish");
    const observedVersion = getWorkflowVersion(id);
    const first = waitForWorkflowChange(id, observedVersion, new AbortController().signal);
    const second = waitForWorkflowChange(id, observedVersion, new AbortController().signal);

    publishWorkflowChange(id);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { terminated: false, completion: undefined },
      { terminated: false, completion: undefined },
    ]);
    expect(getWorkflowVersion(id)).toBe(observedVersion + 1);
  });

  it("resolves an already stale observation without leaving a waiter registered", async () => {
    const id = workflowId("stale");
    publishWorkflowChange(id);
    const publishedVersion = getWorkflowVersion(id);
    const signal = new AbortController().signal;
    const removeListener = vi.spyOn(signal, "removeEventListener");

    await expect(waitForWorkflowChange(id, 0, signal)).resolves.toEqual({ terminated: false, completion: undefined });
    publishWorkflowChange(id, { terminated: true });

    expect(removeListener).toHaveBeenCalledTimes(0);
    expect(getWorkflowVersion(id)).toBeGreaterThan(publishedVersion);
  });

  it("keeps an observation stale when termination cleanup happens before registration", async () => {
    const id = workflowId("termination-before-registration");
    const observedVersion = getWorkflowVersion(id);
    publishWorkflowChange(id, { terminated: true });
    const addEventListener = vi.fn();
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener,
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    const waiter = waitForWorkflowChange(id, observedVersion, signal);

    expect(addEventListener).not.toHaveBeenCalled();
    await expect(waiter).resolves.toEqual({ terminated: false, completion: undefined });
  });

  it("rechecks after registration so a change published during registration is not missed", async () => {
    const id = workflowId("registration-race");
    const observedVersion = getWorkflowVersion(id);
    let removeCount = 0;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: () => publishWorkflowChange(id),
      removeEventListener: () => {
        removeCount += 1;
      },
    } as unknown as AbortSignal;

    await expect(waitForWorkflowChange(id, observedVersion, signal)).resolves.toEqual({ terminated: false, completion: undefined });

    expect(removeCount).toBe(1);
    expect(getWorkflowVersion(id)).toBe(observedVersion + 1);
  }, 1_000);

  it("rejects an aborted waiter and removes its abort listener exactly once", async () => {
    const id = workflowId("abort");
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waiter = waitForWorkflowChange(id, getWorkflowVersion(id), controller.signal);

    controller.abort();

    await expect(waiter).rejects.toBe(controller.signal.reason);
    publishWorkflowChange(id);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("publishes termination while live state still exists, then deletes the state", async () => {
    const id = workflowId("delete-state");
    setState(id, { ...defaultState(), workflow_id: id });
    const waiter = waitForWorkflowChange(id, getWorkflowVersion(id), new AbortController().signal);
    const realPublish = workflowEvents.publishWorkflowChange;
    const publish = vi.spyOn(workflowEvents, "publishWorkflowChange").mockImplementation((workflowId, options) => {
      expect(getState(workflowId)).toBeDefined();
      realPublish(workflowId, options);
    });

    deleteState(id);

    await expect(waiter).resolves.toEqual({ terminated: true, completion: undefined });
    expect(publish).toHaveBeenCalledWith(id, { terminated: true, completion: undefined });
    expect(getState(id)).toBeUndefined();
  });

  it("retains coordination through ordinary changes and deletes it after terminating the final waiter", async () => {
    const id = workflowId("termination-cleanup");
    const firstVersion = getWorkflowVersion(id);
    const firstWaiter = waitForWorkflowChange(id, firstVersion, new AbortController().signal);

    publishWorkflowChange(id);
    await firstWaiter;
    expect(getWorkflowVersion(id)).toBe(firstVersion + 1);

    const finalVersion = getWorkflowVersion(id);
    const finalWaiter = waitForWorkflowChange(id, finalVersion, new AbortController().signal);
    publishWorkflowChange(id, { terminated: true });
    await finalWaiter;

    const restartedVersion = getWorkflowVersion(id);
    let restartedWaiterResolved = false;
    const restartedWaiter = waitForWorkflowChange(
      id,
      restartedVersion,
      new AbortController().signal,
    ).then(() => {
      restartedWaiterResolved = true;
    });
    await Promise.resolve();
    expect(restartedWaiterResolved).toBe(false);

    publishWorkflowChange(id);
    await restartedWaiter;
  });

  it("does not schedule timers without waiters and preserves a newer version for later callers", async () => {
    vi.useFakeTimers();
    const id = workflowId("no-timers");
    const initialVersion = getWorkflowVersion(id);

    publishWorkflowChange(id);

    expect(vi.getTimerCount()).toBe(0);
    expect(getWorkflowVersion(id)).toBe(initialVersion + 1);
    await expect(waitForWorkflowChange(id, initialVersion, new AbortController().signal)).resolves.toEqual({ terminated: false, completion: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });
});
