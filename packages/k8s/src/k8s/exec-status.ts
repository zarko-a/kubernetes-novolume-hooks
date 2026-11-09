// An exec settles when Kubernetes sends its status frame. If the websocket closes without one
// (the API server or the kubelet dropped the stream), nothing settles it: the hook's promise
// stays pending, the process exits 0 once its event loop drains, and the runner marks a step
// that may still be running as passed. Upstream reported this in
// actions/runner-container-hooks#449; every exec here fails instead (a copy retries).

export interface ClosableSocket {
  readyState: number
  once(event: 'close', listener: () => void): unknown
}

const CLOSED = 3

// Wraps an exec's status callback so the caller can ask whether a status ever arrived.
export function trackStatus<T>(callback: (status: T) => unknown): {
  callback: (status: T) => void
  received: () => boolean
} {
  let received = false
  return {
    callback: status => {
      received = true
      void callback(status)
    },
    received: () => received
  }
}

// Call with the websocket `exec` resolved to. Rejects when the socket closes, or has already
// closed, before the status callback ran. A null socket (a mocked client) is not watched.
export function rejectIfClosedWithoutStatus(
  ws: ClosableSocket | null | undefined,
  statusReceived: () => boolean,
  reject: (reason: Error) => void,
  description: string
): void {
  if (!ws) {
    return
  }
  const check = (): void => {
    if (!statusReceived()) {
      reject(
        new Error(
          `${description}: the exec stream closed before the command reported an exit status`
        )
      )
    }
  }
  if (ws.readyState === CLOSED) {
    check()
    return
  }
  ws.once('close', check)
}
