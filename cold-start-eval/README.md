# PairFlow Instruction Cold-Start Evaluation

Follow this workflow exactly:

1. Copy the entire cold-start-eval directory outside the PairFlow repository.
2. Ensure the target PairFlow Server is running and Node >=24.0.0 is active.
3. Run node scripts/instruction.ts.
4. Read only the instruction-eval-input.md path printed by this execution.
5. Create instruction-eval-report.md beside that input using the required report format.

The evaluator must not read scripts/instruction.ts, must not read PairFlow source, must not read repository documents, must not read Skills, must not read history or other runs, and must not use prior PairFlow knowledge. The generated input printed by the current execution is the evaluator's complete context.

Each execution creates a new `runs/<run-id>/` with an independent PairFlow task and input. Existing runs are preserved. The script collects evidence but does not score the evaluation and does not create the report. After the evaluator writes the report beside the current input, the user supplies its path to Codex for interpretation.

The default PairFlow Server URL is `http://127.0.0.1:35690`. To use another server, run `node scripts/instruction.ts --base-url <url>`.
