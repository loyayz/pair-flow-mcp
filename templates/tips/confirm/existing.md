[行动]
调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。若参与者尚未全部就位，它会先等待另一位完成 confirm_task；turn 到你时自动返回。不要频繁调用 get_state

[当前]
你是 {{identity}}（{{responsibility}}）。工作流 {{workflow_id}}，当前是 {{phase}} 阶段第 {{round}} 轮，turn 在 {{turn}}（{{turn_relation}}）。
