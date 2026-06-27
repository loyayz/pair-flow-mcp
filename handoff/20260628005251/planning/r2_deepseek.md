# 优化 tip 描述 — 计划审阅

> 审阅人: deepseek (developer)
> 轮次: r2，审阅 r1_claude
> 阶段: planning

---

## 总体评价

计划完整覆盖需求文档所有条目，三要素模板（你 + turn + 行动）简洁有效。全部同意，无分歧。

---

## 逐项确认

| 编号 | 项目 | 意见 |
|------|------|------|
| 1 | confirm_dir 分支 tip | ✅ 同意。限制 5 个 + 选项 A/B 的格式清晰 |
| 2 | confirm_task 先确认 + 身份边界 | ✅ 同意。恢复场景 turn 判断覆盖了三种情况 |
| 3 | 所有 tip 加身份边界 | ✅ 同意。表格中的模板覆盖了全部 8 个工具 |
| 4 | register tip 参数提示 | ✅ 同意 |
| 5 | confirm_task 恢复时 turn 判断 | ✅ 同意 |
| 6 | incomplete_workflows 附带 task_path | ✅ 同意。返回结构改为 `[{id, task_path}]` 合理 |

---

## 补充建议

### 实施细节

**提出人: deepseek**

1. **tip 模板存储**：建议将各工具 tip 模板集中到一个常量文件（如 `src/tips.ts`），避免散落在各工具函数中难以统一维护和测试。

2. **wait_for_turn 超时场景**：当前 `wait_for_turn` 超时返回 error，计划中只提到了 warning 场景。超时返回也应包含身份边界 tip：
   ```
   等待超时(600s)。当前身份: {identity}，turn 仍在 {turn}(对方)。
   若为监督者可调用 advance 跳过当前轮次。
   ```

3. **submit 的 tip 分角色**：计划中的 submit tip 用了 `{身份判断: 监督者→等待审阅/非监督者→等待对方产出}`，建议实现时直接根据当前 identity 的 `role` 和 `is_developer` 字段做 if-else，而非在模板中留占位判断。

---

## 结论

计划可直接进入实施阶段。建议监督者 advance 到 implementation。
