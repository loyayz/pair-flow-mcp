[行动]
作为监督者，若确认目标已达成可直接调用 advance（{{advance_target}}）。否则：基于上一轮审阅意见修订汇总文档 {{prev_file}}（对方 commit: {{prev_commit}}）

[产出]
完成后 git commit，调用 submit，file_path = {{file_path}}

[当前]
你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。
