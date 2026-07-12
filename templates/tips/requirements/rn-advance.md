[行动]
作为监督者，若确认目标已达成可直接调用 advance（{{advance_target}}）。否则：基于任务文档 {{task_path}} 和前几轮分析，审阅 {{prev_file}}（对方 commit: {{prev_commit}}）。所有观点需注明提出人。双方同意的确认/补充到任务文档，分歧标注原因和建议

[产出]
完成后 git commit，调用 submit，file_path = {{file_path}}

[当前]
你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。
