[行动]
等待 {{turn}} 完成当前轮次。调用 wait_for_turn（单次最多 600s）；它由 workflow 变化事件或 deadline 返回。不要频繁调用 get_state

[产出]
{{file_path}}（已提交）

[当前]
你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，turn 已切给 {{turn_label}}。
