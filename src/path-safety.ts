import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export async function findSymbolicLinkInPath(rootPath: string, targetPath: string): Promise<string | null> {
  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = resolve(targetPath);
  const relativePath = relative(resolvedRoot, resolvedTarget);
  if (relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw Object.assign(new Error(`target path is outside root: ${resolvedTarget}`), { code: "EINVAL" });
  }

  const paths = [resolvedRoot];
  let currentPath = resolvedRoot;
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    paths.push(currentPath);
  }

  for (const path of paths) {
    if ((await lstat(path)).isSymbolicLink()) return path;
  }
  return null;
}
