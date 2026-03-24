export enum MemoryCommitProgressStage {
  Starting = "starting",
  Spawned = "spawned",
  Stdout = "stdout",
  Stderr = "stderr",
  TimedOut = "timed_out",
  Finished = "finished",
  Parsing = "parsing",
  Finalizing = "finalizing",
}
