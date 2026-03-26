export enum MemoryCommitProgressStage {
  Starting = "starting",
  Chunking = "chunking",
  Spawned = "spawned",
  LoadingResources = "loading_resources",
  CreatingSession = "creating_session",
  Prompting = "prompting",
  Stdout = "stdout",
  TimedOut = "timed_out",
  Finished = "finished",
  Synthesizing = "synthesizing",
  Parsing = "parsing",
  Finalizing = "finalizing",
}

export enum MemoryCommitOperation {
  SinglePass = "single_pass",
  ChunkDistill = "chunk_distill",
  Synthesis = "synthesis",
  ContributionSynthesis = "contribution_synthesis",
}
