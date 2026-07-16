interface WorkflowWaiter {
  resolve: () => void;
}

interface WorkflowCoordinator {
  version: number;
  terminated: boolean;
  waiters: Set<WorkflowWaiter>;
}

const coordinators = new Map<string, WorkflowCoordinator>();
let versionClock = 0;

function getCoordinator(workflowId: string): WorkflowCoordinator {
  let coordinator = coordinators.get(workflowId);
  if (!coordinator) {
    coordinator = { version: versionClock, terminated: false, waiters: new Set() };
    coordinators.set(workflowId, coordinator);
  }
  return coordinator;
}

function deleteTerminatedCoordinatorIfReleased(
  workflowId: string,
  coordinator: WorkflowCoordinator,
): void {
  if (coordinator.terminated && coordinator.waiters.size === 0) {
    coordinators.delete(workflowId);
  }
}

export function getWorkflowVersion(workflowId: string): number {
  return getCoordinator(workflowId).version;
}

export function getWorkflowWaiterCount(workflowId: string): number {
  return coordinators.get(workflowId)?.waiters.size ?? 0;
}

export function waitForWorkflowChange(
  workflowId: string,
  observedVersion: number,
  signal: AbortSignal,
): Promise<void> {
  const coordinator = getCoordinator(workflowId);
  if (coordinator.terminated || coordinator.version !== observedVersion) {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let waiter: WorkflowWaiter;

    const cleanup = (): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      coordinator.waiters.delete(waiter);
      deleteTerminatedCoordinatorIfReleased(workflowId, coordinator);
      return true;
    };
    const settleResolved = (): void => {
      if (cleanup()) resolve();
    };
    const onAbort = (): void => {
      if (cleanup()) {
        reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
      }
    };

    waiter = { resolve: settleResolved };
    coordinator.waiters.add(waiter);
    signal.addEventListener("abort", onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
    } else if (coordinator.terminated || coordinator.version !== observedVersion) {
      settleResolved();
    }
  });
}

export function publishWorkflowChange(
  workflowId: string,
  options?: { terminated?: boolean },
): void {
  const coordinator = getCoordinator(workflowId);
  coordinator.version += 1;
  versionClock += 1;
  if (options?.terminated) coordinator.terminated = true;

  for (const waiter of [...coordinator.waiters]) waiter.resolve();
  deleteTerminatedCoordinatorIfReleased(workflowId, coordinator);
}
