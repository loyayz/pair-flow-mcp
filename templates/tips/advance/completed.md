[行动]
如需开始新任务，在服务未重启且 token 仍可用时可复用当前 token；双方分别调用 confirm_task，并使用相同 task_path。服务重启或 token 丢失时先重新 register。

[产出]
已完成工作流的全部产出归档于 {{archive_root}}/

[当前]
你是 {{identity}}（supervisor）。工作流已结束。
