# Tip 模板化 — 代码实现

> 实现人：claude（developer）

## 实现概要

按实施计划的 6 个 Task 完成，全部测试通过（22 files / 217 tests）。

## Commits

| Commit | Task |
|--------|------|
| `f41da45` | Task 1: 添加严格 tip 模板引擎 (`src/tip-template.ts` + 测试) |
| `a106239` | Task 2: 创建 45 个默认模板文件 (`templates/tips/`) |
| `a39ee36` | Tasks 3-5: 迁移所有 tip 调用点到模板引擎 |
| `dc20838` | Task 6: 文档更新 |

## 新增/修改文件

### 新增

| 文件 | 说明 |
|------|------|
| `src/tip-template.ts` | 模板引擎核心：TEMPLATE_SPECS 注册表、init/load/render/parse/validate |
| `src/__tests__/tip-template.test.ts` | 15 个单元测试覆盖加载、校验、渲染、缓存、容错 |
| `templates/tips/` (45 个 `.md` 文件) | 默认模板，覆盖全部 45 个模板键 |
| `templates/tips/README.md` | 模板语法、变量、编辑流程说明 |

### 修改

| 文件 | 变更 |
|------|------|
| `src/index.ts` | `--help` 早退后初始化模板，失败退出 1 |
| `src/response.ts` | `err()` 使用 `renderTip("response.rejected", ...)` |
| `src/tip.ts` | `getAction()` → `selectTip()` 返回模板键+变量；`buildTip()` 使用 `renderTip()` |
| `src/tools/register.ts` | 使用 `renderTip("register.success", ...)` |
| `src/tools/confirm-task.ts` | 4 个场景分支分别使用对应模板键 |
| `src/tools/get-state.ts` | 4 种状态使用独立模板键 |
| `src/tools/wait-for-turn.ts` | 5 种 warn/timeout/completed 场景迁移 |
| `src/tools/advance.ts` | 7 个 advance 分支迁移，删除 `ownProduct()` |
| `src/tools/submit.ts` | `buildSubmissionSuccessTip()` 三分支迁移 |
| `README.md` | 新增"定制 Tip 模板"章节 |

## 设计要点

1. **严格校验**：启动时检查所有模板文件存在、为普通文件、占位符合法、必需变量完备
2. **懒初始化**：`renderTip()` 首次调用时自动加载（兼容不启动 Server 的单元测试）
3. **无逃生变量**：模板持有完整可编辑句子，代码只做模板键选择 + 结构化变量传入
4. **缓存**：模板在首次初始化后缓存到 `Map`，后续请求零文件 IO
5. **兼容性**：全量 217 测试通过，`tsc --noEmit` 无错误

## 自审

- ✅ 所有 tip 入口已迁移（6 工具 + response.ts + tip.ts）
- ✅ 模板是唯一文案来源，无 TypeScript 回退
- ✅ 每个模板键对应 TEMPLATE_SPECS 中的一个条目
- ✅ `formatTip()` 和 `tip-format.ts` 保持不变
- ✅ `docs/design.md` 的 `[行动]/[产出]/[当前]` 格式不变
- ✅ `.pid` / `.meta.json` 未进入 Git 提交
