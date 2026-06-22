import { Mutex } from "async-mutex";

/** 全局状态变更 mutex——所有修改 state 的操作必须获取此锁。 */
export const stateMutex = new Mutex();
