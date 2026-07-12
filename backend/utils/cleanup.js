const fs = require("fs");
const path = require("path");

function scheduleCleanup({
  jobs,
  tmpDir,
  jobTtlMs = 30 * 60 * 1000, // 30 min after a job is done/errored
  fileTtlMs = 60 * 60 * 1000, // 1 hour for any leftover file on disk
  intervalMs = 10 * 60 * 1000, // run every 10 min
}) {
  const timer = setInterval(() => {
    const now = Date.now();

    for (const [id, job] of jobs) {
      const finishedAt = job.finishedAt || job.createdAt || 0;
      const isFinished = job.status === "done" || job.status === "error";
      if (isFinished && now - finishedAt > jobTtlMs) {
        if (job.outputPath) fs.unlink(job.outputPath, () => {});
        if (job.inputPath) fs.unlink(job.inputPath, () => {});
        jobs.delete(id);
      }
    }

    fs.readdir(tmpDir, (err, files) => {
      if (err) return;
      for (const file of files) {
        const filePath = path.join(tmpDir, file);
        fs.stat(filePath, (statErr, stat) => {
          if (statErr || !stat.isFile()) return;
          if (now - stat.mtimeMs > fileTtlMs) fs.unlink(filePath, () => {});
        });
      }
    });
  }, intervalMs);

  timer.unref();
  return timer;
}

module.exports = { scheduleCleanup };
