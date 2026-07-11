interface ClosableTransport {
  close(): Promise<void>;
}

export async function runWithTransportCleanup<T>(
  transport: ClosableTransport,
  operation: () => Promise<T>,
): Promise<T> {
  let operationFailed = false;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await transport.close();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}
