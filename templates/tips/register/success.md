[行动]
Set X-AI-Identity: {{token}} header on all subsequent requests。
询问用户以下信息后调用 confirm_task({...})。两个 AI 使用相同的 task_path 自动成对，
服务端校验职责组合规则和 work_dir 一致性。

confirm_task 入参：

task_path   — 任务文档绝对路径，不得包含 . 或 .. 路径段。两个 AI 必须传相同规范化路径才能成对。
task_type   — 任务类型。"development"（开发）走完整四阶段流程；
              "requirements"（需求）只做需求分析+汇总，跳过 planning 和 implementation。
is_supervisor — 是否为监督者（true/false）。双方就位后必须恰好一个监督者。
is_developer  — 是否为开发者（true/false）。双方就位后必须恰好一个开发者，可与监督者为同一参与者。
work_dir    — Git 仓库根目录绝对路径，必须含 .git 文件或目录，不得包含 . 或 .. 路径段。两个 AI 必须一致。

职责仅可在第二位参与者加入前的 IDLE 阶段修正；双方就位后冻结。work_dir 从首次确认起固定。重复 confirm_task 不会改写已冻结职责。

[当前]
你是 {{identity}}。已注册，尚未绑定工作流。
