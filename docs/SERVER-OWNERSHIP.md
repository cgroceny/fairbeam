# Server jobs-directory ownership

`fairbeam serve` and `fairbeam app` acquire an exclusive OS-held lease on the canonical jobs directory before constructing the application or recovering job history. A second server using that same directory fails with `workspace_in_use` without reading or changing job records or invoking orphan recovery. Open additional clients against the existing server instead.

The persistent `.server-owner.lock` file is intentionally kept. Its presence does not mean the server is running: the held OS lock is authoritative, and a close or process crash releases it automatically. Do not delete it to bypass a live owner; doing so can create independent locks. Descriptors are non-inheritable. Windows uses a nonblocking byte-range lock; Linux/macOS use nonblocking flock. Windows contention/crash tests were run; Linux/macOS native execution has not been verified in this change. OS-local lock behavior is not a guarantee for every network filesystem.

The lease lasts through server shutdown and completion of its worker's final job-state writes. HTTP bind/startup failures close the application and retain the lease until its worker stops. A hung worker keeps ownership rather than allowing another writer to start.

Scope is exactly the jobs directory, including canonical path aliases. Two servers with different jobs directories can still share models/projects; this guard does not make that arrangement safe. Direct `App`/`JobManager` construction remains available for tests and embedded callers and does not automatically acquire the CLI server lease. Those callers must not assume exclusive process ownership. No multi-window UI, duplicate-editor protection, queued-source snapshot, or solver change is included.

Older Fairbeam servers do not acquire this lease. The guard cannot identify or protect against such a legacy owner: close the older app before opening its workspace with a version that has this guard. No PID guessing or automatic legacy takeover is performed.
